// Analyze a paired-bench output directory.
//   node eval/paired/paired-analyze.mjs DIR [--compare V1:V0,V2:V1] [--cells ARM] [--learnability ARM] [--json OUT.json]
// `--learnability ARM` reports, per cell, the share of task instances whose repeat samples differ (the GRPO signal).
// `--compare B:A` reports arm B minus arm A, paired on identical (cell, seed) episodes, with 95% bootstrap intervals;
// `--cells ARM` prints that arm's per-cell pass-rate table (where learnable, mid-band cells are). Default compares every
// other arm to the first arm in directory order.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cellTable, compareArms, flagged, learnability, loadArm, loadGroups, summarize } from './lib.mjs';

const fmt = (d) => `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(3)} [${d.lo >= 0 ? '+' : ''}${d.lo.toFixed(3)},${d.hi >= 0 ? '+' : ''}${d.hi.toFixed(3)}]`;
const pct = (x) => `${(100 * x).toFixed(1)}%`;

export function analyze(dir, { compare, cells } = {}) {
  const armNames = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory()).sort();
  const loaded = Object.fromEntries(armNames.map((n) => [n, loadArm(path.join(dir, n))]));
  // A subdirectory with no episodes (for example the environment variants a benchmark copies next to its results) is not an arm.
  const arms = Object.fromEntries(Object.entries(loaded).filter(([, eps]) => eps.size > 0));
  const names = Object.keys(arms);
  const pairs = compare?.length ? compare.map((s) => s.split(':')) : names.slice(1).map((n) => [n, names[0]]);
  const result = { summary: summarize(arms), comparisons: {}, cells: cells ? cellTable(arms[cells]) : null };
  for (const [b, a] of pairs) {
    if (!arms[a] || !arms[b]) throw new Error(`unknown arm in comparison ${b}:${a}`);
    result.comparisons[`${b}-${a}`] = compareArms(arms[a], arms[b]);
  }
  return result;
}

/** Per-cell learnability of one arm directory (needs repeat samples of the same instances; see paired-bench `repeats`). */
export function learnabilityReport(dir, arm) {
  return learnability(loadGroups(path.join(dir, arm)));
}

export function renderLearnability(table) {
  const lines = ['cell                       inst  grp  mixed   allZero  allSolved  meanRew  stdWhenMixed'];
  for (const [cell, v] of Object.entries(table)) lines.push(`${cell.padEnd(26)} ${String(v.instances).padStart(4)} ${v.groupSize.toFixed(1).padStart(4)}  ${pct(v.mixed).padStart(6)}  ${pct(v.allZero).padStart(7)}  ${pct(v.allSolved).padStart(8)}  ${v.meanReward.toFixed(3).padStart(7)}  ${v.meanStdWhenMixed.toFixed(3).padStart(8)}`);
  return lines.join('\n');
}

export function render(res) {
  const lines = [`paired episodes common to all arms: ${res.summary.paired}`, '', 'arm        n   meanReward  solved   badReplyEps'];
  for (const [n, s] of Object.entries(res.summary.arms)) lines.push(`${n.padEnd(8)} ${String(s.n).padStart(5)}   ${s.meanReward.toFixed(3).padStart(8)}  ${pct(s.solvedRate).padStart(6)}   ${pct(s.badRate).padStart(6)}   ${JSON.stringify(s.failureCounts)}`);
  for (const [name, c] of Object.entries(res.comparisons)) {
    lines.push('', `== ${name} (arm minus baseline), paired by seed, 95% bootstrap; * = |dReward|>0.10 and CI excludes 0`,
      `POOLED  n=${c.pairs}  dReward ${fmt(c.pooled.reward)}  dSolved ${fmt(c.pooled.solved)}`);
    for (const [cell, v] of Object.entries(c.cells)) lines.push(`${flagged(v.reward) ? '*' : ' '} ${cell.padEnd(26)} n=${String(v.n).padStart(3)}  dReward ${fmt(v.reward)}  dSolved ${fmt(v.solved)}`);
  }
  if (res.cells) {
    lines.push('', 'per-cell table for the chosen arm', 'cell                         n   meanReward  solved  reward>0  badReply');
    for (const [cell, v] of Object.entries(res.cells)) lines.push(`${cell.padEnd(26)} ${String(v.n).padStart(4)}   ${v.meanReward.toFixed(3).padStart(8)}  ${pct(v.solvedRate).padStart(6)}  ${pct(v.rewardPositive).padStart(7)}  ${pct(v.badRate).padStart(7)}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { compare: { type: 'string' }, cells: { type: 'string' }, learnability: { type: 'string' }, json: { type: 'string' } } });
  if (!positionals[0]) { console.error('usage: paired-analyze.mjs DIR [--compare B:A,...] [--cells ARM] [--json OUT]'); process.exit(2); }
  if (values.learnability) {
    const table = learnabilityReport(positionals[0], values.learnability);
    console.log(renderLearnability(table));
    if (values.json) writeFileSync(values.json, JSON.stringify(table, null, 1));
    process.exit(0);
  }
  const res = analyze(positionals[0], { compare: values.compare?.split(','), cells: values.cells });
  console.log(render(res));
  if (values.json) writeFileSync(values.json, JSON.stringify(res, null, 1));
}
