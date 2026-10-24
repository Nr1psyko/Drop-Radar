// Execution telemetry only. Discovery, scoring and notification IDs live in radar.js.
const fs = require('node:fs');
const path = require('node:path');

const INTERVAL_SECONDS = 3600;
const OVERDUE_SECONDS = 5400; // Allow 30 minutes of scheduling jitter.
const HEALTH_FILE = 'radar-health.json';

function checkpoint(state, health) {
  // Refuse silent first-run reseeding if the existing production state is lost.
  if (!state || !Array.isArray(state.seen) || state.seen.some(id => typeof id !== 'string')) {
    throw new Error('Invalid state.json: restore saved deduplication state before scanning');
  }
  const value = health?.last_successful_execution_at ?? state.updated;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return {
    previous_successful_execution_at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    previous_checkpoint_source: health?.last_successful_execution_at ? HEALTH_FILE : 'legacy state.updated',
  };
}

function intervalStatus(previous, now) {
  const age = previous ? (Date.parse(now) - Date.parse(previous)) / 1000 : NaN;
  const known = Number.isFinite(age) && age >= 0;
  return {
    seconds_since_previous_success: known ? Math.floor(age) : null,
    overdue: known ? age > OVERDUE_SECONDS : null,
    // Elapsed intervals, NOT a count of scheduler events proven to have been dropped.
    estimated_missed_intervals: known ? Math.max(0, Math.floor(age / INTERVAL_SECONDS) - 1) : null,
  };
}

function summary(text, env) {
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text + '\n');
}

function main(command, env = process.env, now = new Date().toISOString()) {
  const contextFile = path.join(env.RUNNER_TEMP || '.', 'radar-execution.json');
  if (command === 'start') {
    const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    const health = fs.existsSync(HEALTH_FILE) ? JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) : null;
    const previous = checkpoint(state, health);
    const interval = intervalStatus(previous.previous_successful_execution_at, now);
    const context = {
      schema_version: 1,
      last_run_started_at: now,
      ...previous,
      ...interval,
      expected_interval_seconds: INTERVAL_SECONDS,
      overdue_threshold_seconds: OVERDUE_SECONDS,
      event: env.GITHUB_EVENT_NAME || 'local',
      run_id: env.GITHUB_RUN_ID || null,
      run_attempt: env.GITHUB_RUN_ATTEMPT || null,
      run_url: env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
        ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    };
    fs.writeFileSync(contextFile, JSON.stringify(context, null, 2) + '\n');
    if (interval.overdue) {
      console.log(`::warning title=Drop Radar overdue::${interval.seconds_since_previous_success}s since the previous saved execution; ${interval.estimated_missed_intervals} estimated missed hourly intervals.`);
    } else if (interval.overdue === null) {
      console.log('::warning title=Drop Radar checkpoint unknown::No valid past execution timestamp; no interval estimate available.');
    }
    summary(`### Drop Radar execution\n\nStarted (UTC): ${now}\n\nPrevious saved execution: ${previous.previous_successful_execution_at || 'unknown'} (${previous.previous_checkpoint_source})\n\nGap: ${interval.seconds_since_previous_success ?? 'unknown'} seconds; estimated missed intervals: ${interval.estimated_missed_intervals ?? 'unknown'}.`, env);
  } else if (command === 'success') {
    const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
    const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    checkpoint(state, null);
    if (!Number.isFinite(Date.parse(state.updated)) || Date.parse(state.updated) < Date.parse(context.last_run_started_at)) {
      throw new Error('Scanner did not write a fresh state.json; refusing a success checkpoint');
    }
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ ...context, last_successful_execution_at: now }, null, 2) + '\n');
    summary(`\nScan process completed (UTC): ${now}. This checkpoint becomes durable only when Persist state succeeds. Success means radar.js exited successfully and wrote state; caught source/Pushover errors are still reported in its log.`, env);
  } else {
    throw new Error('Usage: node scripts/radar-health.cjs start|success');
  }
}

if (require.main === module) main(process.argv[2]);
module.exports = { checkpoint, intervalStatus, main };
