// Paired prompt-variant benchmark against a local OpenAI-compatible server (a vLLM instance on a rented GPU, reached
// through an SSH tunnel at 127.0.0.1). Every arm is an environment directory put first on PYTHONPATH for the env lane's
// calibrate.py, so arms differ only in the environment code they import; all arms run the same (family, difficulty, seed)
// cells, which is what makes the comparison paired. Resumable (a finished cell file is skipped), stoppable (a STOP file or a
// wall-clock cap), and it aborts after repeated failures.
//
//   node eval/paired/paired-bench.mjs CONFIG.json          (uses VLLM_BASE_URL unless the config sets baseUrl)
//
// Config keys: outDir, python, calibrate, arms {name: envDir}, families[], difficulties[], blocks, seedBase, seedStep,
// split (heldout | select | train: refuses seeds outside that range, see splits.mjs), repeats (re-sample the same instances), baseUrl, model, workers, maxWallS, maxSteps, maxTokens, maxTotalTokens, thinking,
// abortAfterFailures.
// Only loopback base URLs are accepted: the placeholder API key "EMPTY" must never be sent to a real provider.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSeedsIn, configSeeds } from './splits.mjs';

export const DEFAULTS = Object.freeze({
  difficulties: [1, 2, 3], blocks: 12, repeats: 1, seedBase: 900000, seedStep: 4, model: 'qwen38', workers: 48, maxWallS: 9000,
  maxSteps: 8, maxTokens: 2048, maxTotalTokens: 100000, thinking: 'off', abortAfterFailures: 10,
});
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}(\/|$)/;

export function validateConfig(raw, env = process.env) {
  const c = { ...DEFAULTS, ...raw, baseUrl: raw.baseUrl ?? env.VLLM_BASE_URL };
  if (!c.outDir || !path.isAbsolute(c.outDir)) throw new Error('config: outDir must be an absolute path');
  if (!c.calibrate || !existsSync(c.calibrate)) throw new Error('config: calibrate must point at calibrate.py');
  if (!c.arms || !Object.keys(c.arms).length) throw new Error('config: arms must map names to environment directories');
  for (const [n, d] of Object.entries(c.arms)) if (!/^[A-Za-z0-9_-]{1,16}$/.test(n) || !existsSync(d)) throw new Error(`config: arm ${n} invalid or missing directory`);
  if (!Array.isArray(c.families) || !c.families.length) throw new Error('config: families must be a non-empty array');
  if (typeof c.baseUrl !== 'string' || !LOOPBACK.test(c.baseUrl)) throw new Error('config: baseUrl must be a loopback http URL (the local vLLM tunnel)');
  for (const k of ['blocks', 'repeats', 'seedBase', 'seedStep', 'workers', 'maxWallS', 'maxSteps', 'maxTokens', 'maxTotalTokens', 'abortAfterFailures']) {
    if (!Number.isFinite(c[k]) || c[k] <= 0) throw new Error(`config: ${k} must be a positive number`);
  }
  if (!['on', 'off'].includes(c.thinking)) throw new Error('config: thinking must be on or off');
  // Optional guard: declare the role of this run (heldout | select | train) and every instance seed must lie in that range.
  if (c.split !== undefined) assertSeedsIn(c.split, configSeeds(c));
  return c;
}

/** Job order is block-major so that a run stopped early still holds complete paired blocks. */
export function buildJobs(c) {
  const jobs = [];
  for (let b = 0; b < c.blocks; b += 1) {
    for (const fam of c.families) for (const d of c.difficulties) for (const arm of Object.keys(c.arms)) {
      // repeats > 1 re-samples the SAME instances (same seed) in separate files, so within-instance outcome spread can be measured.
      for (let rep = 0; rep < c.repeats; rep += 1) jobs.push({ arm, fam, d, seed: c.seedBase + c.seedStep * b, rep });
    }
  }
  return jobs;
}

export const outFile = (c, j) => path.join(c.outDir, j.arm, `${j.fam}_d${j.d}_s${j.seed}${j.rep ? `_r${j.rep}` : ''}.jsonl`);

export function calibrateArgs(c, j, out) {
  return [c.calibrate, '--base-url', c.baseUrl, '--model', c.model, '--model-revision', 'unknown', '--task-id', j.fam,
    '--difficulty', String(j.d), '--max-steps', String(c.maxSteps), '--max-tokens', String(c.maxTokens),
    '--max-total-tokens', String(c.maxTotalTokens), '--seed', String(j.seed), '--thinking', c.thinking, '--output', out, '--execute'];
}

function failureCounts(file) {
  let n = 0, fail = 0;
  try {
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      if (r.type !== 'episode') continue;
      n += 1;
      if (r.failure === 'provider_request_failed' || r.trajectory?.failure === 'provider_request_failed') fail += 1;
    }
  } catch { /* unreadable output counts as no episodes */ }
  return { n, fail };
}

/** A cell file counts as finished only if it holds episodes and none of them failed at the provider (a failed attempt is re-run). */
export function isFinished(file) {
  if (!existsSync(file)) return false;
  const { n, fail } = failureCounts(file);
  return n > 0 && fail === 0;
}

/** Run every job through a bounded worker pool. `spawnFn` is injectable for tests. -> summary */
export async function runBench(raw, { spawnFn = spawn, now = Date.now, log } = {}) {
  const c = validateConfig(raw);
  mkdirSync(c.outDir, { recursive: true });
  const ledger = path.join(c.outDir, 'ledger.jsonl');
  const write = log ?? ((e) => appendFileSync(ledger, `${JSON.stringify({ ...e, t: now() / 1000 })}\n`));
  const jobs = buildJobs(c), t0 = now();
  let next = 0, ran = 0, skipped = 0, consecutive = 0, stop = false, stopReason = null;
  const halt = (why) => { if (!stop) { stop = true; stopReason = why; } };

  const one = async (j) => {
    const out = outFile(c, j);
    if (isFinished(out)) { skipped += 1; return; }
    if (existsSync(out)) unlinkSync(out); // stale output of a failed attempt: calibrate must not append to it
    if (existsSync(path.join(c.outDir, 'STOP'))) return halt('stop-file');
    if ((now() - t0) / 1000 > c.maxWallS) return halt('wall-clock');
    mkdirSync(path.dirname(out), { recursive: true });
    const started = now();
    const code = await new Promise((resolve) => {
      const p = spawnFn(c.python ?? 'python3', calibrateArgs(c, j, out), { env: { ...process.env, ARENA_MODEL_API_KEY: 'EMPTY', PYTHONPATH: c.arms[j.arm] }, stdio: 'ignore' });
      p.on('error', () => resolve(-1));
      p.on('exit', (x) => resolve(x ?? -1));
    });
    const { n, fail } = failureCounts(out);
    ran += 1;
    consecutive = code !== 0 || (n > 0 && fail === n) ? consecutive + 1 : 0;
    write({ event: 'call', arm: j.arm, fam: j.fam, d: j.d, seed: j.seed, rc: code, eps: n, fail, secs: Math.round((now() - started) / 100) / 10 });
    if (consecutive >= c.abortAfterFailures) halt('repeated-failures');
  };
  const worker = async () => { while (!stop) { const i = next; next += 1; if (i >= jobs.length) return; await one(jobs[i]); } };
  await Promise.all(Array.from({ length: Math.min(c.workers, jobs.length) }, worker));
  const summary = { event: 'done', jobs: jobs.length, ran, skipped, wallS: Math.round((now() - t0) / 100) / 10, stoppedEarly: stop, stopReason };
  write(summary);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv[2]) { console.error('usage: paired-bench.mjs CONFIG.json'); process.exit(2); }
  const summary = await runBench(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(summary));
  process.exit(summary.stoppedEarly && summary.stopReason === 'repeated-failures' ? 1 : 0);
}
