// Offline microbenchmark: identical bytes are required before timing either implementation.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canon } from '../../packages/flywheel/dist/receipts.js';
function reference(v, depth = 0) {
  if (depth > 64) throw new Error('depth');
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(x => reference(x, depth + 1)).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${reference(v[k], depth + 1)}`).join(',')}}`;
}
const payload = { kind: 'candidate', id: 'root__reasoning_gen1', parents: ['root'], generation: 1,
  primaryDelta: 0.1, verdict: 'PROMOTED', failureReasons: [], anchorScore: 0.5,
  baselineScore: { primary: 0.4, noopRate: 0.2, costPerWin: 1, regressed: false },
  candidateScore: { primary: 0.5, noopRate: 0.1, costPerWin: 1, regressed: false } };
assert.equal(canon(payload), reference(payload));
const count = 50000;
function sample(fn) { const start = performance.now(); for (let i = 0; i < count; i++) fn(payload); return performance.now() - start; }
for (let i = 0; i < 10000; i++) { reference(payload); canon(payload); }
const baseline = [], current = [];
for (let i = 0; i < 7; i++) {
  if (i % 2) { current.push(sample(canon)); baseline.push(sample(reference)); }
  else { baseline.push(sample(reference)); current.push(sample(canon)); }
}
const median = xs => [...xs].sort((a, b) => a - b)[3];
console.log(JSON.stringify({ node: process.version, iterationsPerSample: count, samples: 7,
  baselineMedianMs: median(baseline), currentMedianMs: median(current),
  speedup: median(baseline) / median(current), byteIdentical: true }, null, 2));
