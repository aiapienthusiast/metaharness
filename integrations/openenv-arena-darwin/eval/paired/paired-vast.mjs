// Run a paired benchmark on a rented Vast GPU: provision (flywheel/gpu.mjs: pinned vLLM digest, worst-case spend ledger
// written before create, label watchdog armed before create, confirmed destroy), point paired-bench at the tunnelled
// server, and always tear down. Spend is bounded by the ledger caps in the config and by the owner's total cap.
//
//   node --experimental-strip-types eval/paired/paired-vast.mjs CONFIG.json RUN_ID
//
// CONFIG is the paired-bench config plus an optional `gpu` object that overrides flywheel GPU_DEFAULTS
// (for example { "maxDphUsd": 3, "maxGpuHours": 4, "dailyCapUsd": 25, "totalCapUsd": 250 }).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionGpu } from '../../flywheel/gpu.mjs';
import { runBench } from './paired-bench.mjs';

/** GPU config for a benchmark: the flywheel defaults, a 4 h hard window and the owner's caps unless overridden. */
export function gpuConfig(cfg = {}) {
  return { maxDphUsd: 3.0, maxGpuHours: 4, graceHours: 0.25, dailyCapUsd: 25, totalCapUsd: 250, ...cfg };
}

/** Wall-clock the benchmark may use inside the rental: the window minus boot/teardown headroom. */
export const benchWallSeconds = (gpu) => Math.max(600, Math.floor((gpu.maxGpuHours - 0.75) * 3600));

export async function runOnVast(raw, runId, { provision = provisionGpu, bench = runBench, stateDir = path.join(os.homedir(), '.local/state/arena-flywheel'), journal } = {}) {
  const gpuCfg = gpuConfig(raw.gpu);
  mkdirSync(raw.outDir, { recursive: true });
  const jfile = path.join(raw.outDir, 'journal.jsonl');
  const jr = journal ?? ((e) => appendFileSync(jfile, `${JSON.stringify(e)}\n`));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let gpu = null, summary = null, error = null;
  try {
    gpu = await provision({ runId, config: gpuCfg, stateDir, journal: jr });
    jr({ phase: 'bench.start', baseUrl: gpu.baseUrl, dphTotal: gpu.dphTotal, plannedUsd: gpu.plannedUsd });
    summary = await bench({ ...raw, baseUrl: gpu.baseUrl, maxWallS: Math.min(raw.maxWallS ?? Infinity, benchWallSeconds(gpuCfg)) });
    jr({ phase: 'bench.done', ...summary });
  } catch (e) { error = e; jr({ phase: 'run.error', error: String(e.message).slice(0, 300) }); }
  finally { if (gpu) { const t = await gpu.teardown(); jr({ phase: 'teardown', ...t }); if (!t.confirmed && !error) error = new Error('teardown not confirmed; the watchdog stays armed'); } }
  if (error) throw error;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cfgPath, runId] = process.argv.slice(2);
  if (!cfgPath || !runId) { console.error('usage: paired-vast.mjs CONFIG.json RUN_ID'); process.exit(2); }
  try { console.log(JSON.stringify(await runOnVast(JSON.parse(readFileSync(cfgPath, 'utf8')), runId))); } catch (e) { console.error(e.message); process.exit(1); }
}
