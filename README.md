# Drop-Radar

Watches selected public GitHub topics and Hugging Face model categories for
generative-media tools and sends qualifying discoveries through Pushover. It
does not scan your computer, personal files or the entire web.

The production scan is scheduled hourly at **:17 UTC**. GitHub scheduling is
best effort; delays and skipped triggers remain possible. Manual production
runs must use `main`. Feature-branch runs skip the scan to avoid duplicate alerts.

`radar-health.json` is created by the first successful production scan after
merging this change. It stores the last successful scanner-process completion,
run URL, previous checkpoint and elapsed-interval estimate. It is committed
atomically with `state.json`. The Actions summary warns when the previous saved
execution is more than 90 minutes old. This check runs only when the next scan
starts; it is not an independent outage alarm.

"Successful" retains the scanner's existing meaning: the process exited zero
and wrote fresh state. Source or Pushover errors caught by `radar.js` can still
occur; inspect the scan log. The health file is not proof of complete source
coverage or notification delivery. The first checkpoint uses `state.updated`
as an explicitly labelled legacy baseline.

Production uses one concurrency group and checks out the latest `main` after
acquiring it. This keeps queued/repeated runs on the latest deduplication state.
Missing or malformed state stops the scan instead of silently reseeding it.
Discovery, score threshold 70, four individual pushes plus overflow, and the
600-ID retention limit remain unchanged.

If persistence fails, inspect the failed run before restarting it. A seven-day
`radar-recovery-<run>-<attempt>` artifact preserves the state as it was before
Git reconciliation. Compare it with current `main`; never blindly replace newer
state or clear `seen`. Pushover delivery and a Git commit are not one transaction:
a crash between them can still produce repeat alerts. This patch does not claim
exactly-once delivery and does not automatically replay scans.

Run offline checks with `node --test test/*.test.cjs`. Tests use mocked network
and storage: no Pushover credentials, real notifications or production-state
changes. The PR check runs them on Node 20.

See [the investigation and configuration comparison](docs/reliability-2026-10-20.md).
