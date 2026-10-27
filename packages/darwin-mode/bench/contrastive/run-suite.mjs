// SPDX-License-Identifier: MIT
// Reproducible multi-seed mechanism suite; no model capability claim.
import assert from 'node:assert/strict';
import { runBenchmark } from './run.mjs';

const seeds = [261014224, 261014225, 261014226];
const reports = [];
for (const seed of seeds) reports.push(await runBenchmark({ seed, iterations: 100 }));
const passed = arm => reports.reduce((sum, report) => sum + report.results[arm].passed, 0);
const sampling = reports.flatMap(report => report.results.samplingSeedSensitivity);
const averageControlPasses = sampling.reduce((sum, row) => sum + row.passed, 0) / sampling.length;
for (const report of reports) {
  assert.equal(report.evidenceKind, 'synthetic-mechanism-benchmark');
  assert.equal(report.dataset.heldout, 100);
  assert.equal(report.realModelSpendUsd, 0);
  assert.equal(report.budgetChecks.limit7.admitted, 7);
  assert.equal(report.budgetChecks.unchangedEdits.probes, 1);
  assert.equal(report.budgetChecks.unchangedEdits.callsAvoided, 2);
}
console.log(JSON.stringify({
  schemaVersion: 1, evidenceKind: 'synthetic-multi-seed-mechanism-benchmark',
  claimEligible: false, seeds, generatedHoldoutCases: 300, distinctTaskFamilies: 1,
  realModelSpendUsd: 0,
  aggregate: {
    frozenPassed: passed('frozenHarness'),
    singleControlPassed: passed('equalBudgetSampling'),
    contrastivePassed: passed('contrastive'),
    controlSeedRuns: sampling.length,
    meanControlPassesPer100: averageControlPasses,
    controlRangePer100: { min: Math.min(...sampling.map(x => x.passed)), max: Math.max(...sampling.map(x => x.passed)) },
    medianLatencyMsBySeed: reports.map(r => ({ seed: r.seed,
      contrastive: r.latency.contrastive.medianMs, retry: r.latency.equalBudgetSampling.medianMs })),
    p95LatencyMsBySeed: reports.map(r => ({ seed: r.seed,
      contrastive: r.latency.contrastive.p95Ms, retry: r.latency.equalBudgetSampling.p95Ms })),
  },
  optimization: { unchangedCandidateProbesAvoidedPerRun: 2,
    candidateProbeReductionPercent: 100, referenceProbeStillRequired: true,
    note: 'Applies only to identical edits; not a reduction in full-loop successful composition cost.' },
  limitations: [
    'Three seeds vary input data within one handcrafted parser family; not 300 independent real-world tasks.',
    'No LLM inference, current Darwin optimizer comparison, dollars, or transfer improvement is measured.',
    'Equal budget means seven logical operations, not equal provider cost or tokens.',
    'All full reports and provenance are retained below; no confidence interval implies external generalization.',
  ], reports,
}, null, 2));
