import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MODEL_REVISION, POLL_COMMAND, REMOTE, detachedTrainCommand, gpuConfig, remoteCommand, runTraining, scpBase, validateJob } from '../train-vast.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'train-'));
function job(dir, extra = {}) {
  mkdirSync(path.join(dir, 'env', 'arena_env'), { recursive: true });
  writeFileSync(path.join(dir, 'grpo_arena.py'), '# stub\n');
  return { outDir: path.join(dir, 'out'), envDir: path.join(dir, 'env'), script: path.join(dir, 'grpo_arena.py'), args: ['--steps', '2'], ...extra };
}

test('gpu config is a shell-only rental with the owner caps', () => {
  const g = gpuConfig();
  assert.deepEqual([g.serve, g.onstartCmd, g.totalCapUsd <= 230, g.minGpuRamMb >= 78000], [false, 'sleep infinity', true, true]);
  assert.equal(gpuConfig({ maxGpuHours: 5 }).maxGpuHours, 5);
});

test('job validation', () => {
  const d = tmp(), j = job(d);
  assert.equal(validateJob(j).runTimeoutMin, 120);
  assert.throws(() => validateJob({ ...j, outDir: 'rel' }), /outDir/);
  assert.throws(() => validateJob({ ...j, script: '/nope/x.py' }), /script/);
  assert.throws(() => validateJob({ ...j, envDir: d }), /arena_env/);
  assert.throws(() => validateJob({ ...j, args: ['ok', 'bad\nline'] }), /single-line/);
  assert.throws(() => validateJob({ ...j, hfHome: '/x; touch /tmp/injected' }), /hfHome/);
  assert.throws(() => validateJob({ ...j, runTimeoutMin: 0 }), /runTimeoutMin/);
  rmSync(d, { recursive: true });
});

test('remote command pins the arena model revision and quotes every argument', () => {
  const d = tmp(), c = validateJob(job(d, { args: ['--families', "a'b", '--steps', '3'] }));
  const cmd = remoteCommand(c);
  assert.ok(cmd.includes(`'--revision' '${MODEL_REVISION}'`));
  assert.ok(cmd.includes(`'--model' 'Qwen/Qwen3.8-27B'`) && cmd.includes(`'--env-dir' '${REMOTE}/env'`));
  assert.ok(cmd.includes(`'a'\\''b'`), 'a quote inside an argument is escaped');
  assert.ok(!/--no-template-check/.test(cmd), 'the template check stays on for the 27B');
  assert.deepEqual(scpBase({ port: 22, keyPath: '/k', knownHostsFile: '/h' }).slice(0, 3), ['-F', 'none', '-q']);
  rmSync(d, { recursive: true });
});

const fakeGpu = (calls, { confirmed = true } = {}) => async ({ config }) => {
  calls.config = config;
  return { baseUrl: null, ssh: { host: '203.0.113.5', port: 40022, keyPath: '/k', knownHostsFile: '/h' }, teardown: async () => { calls.torn = (calls.torn ?? 0) + 1; return { confirmed }; } };
};

test('runTraining runs the steps in order, downloads results and tears down', async () => {
  const d = tmp(), steps = [], calls = {};
  const exec = async (cmd, args) => { steps.push(`${cmd}:${args.at(-1)}`); return cmd === 'ssh' && args.at(-1) === POLL_COMMAND ? 100 : 0; };
  const r = await runTraining(job(d), 't1', { provision: fakeGpu(calls), exec, stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(calls.torn, 1);
  assert.equal(calls.config.serve, false);
  assert.ok(steps[0].startsWith('ssh:mkdir -p'), steps.join('\n'));
  assert.ok(steps.some((s) => s.startsWith('scp:root@203.0.113.5:/root/work/grpo_arena.py')));
  assert.ok(steps.some((s) => s.startsWith('scp:root@203.0.113.5:/root/work/env/')));
  assert.ok(steps.at(-1).startsWith('scp:'), 'results are downloaded last, before teardown');
  const iSetup = steps.findIndex((s) => s.includes('pip install')), iRun = steps.findIndex((s) => s.startsWith('ssh:') && s.includes('grpo_arena.py'));
  assert.ok(iSetup > 0 && iRun > iSetup, 'setup precedes the run');
  rmSync(d, { recursive: true });
});

test('a failed step still downloads the log and tears the instance down', async () => {
  const d = tmp(), steps = [], calls = {};
  const exec = async (cmd, args) => { const s = args.at(-1); steps.push(`${cmd}:${s}`); return cmd === 'ssh' && s.includes('pip install') ? 3 : 0; };
  await assert.rejects(runTraining(job(d), 't2', { provision: fakeGpu(calls), exec, stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 }), /setup failed with exit code 3/);
  assert.equal(calls.torn, 1);
  assert.ok(steps.at(-1).startsWith('scp:'), 'partial output is still fetched');
  assert.ok(!steps.some((s) => s.startsWith('ssh:') && s.includes('grpo_arena.py')), 'the job is not run after a failed setup');
  rmSync(d, { recursive: true });
});

test('provisioning failure never reaches ssh, and an unconfirmed teardown is reported', async () => {
  const d = tmp(), steps = [];
  await assert.rejects(runTraining(job(d), 't3', { provision: async () => { throw new Error('no offer'); }, exec: async () => { steps.push('x'); return 0; }, stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 }), /no offer/);
  assert.equal(steps.length, 0);
  const calls = {};
  await assert.rejects(runTraining(job(d), 't4', { provision: fakeGpu(calls, { confirmed: false }), exec: async (cmd, args) => (cmd === 'ssh' && args.at(-1) === POLL_COMMAND ? 100 : 0), stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 }), /teardown not confirmed/);
  rmSync(d, { recursive: true });
});

test('the training runs detached and the launch is idempotent', () => {
  const d = tmp(), c = validateJob(job(d));
  const cmd = detachedTrainCommand(c);
  assert.ok(cmd.startsWith(`mkdir ${REMOTE}/launch.lock 2>/dev/null && {`), 'a retried launch finds the lock and does nothing');
  assert.ok(cmd.includes('setsid nohup') && cmd.includes(`echo $? > ${REMOTE}/DONE`));
  assert.ok(cmd.includes('--revision') && cmd.includes(MODEL_REVISION), 'the pinned revision is inside the detached command');
  rmSync(d, { recursive: true });
});

test('transient ssh failures (exit 255) are retried, other failures are not', async () => {
  const d = tmp(), calls = { n: 0 }, steps = [];
  const exec = async (cmd, args) => {
    const s = args.at(-1); steps.push(`${cmd}:${s}`);
    if (cmd === 'ssh' && s.startsWith('mkdir -p') && calls.n++ < 2) return 255;
    return cmd === 'ssh' && s === POLL_COMMAND ? 100 : 0;
  };
  const r = await runTraining(job(d), 'r1', { provision: fakeGpu({}), exec, stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(steps.filter((s) => s.startsWith('ssh:mkdir -p')).length, 3, 'two timeouts then success');
  const d2 = tmp(), calls2 = {};
  const bad = async (cmd, args) => (cmd === 'ssh' && args.at(-1).startsWith('mkdir -p') ? 1 : 0);
  await assert.rejects(runTraining(job(d2), 'r2', { provision: fakeGpu(calls2), exec: bad, stateDir: path.join(d2, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0 }), /mkdir failed with exit code 1/);
  assert.equal(calls2.torn, 1);
  rmSync(d, { recursive: true }); rmSync(d2, { recursive: true });
});

test('polling tolerates dropped polls, reports the remote exit code and gives up when contact is lost', async () => {
  const d = tmp(), polls = { n: 0 };
  const flaky = async (cmd, args) => {
    if (cmd === 'ssh' && args.at(-1) === POLL_COMMAND) { polls.n += 1; return polls.n === 1 ? 0 : polls.n <= 3 ? 255 : 100; }
    return 0;
  };
  const opts = (calls, exec) => ({ provision: fakeGpu(calls), exec, stateDir: path.join(d, 'state'), journal: () => {}, sleep: async () => {}, retryWaitMs: 0, pollMs: 0, maxPollFailures: 5 });
  assert.equal((await runTraining(job(d), 'p1', opts({}, flaky))).ok, true);
  const failing = async (cmd, args) => (cmd === 'ssh' && args.at(-1) === POLL_COMMAND ? 101 : 0);
  await assert.rejects(runTraining(job(d), 'p2', opts({}, failing)), /train failed with exit code 1/);
  const calls = {};
  const dead = async (cmd, args) => (cmd === 'ssh' && args.at(-1) === POLL_COMMAND ? 255 : 0);
  await assert.rejects(runTraining(job(d), 'p3', opts(calls, dead)), /lost contact with the instance/);
  assert.equal(calls.torn, 1, 'the instance is still torn down');
  rmSync(d, { recursive: true });
});
