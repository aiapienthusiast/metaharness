// SPDX-License-Identifier: MIT
// Actual delayed adapter executions. Measures orchestration deadline behavior,
// not model speed. Optional argv[2] is a local old engine module for comparison.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runContrastive } from '../../dist/contrastive/index.js';
import { createSyntheticOptions } from './synthetic-adapter.mjs';
import { makeTasks } from './fixtures.mjs';
import { provenance, stats } from './provenance.mjs';

const budgetMs = 100, stageDelayMs = 30;
async function measure(run, sharedDeadline) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const { options, count } = createSyntheticOptions(makeTasks(261014224, 8, 'development'));
    options.budget.timeoutMs = budgetMs;
    let startedCalls = 0, abortedCalls = 0;
    const wrap = fn => async input => {
      startedCalls++;
      try { await delay(stageDelayMs, undefined, { signal: input.signal }); }
      catch (error) { abortedCalls++; throw error; }
      return fn(input);
    };
    options.evaluator.probe = wrap(options.evaluator.probe);
    options.proposer.propose = wrap(options.proposer.propose);
    options.composer.compose = wrap(options.composer.compose);
    const started = performance.now();
    const result = await run(options);
    const elapsedMs = performance.now() - started;
    // Let cooperative cancellation settle; this wait is outside elapsed time.
    await delay(1);
    if (sharedDeadline) {
      assert.equal(result.reason, 'timeout');
      assert.ok(startedCalls < 7);
    } else {
      assert.equal(result.outcome, 'candidate');
      assert.equal(startedCalls, 7);
    }
    samples.push({ elapsedMs, startedCalls, abortedCalls, completedCalls: { ...count },
      outcome: result.outcome, reason: result.reason, admittedCalls: result.calls });
  }
  return { latency: stats(samples.map(x => x.elapsedMs)), samples };
}
const current = await measure(runContrastive, true);
const oldModule = process.argv[2] ? await import(pathToFileURL(resolve(process.argv[2])).href) : null;
const prior = oldModule ? await measure(oldModule.runContrastive, false) : null;
console.log(JSON.stringify({ schemaVersion: 1, evidenceKind: 'cooperative-adapter-deadline-benchmark',
  provenance: provenance(), budgetMs, stageDelayMs, current, prior,
  priorEngineSha256: process.argv[2] ? createHash('sha256').update(readFileSync(resolve(process.argv[2]))).digest('hex') : null,
  medianElapsedReductionPercent: prior ? 100 * (1 - current.latency.medianMs / prior.latency.medianMs) : null,
  limitations: ['Wall-clock timers are best effort and can overshoot under event-loop starvation.',
    'Adapters cooperate with AbortSignal; untrusted processes require host-enforced termination.',
    'Stopping unfinished work earlier is a budget correction, not a task-quality or inference-speed improvement.',
    'Prior engine identity must be supplied by the caller and independently recorded.'],
}, null, 2));
