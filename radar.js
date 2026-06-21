// radar.js — Drop Radar push backend
// Scans HuggingFace + GitHub for fresh gen-media drops, scores them on
// 24h-wrap-ability, and pushes ship-ready ones (score >= MIN_SCORE) to Pushover.
// Zero npm dependencies. Node 18+ (uses global fetch). Runs on GitHub Actions.

const { readFileSync, writeFileSync, existsSync } = require("node:fs");

/* ============ tunables — edit these to taste ============ */
const MIN_SCORE  = 70;   // only push drops at/above this wrap score
const MAX_PUSH   = 4;    // max individual pushes per run; extras get one summary
const FRESH_DAYS = 50;   // GitHub "active since" window
const KEEP_SEEN  = 600;  // cap on remembered IDs
const STATE_FILE = "state.json";

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER  = process.env.PUSHOVER_USER;
const GH_TOKEN       = process.env.GITHUB_TOKEN; // optional, raises GH rate limit

/* ============ what to watch ============ */
const TODAY = new Date();
const since = new Date(TODAY - FRESH_DAYS * 864e5).toISOString().slice(0, 10);

const MODALITIES = [
  // --- your edge: audio / music (your actual trade + your audience) ---
  { group: "music", hf: ["text-to-audio", "audio-to-audio"], gh: ["music-generation", "audio-generation"] },
  { group: "voice", hf: ["text-to-speech"],                  gh: ["text-to-speech", "voice-cloning"] },
  // --- visual media ---
  { group: "image",    hf: ["text-to-image", "image-to-image"], gh: ["image-generation"] },
  { group: "video",    hf: ["text-to-video", "image-to-video"], gh: ["text-to-video"] },
  { group: "img-edit", hf: [],                                  gh: ["image-editing", "background-removal", "super-resolution"] },
  { group: "vid-edit", hf: [],                                  gh: ["video-editing", "video-to-video", "video-inpainting"] },
  { group: "3d",       hf: ["text-to-3d", "image-to-3d"],        gh: ["3d-generation", "avatar", "lip-sync"] },
  { group: "4d",       hf: [],                                  gh: ["world-model", "4d-generation", "gaussian-splatting", "neural-rendering"] },

  // --- extra lanes: delete a "//" to widen further (these run noisier) ---
  // { group: "llm",    hf: ["text-generation"],              gh: ["llm", "ai-agent"] },
  // { group: "speech", hf: ["automatic-speech-recognition"], gh: ["transcription"] },
  // { group: "docs",   hf: ["image-text-to-text"],           gh: ["ocr", "document-ai"] },
  // { group: "trans",  hf: ["translation"],                  gh: ["machine-translation"] },
];
const GH_EXTRA = [{ topic: "comfyui", group: "image" }]; // ComfyUI nodes = most wrappable

const WATCHED = new Set([
  // image / video labs — fresh drops surface even with zero likes yet
  "black-forest-labs","stabilityai","stability-ai","tencent","tencent-hunyuan","hunyuanvideo-community",
  "bytedance","bytedance-seed","lightricks","genmo","rhymes-ai","qwen","alibaba-pai","wan-ai","wan-video",
  "hpcai-tech","thudm","zai-org","kwai-kolors","shakker-labs","fal","fal-ai","nvidia","playgroundai",
  "segmind","ostris","deepmind","google",
  // audio / music / voice labs
  "facebook","fishaudio","fish-audio","coqui","microsoft","outeai","hexgrad","canopylabs","sparkaudio",
  "amphion","kyutai","parler-tts","whisperspeech","metavoiceio","myshell-ai","nari-labs","mrfakename",
  "ace-step","m-a-p","declare-lab","suno-ai","descriptinc",
  // 3d / avatar labs
  "ashawkey","vast-ai","tencent-hunyuan3d","openai",
  // 4d / world / spatial labs
  "inspatio","worldlabs","skywork","decart-ai","tencent-hunyuanworld",
  // llm / agent labs — only matter if you uncomment the "llm" lane above
  "meta-llama","mistralai","deepseek-ai","allenai","cohereforai","nousresearch","ibm-granite","huggingfacetb",
]);

/* ============ license = the money gate ============ */
function licenseInfo(raw) {
  const l = (raw || "").toLowerCase().replace(/^license:/, "").trim();
  if (!l || l === "unknown" || l === "other" || l === "noassertion")
    return { tier: "unknown", label: "License unclear — check it" };
  if (/^(apache|mit|bsd|isc|cc0|cc-by-4|cc-by-3|unlicense|zlib|artistic|wtfpl)/.test(l) || l === "cc-by-sa-4.0")
    return { tier: "safe", label: `${l.toUpperCase()} — safe to sell` };
  if (/^(agpl|gpl)/.test(l))
    return { tier: "caution", label: `${l.toUpperCase()} — SaaS must be open-sourced` };
  if (/^(lgpl|mpl|epl)/.test(l))
    return { tier: "caution", label: `${l.toUpperCase()} — weak copyleft, check terms` };
  if (/nc|noncommercial|non-commercial|research/.test(l))
    return { tier: "restricted", label: `${l.toUpperCase()} — no commercial use` };
  if (/openrail|rail/.test(l))
    return { tier: "caution", label: "OpenRAIL — commercial OK, use limits apply" };
  if (/llama|gemma|qwen|community|proprietary|custom/.test(l))
    return { tier: "caution", label: "Custom license — check MAU / commercial limits" };
  return { tier: "unknown", label: `${l} — check terms` };
}

/* ============ fetchers ============ */
async function fetchHF(tag, group) {
  const url = `https://huggingface.co/api/models?pipeline_tag=${tag}&sort=createdAt&direction=-1&limit=40&full=true`;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "drop-radar" } });
  if (!r.ok) throw new Error("hf " + r.status);
  const arr = await r.json();
  return arr.map(m => {
    const tags = m.tags || [];
    const licTag = tags.find(t => /^license:/.test(t)) || m.license || "";
    const org = (m.id || "").split("/")[0].toLowerCase();
    return {
      source: "hf", group, org, name: m.id, url: `https://huggingface.co/${m.id}`,
      created: m.createdAt || m.created_at || null,
      likes: m.likes || 0, downloads: m.downloads || 0, stars: null,
      lib: m.library_name || null, lang: null,
      gated: !!m.gated && m.gated !== "false",
      license: licenseInfo(licTag),
      watched: WATCHED.has(org),
    };
  });
}

async function fetchGH(topic, group) {
  const q = encodeURIComponent(`topic:${topic} pushed:>${since}`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "drop-radar" };
  if (GH_TOKEN) headers.Authorization = "Bearer " + GH_TOKEN;
  const r = await fetch(url, { headers });
  if (r.status === 403) throw new Error("gh-rate");
  if (!r.ok) throw new Error("gh " + r.status);
  const d = await r.json();
  return (d.items || []).map(repo => {
    const org = (repo.full_name || "").split("/")[0].toLowerCase();
    return {
      source: "gh", group, org, name: repo.full_name, url: repo.html_url,
      created: repo.pushed_at,
      likes: null, downloads: null, stars: repo.stargazers_count || 0,
      lib: null, lang: repo.language || null, gated: false,
      topics: repo.topics || [],
      license: licenseInfo((repo.license || {}).spdx_id || ""),
      desc: repo.description || "",
      watched: WATCHED.has(org),
    };
  });
}

/* ============ scoring ============ */
function ageDays(iso) { return iso ? (TODAY - new Date(iso)) / 864e5 : 999; }

function score(it) {
  let s = 0; const reasons = [];
  const L = it.license;
  if (L.tier === "safe") { s += 45; reasons.push(L.label); }
  else if (L.tier === "caution") { s += 26; reasons.push(L.label); }
  else if (L.tier === "unknown") { s += 20; reasons.push(L.label); }
  else { s += 5; reasons.push(L.label); }

  if (it.source === "hf") {
    if (it.lib === "diffusers") { s += 20; reasons.push("diffusers — runs in a few lines"); }
    else if (it.lib === "transformers") { s += 16; reasons.push("transformers — well documented"); }
    else if (it.lib) s += 8;
  } else {
    if ((it.topics || []).includes("comfyui")) { s += 22; reasons.push("ComfyUI node — drop into your pipeline"); }
    if (["Python", "TypeScript", "JavaScript", "Jupyter Notebook"].includes(it.lang)) s += 14;
    const blob = ((it.desc || "") + " " + (it.topics || []).join(" ")).toLowerCase();
    if (/\b(api|gradio|demo|webui|fastapi|endpoint)\b/.test(blob)) { s += 10; reasons.push("Has an API / demo already"); }
  }

  const heat = (it.downloads || 0) / 30 + (it.likes || 0) * 4 + (it.stars || 0) * 1.4;
  s += Math.min(20, Math.log10(1 + heat) * 9);
  const heatN = it.stars || it.likes || 0;
  if (heatN >= 20) reasons.push(`Gaining traction — ${heatN} ${it.stars != null ? "stars" : "likes"}`);

  if (it.watched) { s += 15; reasons.push(`From ${it.org} — watched lab`); }
  if (it.gated) { s -= 15; reasons.push("Gated — needs access approval"); }
  if (ageDays(it.created) < 3) reasons.push("Dropped in the last 72h");

  it.score = Math.max(0, Math.min(100, Math.round(s)));
  it.heat = heat; it.reasons = reasons;
  return it;
}

/* ============ helpers ============ */
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : "" + n; }
function ageLabel(iso) {
  const d = ageDays(iso);
  if (d < 1) return "today"; if (d < 2) return "1d ago";
  if (d < 30) return Math.round(d) + "d ago"; return Math.round(d / 30) + "mo ago";
}

/* ============ pushover ============ */
async function push({ title, message, url, url_title, priority = 0 }) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) throw new Error("missing Pushover secrets");
  const body = new URLSearchParams({
    token: PUSHOVER_TOKEN, user: PUSHOVER_USER,
    title: title.slice(0, 250), message: message.slice(0, 1024),
  });
  if (url) { body.set("url", url.slice(0, 512)); body.set("url_title", (url_title || "Open").slice(0, 100)); }
  if (priority) body.set("priority", String(priority));
  const r = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) throw new Error("pushover " + r.status + " " + (await r.text()));
  return true;
}

/* ============ state ============ */
function saveState(seenSet) {
  let arr = [...seenSet];
  if (arr.length > KEEP_SEEN) arr = arr.slice(arr.length - KEEP_SEEN);
  writeFileSync(STATE_FILE, JSON.stringify({ updated: new Date().toISOString(), seen: arr }));
  console.log("state saved,", arr.length, "ids");
}

/* ============ main ============ */
(async () => {
  let seen = [], firstRun = true;
  if (existsSync(STATE_FILE)) {
    try { seen = (JSON.parse(readFileSync(STATE_FILE, "utf8")).seen) || []; firstRun = false; }
    catch (e) { console.log("state.json unreadable — treating as first run"); }
  }
  const seenSet = new Set(seen);

  const jobs = [];
  for (const m of MODALITIES) {
    m.hf.forEach(t => jobs.push(fetchHF(t, m.group)));
    m.gh.forEach(t => jobs.push(fetchGH(t, m.group)));
  }
  GH_EXTRA.forEach(g => jobs.push(fetchGH(g.topic, g.group)));

  const res = await Promise.allSettled(jobs);
  let items = [];
  for (const r of res) {
    if (r.status === "fulfilled") items = items.concat(r.value);
    else console.log("source failed:", r.reason && r.reason.message);
  }

  // dedupe + filter + score
  const dseen = new Set();
  items = items.filter(it => { const k = it.source + ":" + it.name; if (dseen.has(k)) return false; dseen.add(k); return true; });
  items = items.filter(it => it.source !== "hf" ? true : (it.watched || it.likes >= 2 || it.downloads >= 80));
  items = items.filter(it => ageDays(it.created) <= 160);
  items.forEach(score);

  const candidates = items
    .filter(it => it.score >= MIN_SCORE)
    .filter(it => !seenSet.has(it.source + ":" + it.name))
    .sort((a, b) => b.score - a.score);

  console.log(`scanned ${items.length} items, ${candidates.length} new ship-ready (>=${MIN_SCORE})`);

  // first run: seed silently, send one confirmation, no flood
  if (firstRun) {
    items.forEach(it => seenSet.add(it.source + ":" + it.name));
    try {
      await push({
        title: "✅ Drop Radar is live",
        message: `Watching HuggingFace + GitHub for ship-ready gen-media drops (score ≥ ${MIN_SCORE}). I'll ping you when one lands.\nTracking ${items.length} on radar right now.`,
      });
      console.log("sent live-confirmation push");
    } catch (e) { console.log("confirmation push failed:", e.message); }
    saveState(seenSet);
    return;
  }

  // push new candidates
  const pushed = [];
  for (const it of candidates.slice(0, MAX_PUSH)) {
    const lic = it.license.label;
    const reason = it.reasons.find(t => t !== lic && /runs|node|API|traction|72h|documented|demo/.test(t))
                 || it.reasons.find(t => t !== lic) || "";
    const stats = it.source === "hf"
      ? `${fmt(it.downloads)} dl · ${fmt(it.likes)} likes · ${ageLabel(it.created)}`
      : `${fmt(it.stars)} ★ · ${it.lang || "?"} · updated ${ageLabel(it.created)}`;
    try {
      await push({
        title: `🛰 ${it.name} · ${it.score}`,
        message: `${it.group.toUpperCase()} · ${lic}\n${reason}\n${stats}`,
        url: it.url,
        url_title: it.source === "hf" ? "Open on HuggingFace" : "Open on GitHub",
        priority: it.score >= 88 ? 1 : 0,
      });
      pushed.push(it.source + ":" + it.name);
      console.log("pushed:", it.name, it.score);
    } catch (e) { console.log("push failed for", it.name, e.message); }
  }

  // overflow summary
  const overflow = candidates.slice(MAX_PUSH);
  if (overflow.length) {
    try {
      await push({
        title: `🛰 +${overflow.length} more ship-ready drops`,
        message: overflow.slice(0, 8).map(it => `• ${it.name} (${it.score})`).join("\n") + "\n\nOpen the Drop Radar to see all.",
      });
      overflow.forEach(it => pushed.push(it.source + ":" + it.name));
      console.log("pushed overflow summary:", overflow.length);
    } catch (e) { console.log("overflow push failed:", e.message); }
  }

  pushed.forEach(k => seenSet.add(k));
  saveState(seenSet);
})();
