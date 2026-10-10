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

export async function runTraining(raw, runId, { provision = provisionGpu, exec = run, ssh = runSsh,
  stateDir = path.join(os.homedir(), '.local/state/arena-flywheel'), journal } = {}) {
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
    const step = async (name, command, timeoutMs) => {
      jr({ phase: `train.${name}.start` });
      const code = await exec('ssh', sshArgs(command), { logFile: log, timeoutMs });
      jr({ phase: `train.${name}.exit`, code });
      if (code !== 0) throw new Error(`${name} failed with exit code ${code} (see run.log)`);
    };
    await step('mkdir', `mkdir -p ${REMOTE}/env ${REMOTE}/out`, 120_000);
    for (const [src, dst] of [[c.script, `${REMOTE}/grpo_arena.py`], [path.join(c.envDir, 'arena_env'), `${REMOTE}/env/`]]) {
      const code = await exec('scp', [...scpBase({ port, keyPath, knownHostsFile }), ...(isDir(src) ? ['-r'] : []), src, `root@${host}:${dst}`], { logFile: log, timeoutMs: 300_000 });
      jr({ phase: 'train.upload', src: path.basename(src), code });
      if (code !== 0) throw new Error(`upload of ${path.basename(src)} failed (exit ${code})`);
    }
    await step('setup', c.setup, 40 * 60_000);
    await step('train', remoteCommand(c), c.runTimeoutMin * 60_000);
    result = { ok: true };
  } catch (e) { error = e; jr({ phase: 'train.error', error: String(e.message).slice(0, 300) }); }
  finally {
    if (gpu?.ssh) { // results are fetched even after a failed run: the log and any partial output are the diagnosis
      const { host, port, keyPath, knownHostsFile } = gpu.ssh;
      const code = await exec('scp', [...scpBase({ port, keyPath, knownHostsFile }), '-r', `root@${host}:${REMOTE}/out`, c.outDir], { logFile: log, timeoutMs: 600_000 });
      jr({ phase: 'train.download', code });
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
