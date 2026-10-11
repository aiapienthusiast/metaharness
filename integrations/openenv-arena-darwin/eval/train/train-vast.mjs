// Run a training job on a rented Vast GPU over ssh: provision a shell (flywheel/gpu.mjs with serve:false, so the same
// worst-case ledger, label watchdog and confirmed destroy apply), upload the job, set up its environment, run it with the
// output streamed to a local log, download the results, and always tear the instance down.
//
//   node eval/train/train-vast.mjs CONFIG.json RUN_ID
//
// CONFIG keys: outDir (absolute, local), envDir (the directory that holds the arena_env package), script (local path of
// grpo_arena.py), gpu (overrides for the flywheel GPU config), setup (shell, optional), args (grpo_arena.py arguments),
// runTimeoutMin, hfHome (remote cache dir). The job gets no credentials: the model and tokenizer are public.
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionGpu } from '../../flywheel/gpu.mjs';
import { runSsh, sshCommandArgs } from '../../flywheel/gpu-tunnel.mjs';

export const REMOTE = '/root/work';
export const MODEL_REVISION = '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0'; // Qwen/Qwen3.8-27B, the arena's pinned revision
export const DEFAULT_SETUP = [
  'set -e',
  'python3 -m venv --system-site-packages /root/venv',
  '/root/venv/bin/pip install -q trl peft accelerate datasets flash-linear-attention openenv-core',
  '/root/venv/bin/python -c "import torch,transformers,trl,peft;print(torch.__version__,transformers.__version__,trl.__version__,peft.__version__)"',
].join(' && ');

/** GPU config for a training rental: a shell only (no model server), one 80 GB+ card, the owner's caps. */
export function gpuConfig(cfg = {}) {
  return { serve: false, onstartCmd: 'sleep infinity', maxDphUsd: 3.0, maxGpuHours: 3, graceHours: 0.25, dailyCapUsd: 25, totalCapUsd: 250,
    minGpuRamMb: 78000, diskGb: 200, ...cfg };
}

/** Validate the job config; returns it with defaults. */
export function validateJob(raw) {
  const c = { runTimeoutMin: 120, hfHome: '/root/hf', setup: DEFAULT_SETUP, args: [], ...raw };
  if (!c.outDir || !path.isAbsolute(c.outDir)) throw new Error('job: outDir must be an absolute path');
  for (const k of ['envDir', 'script']) if (!c[k] || !existsSync(c[k])) throw new Error(`job: ${k} must exist`);
  if (!existsSync(path.join(c.envDir, 'arena_env'))) throw new Error('job: envDir must contain the arena_env package');
  if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string' || /[\r\n\0]/.test(a))) throw new Error('job: args must be single-line strings');
  if (!Number.isFinite(c.runTimeoutMin) || c.runTimeoutMin <= 0) throw new Error('job: runTimeoutMin must be a positive number');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(c.hfHome)) throw new Error('job: hfHome must be a plain absolute path');
  return c;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The remote training command: pinned model revision, the arena environment on the path, output under REMOTE/out. */
export function remoteCommand(c) {
  const args = ['--env-dir', `${REMOTE}/env`, '--model', 'Qwen/Qwen3.8-27B', '--revision', MODEL_REVISION, '--out', `${REMOTE}/out`, ...c.args];
  return `cd ${REMOTE} && HF_HOME=${c.hfHome} TRL_EXPERIMENTAL_SILENCE=1 TOKENIZERS_PARALLELISM=false PYTORCH_ALLOC_CONF=expandable_segments:True /root/venv/bin/python grpo_arena.py ${args.map(q).join(' ')}`;
}

/** Start the training detached on the instance, so a dropped ssh session cannot kill a long run. Idempotent: a retried
 * launch finds the lock directory and does nothing. The exit code of the run lands in REMOTE/DONE. */
export function detachedTrainCommand(c) {
  const inner = `${remoteCommand(c)}; echo $? > ${REMOTE}/DONE`;
  return `mkdir ${REMOTE}/launch.lock 2>/dev/null && { rm -f ${REMOTE}/DONE; setsid nohup bash -c ${q(inner)} > ${REMOTE}/train.log 2>&1 < /dev/null & } ; true`;
}

/** One poll of the detached run: exit 0 while it runs (printing its last log line), 100 + exit code once it has finished. */
export const POLL_COMMAND = `if [ -f ${REMOTE}/DONE ]; then c=$(cat ${REMOTE}/DONE); tail -n 3 ${REMOTE}/train.log; exit $((100 + c % 100)); else tail -n 1 ${REMOTE}/train.log 2>/dev/null; exit 0; fi`;

/** scp options matching the ssh ones (key only, no config files, per-run known_hosts). */
export function scpBase({ port, keyPath, knownHostsFile }) {
  return ['-F', 'none', '-q', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-i', keyPath,
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHostsFile}`, '-P', String(port)];
}

function run(cmd, args, { logFile, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const out = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    const p = spawn(cmd, args, { stdio: ['ignore', out ? 'pipe' : 'ignore', out ? 'pipe' : 'ignore'] });
    if (out) { p.stdout.pipe(out, { end: false }); p.stderr.pipe(out, { end: false }); }
    const timer = timeoutMs ? setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs) : null;
    p.on('error', () => { clearTimeout(timer); out?.end(); resolve(-1); });
    p.on('exit', (code) => { clearTimeout(timer); out?.end(); resolve(code ?? -1); });
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTraining(raw, runId, { provision = provisionGpu, exec = run, ssh = runSsh,
  stateDir = path.join(os.homedir(), '.local/state/arena-flywheel'), journal, sleep = sleepMs, retryWaitMs = 20_000, pollMs = 120_000,
  maxPollFailures = 20, retries = 6 } = {}) {
  const c = validateJob(raw);
  mkdirSync(c.outDir, { recursive: true });
  const jr = journal ?? ((e) => appendFileSync(path.join(c.outDir, 'journal.jsonl'), `${JSON.stringify(e)}\n`));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = path.join(c.outDir, 'run.log');
  let gpu = null, error = null, result = null;
  try {
    gpu = await provision({ runId, config: gpuConfig(c.gpu), stateDir, journal: jr });
    const { host, port, keyPath, knownHostsFile } = gpu.ssh;
    const sshArgs = (command) => sshCommandArgs({ host, port, keyPath, knownHostsFile, command });
    // ssh and scp exit 255 when they cannot connect. Every command retried here is idempotent (mkdir -p, a copy, pip install, a locked launch).
    const step = async (name, command, timeoutMs) => {
      for (let attempt = 1; ; attempt += 1) {
        jr({ phase: `train.${name}.start`, attempt });
        const code = await exec('ssh', sshArgs(command), { logFile: log, timeoutMs });
        jr({ phase: `train.${name}.exit`, code });
        if (code === 0) return;
        if (code === 255 && attempt < retries) { await sleep(retryWaitMs); continue; }
        throw new Error(`${name} failed with exit code ${code} (see run.log)`);
      }
    };
    await step('mkdir', `mkdir -p ${REMOTE}/env ${REMOTE}/out`, 120_000);
    for (const [src, dst] of [[c.script, `${REMOTE}/grpo_arena.py`], [path.join(c.envDir, 'arena_env'), `${REMOTE}/env/`]]) {
      for (let attempt = 1; ; attempt += 1) {
        const code = await exec('scp', [...scpBase({ port, keyPath, knownHostsFile }), ...(isDir(src) ? ['-r'] : []), src, `root@${host}:${dst}`], { logFile: log, timeoutMs: 300_000 });
        jr({ phase: 'train.upload', src: path.basename(src), code, attempt });
        if (code === 0) break;
        if (code === 255 && attempt < retries) { await sleep(retryWaitMs); continue; }
        throw new Error(`upload of ${path.basename(src)} failed (exit ${code})`);
      }
    }
    await step('setup', c.setup, 40 * 60_000);
    await step('launch', detachedTrainCommand(c), 120_000);
    const deadline = Date.now() + c.runTimeoutMin * 60_000;
    let failures = 0, finished = null;
    while (finished === null) {
      const code = await exec('ssh', sshArgs(POLL_COMMAND), { logFile: log, timeoutMs: 120_000 });
      if (code >= 100 && code < 200) { finished = code - 100; break; } // 255 is ssh failing to connect, not a finished run
      failures = code === 0 ? 0 : failures + 1;
      if (failures > maxPollFailures) throw new Error(`train: lost contact with the instance (${failures} failed polls in a row)`);
      if (Date.now() > deadline) throw new Error(`train: run timeout after ${c.runTimeoutMin} min`);
      await sleep(pollMs);
    }
    jr({ phase: 'train.exit', code: finished });
    if (finished !== 0) throw new Error(`train failed with exit code ${finished} (see run.log)`);
    result = { ok: true };
  } catch (e) { error = e; jr({ phase: 'train.error', error: String(e.message).slice(0, 300) }); }
  finally {
    if (gpu?.ssh) { // results are fetched even after a failed run: the log and any partial output are the diagnosis
      const { host, port, keyPath, knownHostsFile } = gpu.ssh;
      for (let attempt = 1; attempt <= retries; attempt += 1) { // a flaky link (exit 255) must not cost the results
        const code = await exec('scp', [...scpBase({ port, keyPath, knownHostsFile }), '-r', `root@${host}:${REMOTE}/out`, c.outDir], { logFile: log, timeoutMs: 600_000 });
        jr({ phase: 'train.download', code, attempt });
        if (code !== 255) break;
        await sleep(retryWaitMs);
      }
      await exec('scp', [...scpBase({ port, keyPath, knownHostsFile }), `root@${host}:${REMOTE}/train.log`, path.join(c.outDir, 'train.log')], { logFile: log, timeoutMs: 120_000 });
    }
    if (gpu) { const t = await gpu.teardown(); jr({ phase: 'teardown', ...t }); if (!t.confirmed && !error) error = new Error('teardown not confirmed; the watchdog stays armed'); }
  }
  if (error) throw error;
  return result;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cfgPath, runId] = process.argv.slice(2);
  if (!cfgPath || !runId) { console.error('usage: train-vast.mjs CONFIG.json RUN_ID'); process.exit(2); }
  try { console.log(JSON.stringify(await runTraining(JSON.parse(readFileSync(cfgPath, 'utf8')), runId))); } catch (e) { console.error(e.message); process.exit(1); }
}
