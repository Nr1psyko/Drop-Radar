const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { checkpoint, intervalStatus, main } = require('../scripts/radar-health.cjs');
const scanner = fs.readFileSync(path.join(__dirname, '../radar.js'), 'utf8');

test('normal cadence, grace boundary and observed 5.5-hour gap', () => {
  const previous = '2026-10-20T00:14:08.270Z';
  assert.equal(intervalStatus(previous, '2026-10-20T01:14:08.270Z').overdue, false);
  assert.equal(intervalStatus(previous, '2026-10-20T01:44:08.270Z').overdue, false);
  assert.equal(intervalStatus(previous, '2026-10-20T01:44:09.270Z').overdue, true);
  assert.deepEqual(intervalStatus(previous, '2026-10-20T05:50:35.000Z'), {
    seconds_since_previous_success: 20186, overdue: true, estimated_missed_intervals: 4,
  });
});

test('missing, invalid and future timestamps do not invent a gap', () => {
  for (const previous of [null, 'bad', '2026-10-21T00:00:00Z']) {
    assert.deepEqual(intervalStatus(previous, '2026-10-20T00:00:00Z'), {
      seconds_since_previous_success: null, overdue: null, estimated_missed_intervals: null,
    });
  }
});

test('legacy checkpoint migration preserves IDs and rejects damaged deduplication state', () => {
  const state = { updated: '2026-10-20T00:14:08Z', seen: ['gh:example/tool'] };
  const before = JSON.stringify(state);
  assert.equal(checkpoint(state, null).previous_checkpoint_source, 'legacy state.updated');
  assert.equal(checkpoint(state, {last_successful_execution_at: '2026-10-20T01:17:00Z'}).previous_successful_execution_at, '2026-10-20T01:17:00.000Z');
  assert.equal(JSON.stringify(state), before);
  for (const invalid of [null, {}, {seen: 'bad'}, {seen: [null]}]) {
    assert.throws(() => checkpoint(invalid, null), /Invalid state.json/);
  }
});

test('start does not advance success; success requires a fresh state and leaves seen intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-health-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const env = {RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md')};
    assert.throws(() => main('start', env), /ENOENT/);
    const state = {updated: '2026-10-20T00:14:08Z', seen: ['gh:example/tool']};
    fs.writeFileSync('state.json', JSON.stringify(state));
    main('start', env, '2026-10-20T05:50:35Z');
    assert.equal(fs.existsSync('radar-health.json'), false);
    assert.throws(() => main('success', env, '2026-10-20T05:50:37Z'), /fresh state/);
    state.updated = '2026-10-20T05:50:36Z';
    const stateBytes = JSON.stringify(state);
    fs.writeFileSync('state.json', stateBytes);
    main('success', env, '2026-10-20T05:50:37Z');
    const health = JSON.parse(fs.readFileSync('radar-health.json'));
    assert.equal(health.last_successful_execution_at, '2026-10-20T05:50:37Z');
    assert.equal(health.estimated_missed_intervals, 4);
    assert.equal(fs.readFileSync('state.json', 'utf8'), stateBytes);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// Execute the unchanged real scanner against isolated in-memory storage and API
// fixtures. No network requests or real notifications can leave this harness.
async function scan(state, candidates, failPush = false) {
  let saved = JSON.stringify(state);
  const notifications = [];
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => saved,
    writeFileSync: (_file, bytes) => { saved = bytes; },
  };
  const fetch = async (url, options) => {
    if (url === 'https://api.pushover.net/1/messages.json') {
      notifications.push(Object.fromEntries(options.body));
      return {ok: !failPush, status: failPush ? 500 : 200, text: async () => 'fixture failure'};
    }
    if (url.startsWith('https://huggingface.co/api/models?')) return {ok: true, json: async () => []};
    if (url.startsWith('https://api.github.com/search/repositories?')) return {ok: true, json: async () => ({items: candidates})};
    throw new Error('Unexpected network endpoint: ' + url);
  };
  await vm.runInNewContext(scanner, {
    require: name => { assert.equal(name, 'node:fs'); return fakeFs; },
    process: {env: {PUSHOVER_TOKEN: 'fixture', PUSHOVER_USER: 'fixture'}},
    console: {log: () => {}}, fetch, URLSearchParams,
  });
  return {state: JSON.parse(saved), notifications};
}

const candidate = i => ({
  full_name: `fixture/tool-${i}`, html_url: `https://example.invalid/${i}`,
  pushed_at: new Date().toISOString(), stargazers_count: 100,
  language: 'Python', topics: ['comfyui'], license: {spdx_id: 'MIT'}, description: 'API demo',
});

test('repeated runs with the latest persisted state send no duplicate notifications', async () => {
  const initial = {seen: ['gh:already/known']};
  const first = await scan(initial, [candidate(1)]);
  assert.equal(first.notifications.length, 1);
  assert.equal(first.notifications[0].title, '🛰 fixture/tool-1 · 100');
  assert.deepEqual(first.state.seen, ['gh:already/known', 'gh:fixture/tool-1']);
  const second = await scan(first.state, [candidate(1)]);
  assert.equal(second.notifications.length, 0);
});

test('four individual alerts plus overflow stay deduplicated on a subsequent run', async () => {
  const items = Array.from({length: 6}, (_, i) => candidate(i));
  const first = await scan({seen: []}, items);
  assert.equal(first.notifications.length, 5);
  assert.match(first.notifications[4].title, /\+2 more/);
  assert.equal(first.state.seen.length, 6);
  assert.equal((await scan(first.state, items)).notifications.length, 0);
});

test('failed notifications retain existing retry semantics', async () => {
  const failed = await scan({seen: ['gh:already/known']}, [candidate(1)], true);
  assert.deepEqual(failed.state.seen, ['gh:already/known']);
  const recovered = await scan(failed.state, [candidate(1)]);
  assert.equal(recovered.notifications.length, 1);
  assert.equal((await scan(recovered.state, [candidate(1)])).notifications.length, 0);
});
