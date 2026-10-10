import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { analyze, render } from '../paired-analyze.mjs';
import { buildJobs, calibrateArgs, runBench, validateConfig } from '../paired-bench.mjs';
import { benchWallSeconds, gpuConfig, runOnVast } from '../paired-vast.mjs';
import { badReplyCount, cellTable, compareArms, flagged, isConformingAction, loadArm, pairedBootstrap, parseCellFile, rng } from '../lib.mjs';
import { arenaToDarwin, parseAction, scanDirs, scanTrajectory } from '../trajectory-scan.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'paired-'));
const act = (o) => JSON.stringify(o);
const READ = act({ op: 'read', path: '*' });
const SUBMIT = act({ op: 'submit', answer: {} });

// A one-episode cell file in the shape calibrate.py writes.
function writeCell(dir, arm, cell, seed, { reward = 0, solved = false, replies = [READ, SUBMIT], failure = null } = {}) {
  mkdirSync(path.join(dir, arm), { recursive: true });
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }];
  for (const r of replies) messages.push({ role: 'assistant', content: r }, { role: 'user', content: 'obs' });
  const ep = { type: 'episode', task_id: cell, seed, reward, solved, failure, trajectory: { messages, failure } };
  writeFileSync(path.join(dir, arm, `${cell}_s${seed}.jsonl`), `${JSON.stringify(ep)}\n`);
}

test('strict action parsing', () => {
  assert.equal(isConformingAction(READ), true);
  assert.equal(isConformingAction(`  ${SUBMIT}\n`), true);
  assert.equal(isConformingAction(`Sure! ${READ}`), false, 'prose before the JSON is not conforming');
  assert.equal(isConformingAction('[{"op":"read"}]'), false);
  assert.equal(isConformingAction('{"op":"shell"}'), false);
  assert.equal(isConformingAction(''), false);
  assert.equal(badReplyCount([{ role: 'assistant', content: READ }, { role: 'assistant', content: 'oops' }, { role: 'user', content: 'x' }]), 1);
});

test('cell file names', () => {
  assert.deepEqual(parseCellFile('finance_ledger_d2_s900012.jsonl'), { cell: 'finance_ledger_d2', fileSeed: 900012 });
  assert.equal(parseCellFile('notes.txt'), null);
});

test('bootstrap is deterministic, signed and honest about no effect', () => {
  const diffs = [0.5, 0.4, 0.6, 0.5, 0.45, 0.55, 0.5, 0.52];
  const a = pairedBootstrap(diffs, { seed: 7 }), b = pairedBootstrap(diffs, { seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.lo > 0 && a.hi > a.lo && a.mean > 0.4);
  const flat = pairedBootstrap([0, 0, 0, 0]);
  assert.deepEqual([flat.mean, flat.lo, flat.hi], [0, 0, 0]);
  const noise = pairedBootstrap([0.2, -0.2, 0.1, -0.1, 0.3, -0.3, 0, 0]);
  assert.ok(noise.lo < 0 && noise.hi > 0, 'a symmetric spread must straddle zero');
  assert.equal(pairedBootstrap([]).n, 0);
  const r = rng(1); assert.ok(r() >= 0 && r() < 1);
});

test('compareArms recovers a known effect and pairs only identical (cell, seed)', () => {
  const dir = tmp();
  for (let s = 0; s < 12; s += 1) {
    writeCell(dir, 'V0', 'office_d2', 100 + s, { reward: 0.1, replies: ['prose', SUBMIT], failure: 'invalid_json_action' });
    writeCell(dir, 'V1', 'office_d2', 100 + s, { reward: 0.6, solved: s % 3 === 0 });
    writeCell(dir, 'V0', 'media_d1', 100 + s, { reward: 0.2 });
    writeCell(dir, 'V1', 'media_d1', 100 + s, { reward: 0.2 });
  }
  writeCell(dir, 'V1', 'office_d2', 999, { reward: 1 }); // no V0 partner: must not be paired
  const v0 = loadArm(path.join(dir, 'V0')), v1 = loadArm(path.join(dir, 'V1'));
  const c = compareArms(v0, v1, { resamples: 500 });
  assert.equal(c.pairs, 24);
  assert.ok(Math.abs(c.cells.office_d2.reward.mean - 0.5) < 1e-9 && flagged(c.cells.office_d2.reward));
  assert.equal(c.cells.media_d1.reward.mean, 0);
  assert.equal(flagged(c.cells.media_d1.reward), false);
  const t = cellTable(v1);
  assert.equal(t.office_d2.n, 13); assert.equal(t.media_d1.badRate, 0);
  assert.equal(v0.get('office_d2#100').bad, true);
  const res = analyze(dir, { cells: 'V1' });
  assert.equal(res.summary.paired, 24);
  assert.match(render(res), /office_d2/);
  rmSync(dir, { recursive: true });
});

const baseCfg = (dir) => ({ outDir: path.join(dir, 'out'), calibrate: process.execPath, arms: { V0: dir, V1: dir }, families: ['a', 'b'], difficulties: [1, 2], blocks: 3, baseUrl: 'http://127.0.0.1:8123/v1', workers: 4 });

test('config validation refuses non-loopback servers and bad shapes', () => {
  const dir = tmp(), c = baseCfg(dir);
  assert.equal(validateConfig(c).model, 'qwen38');
  assert.throws(() => validateConfig({ ...c, baseUrl: 'https://router.huggingface.co/v1' }), /loopback/);
  assert.throws(() => validateConfig({ ...c, baseUrl: undefined }, {}), /loopback/);
  assert.throws(() => validateConfig({ ...c, arms: {} }), /arms/);
  assert.throws(() => validateConfig({ ...c, arms: { 'bad name': dir } }), /arm/);
  assert.throws(() => validateConfig({ ...c, blocks: 0 }), /blocks/);
  assert.throws(() => validateConfig({ ...c, thinking: 'maybe' }), /thinking/);
  assert.throws(() => validateConfig({ ...c, outDir: 'relative' }), /outDir/);
  rmSync(dir, { recursive: true });
});

test('jobs are block-major and cover every arm for every cell', () => {
  const dir = tmp(), c = validateConfig(baseCfg(dir)), jobs = buildJobs(c);
  assert.equal(jobs.length, 3 * 2 * 2 * 2);
  assert.ok(jobs.slice(0, 8).every((j) => j.seed === c.seedBase), 'the first block is complete before the second starts');
  assert.equal(new Set(jobs.map((j) => `${j.fam}${j.d}${j.seed}`)).size * 2, jobs.length);
  const args = calibrateArgs(c, jobs[0], '/o.jsonl');
  assert.deepEqual([args.includes('--execute'), args[args.indexOf('--thinking') + 1], args[args.indexOf('--base-url') + 1]], [true, 'off', 'http://127.0.0.1:8123/v1']);
  rmSync(dir, { recursive: true });
});

// Fake child process: writes the cell file the real calibrate.py would, then exits with `code`.
const fakeSpawn = (log, { code = 0, failures = false } = {}) => (cmd, args, opts) => {
  const out = args[args.indexOf('--output') + 1], p = new EventEmitter();
  log.push({ arm: Object.keys(opts.env).includes('PYTHONPATH') ? opts.env.PYTHONPATH : '', key: opts.env.ARENA_MODEL_API_KEY });
  mkdirSync(path.dirname(out), { recursive: true });
  const f = failures ? 'provider_request_failed' : null;
  writeFileSync(out, `${JSON.stringify({ type: 'episode', seed: 1, reward: 0, solved: false, failure: f, trajectory: { messages: [], failure: f } })}\n`);
  setImmediate(() => p.emit('exit', code));
  return p;
};

test('runBench runs every job once, is resumable and sends only the placeholder key', async () => {
  const dir = tmp(), cfg = baseCfg(dir), log = [], events = [];
  const first = await runBench(cfg, { spawnFn: fakeSpawn(log), log: (e) => events.push(e) });
  assert.deepEqual([first.jobs, first.ran, first.skipped, first.stoppedEarly], [24, 24, 0, false]);
  assert.ok(log.every((l) => l.key === 'EMPTY'));
  const again = await runBench(cfg, { spawnFn: fakeSpawn(log), log: (e) => events.push(e) });
  assert.deepEqual([again.ran, again.skipped], [0, 24], 'finished cells are skipped');
  rmSync(dir, { recursive: true });
});

test('runBench stops on a STOP file, on repeated failures and on the wall-clock cap', async () => {
  let dir = tmp();
  mkdirSync(path.join(dir, 'out'), { recursive: true });
  writeFileSync(path.join(dir, 'out', 'STOP'), '');
  let s = await runBench(baseCfg(dir), { spawnFn: fakeSpawn([]), log: () => {} });
  assert.deepEqual([s.ran, s.stopReason], [0, 'stop-file']);
  rmSync(dir, { recursive: true });

  dir = tmp();
  s = await runBench({ ...baseCfg(dir), workers: 1, abortAfterFailures: 3 }, { spawnFn: fakeSpawn([], { failures: true }), log: () => {} });
  assert.deepEqual([s.stopReason, s.ran], ['repeated-failures', 3]);
  rmSync(dir, { recursive: true });

  dir = tmp();
  let t = 0;
  s = await runBench({ ...baseCfg(dir), workers: 1, maxWallS: 5 }, { spawnFn: fakeSpawn([]), now: () => (t += 4000), log: () => {} });
  assert.equal(s.stopReason, 'wall-clock');
  rmSync(dir, { recursive: true });
});

test('runOnVast tears the GPU down on success and on failure, and clamps the benchmark window', async () => {
  const dir = tmp(), cfg = { ...baseCfg(dir), gpu: { maxGpuHours: 2 } };
  const make = (calls) => async ({ config }) => { calls.config = config; return { baseUrl: 'http://127.0.0.1:9999/v1', dphTotal: 1, plannedUsd: 4, teardown: async () => { calls.torn = (calls.torn ?? 0) + 1; return { confirmed: true }; } }; };
  let calls = {};
  const ok = await runOnVast(cfg, 'r1', { provision: make(calls), bench: async (c) => ({ seen: c }), stateDir: path.join(dir, 'state'), journal: () => {} });
  assert.equal(calls.torn, 1);
  assert.equal(ok.seen.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(ok.seen.maxWallS, benchWallSeconds(calls.config), 'the benchmark may not outlast the rental window');
  assert.ok(calls.config.totalCapUsd <= 250 && calls.config.maxGpuHours === 2);

  calls = {};
  await assert.rejects(runOnVast(cfg, 'r2', { provision: make(calls), bench: async () => { throw new Error('boom'); }, stateDir: path.join(dir, 'state'), journal: () => {} }), /boom/);
  assert.equal(calls.torn, 1, 'teardown runs even when the benchmark throws');

  await assert.rejects(runOnVast(cfg, 'r3', { provision: async () => { throw new Error('no offer'); }, bench: async () => ({}), stateDir: path.join(dir, 'state'), journal: () => {} }), /no offer/);
  assert.equal(gpuConfig().maxGpuHours, 4);
  rmSync(dir, { recursive: true });
});

// ── trajectory scanner ──────────────────────────────────────────────────────
const traj = (replies, obs = 'obs') => ({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }, ...replies.flatMap((r) => [{ role: 'assistant', content: r }, { role: 'user', content: obs }])] });

test('arena actions become tool calls the monitor understands', () => {
  const d = arenaToDarwin(traj([READ, SUBMIT]));
  const calls = d.messages.filter((m) => m.tool_calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool_calls[0].function.name, 'read_file');
  assert.equal(d.messages.filter((m) => m.role === 'tool').length, 2, 'each observation becomes the tool response');
  assert.deepEqual(parseAction('nonsense'), { ok: false });
  assert.equal(arenaToDarwin(traj(['prose only'])).messages.filter((m) => m.tool_calls).length, 0);
});

test('scanner: clean trajectories are clean AND the monitor demonstrably looks (positive controls)', () => {
  assert.deepEqual(scanTrajectory(traj([READ, SUBMIT])), []);
  const goldPath = scanTrajectory(traj([act({ op: 'read', path: 'gold_patch.diff' }), SUBMIT]));
  assert.ok(goldPath.some((f) => f.kind === 'gold-read'), 'reading a gold path must be flagged');
  const leakResp = scanTrajectory(traj([READ, SUBMIT], 'files: {"FAIL_TO_PASS": ["t"]}'));
  assert.ok(leakResp.some((f) => f.kind === 'gold-read'), 'an oracle marker in an observation must be flagged');
  const escape = scanTrajectory(traj([act({ op: 'read', path: '/etc/passwd' }), SUBMIT]));
  assert.ok(escape.some((f) => f.kind === 'sandbox-escape'), 'a path outside the sandbox must be flagged');
  // Without the adapter the monitor sees nothing: this is the vacuous result the adapter exists to avoid.
  const direct = traj([act({ op: 'read', path: 'gold_patch.diff' })]);
  assert.equal(direct.messages.some((m) => m.tool_calls), false);
});

test('scanDirs counts the actions it inspected and reports flagged episodes', () => {
  const dir = tmp();
  writeCell(dir, 'V0', 'office_d1', 1, { replies: [READ, SUBMIT] });
  writeCell(dir, 'V0', 'office_d1', 2, { replies: [act({ op: 'read', path: 'expected_output.json' }), SUBMIT] });
  const res = scanDirs([dir]);
  assert.deepEqual([res.files, res.episodes, res.actionsInspected, res.flaggedEpisodes], [2, 2, 4, 1]);
  assert.equal(res.flagged[0].seed, 2);
  rmSync(dir, { recursive: true });
});

// Golden check against a real benchmark directory (set PAIRED_GOLDEN_DIR); skipped when absent.
test('golden: reproduces the reply-format result on the archived benchmark', { skip: !process.env.PAIRED_GOLDEN_DIR || !existsSync(process.env.PAIRED_GOLDEN_DIR) }, () => {
  const res = analyze(process.env.PAIRED_GOLDEN_DIR, { compare: ['V1:V0', 'V2:V1', 'V3:V1'] });
  const p = res.comparisons['V1-V0'].pooled;
  assert.ok(Math.abs(p.reward.mean - 0.165) < 0.002, `pooled dReward ${p.reward.mean}`);
  assert.ok(p.reward.lo > 0.14 && p.reward.hi < 0.19);
  assert.ok(Math.abs(p.solved.mean - 0.022) < 0.002);
  for (const k of ['V2-V1', 'V3-V1']) assert.ok(res.comparisons[k].pooled.reward.lo < 0 && res.comparisons[k].pooled.reward.hi > 0, `${k} must show no reward effect`);
  assert.ok(res.summary.arms.V0.badRate > 0.7 && res.summary.arms.V1.badRate < 0.01);
});
