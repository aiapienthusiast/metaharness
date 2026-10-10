// Shared pieces for the paired prompt-variant benchmark: strict action parsing, episode loading and a seeded
// paired bootstrap. Pure functions, no network. Node only (no Python of our own; the env lane's calibrate.py is
// spawned as a child process by paired-bench.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ACTION_OPS = new Set(['list', 'read', 'submit']);

/** Strict conformance of one assistant reply: exactly one JSON object whose `op` is a known action. */
export function isConformingAction(content) {
  try {
    const o = JSON.parse(String(content).trim());
    return o !== null && typeof o === 'object' && !Array.isArray(o) && ACTION_OPS.has(o.op);
  } catch { return false; }
}

/** Count assistant replies that are not strict actions. */
export function badReplyCount(messages) {
  let bad = 0;
  for (const m of messages ?? []) if (m?.role === 'assistant' && !isConformingAction(m.content)) bad += 1;
  return bad;
}

/** `finance_ledger_d2_s900012.jsonl` -> { cell: 'finance_ledger_d2', fileSeed: 900012 } */
export function parseCellFile(name) {
  const m = /^(.*)_s(\d+)\.jsonl$/.exec(name);
  return m ? { cell: m[1], fileSeed: Number(m[2]) } : null;
}

/** Load one arm's episodes: Map key `${cell}#${seed}` -> {cell, reward, solved, bad, failure, messages}. */
export function loadArm(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = parseCellFile(f);
    if (!p) continue;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'episode' || r.trajectory?.failure === 'provider_request_failed' || r.failure === 'provider_request_failed') continue;
      const messages = r.trajectory?.messages ?? [];
      out.set(`${p.cell}#${r.seed}`, {
        cell: p.cell, reward: Number(r.reward) || 0, solved: Boolean(r.solved), bad: badReplyCount(messages) > 0,
        failure: r.failure ?? r.trajectory?.failure ?? null, messages,
      });
    }
  }
  return out;
}

/** mulberry32: small deterministic PRNG so confidence intervals reproduce exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Paired bootstrap of mean(diffs): resample the pairs with replacement. -> {mean, lo, hi, n} (95%). */
export function pairedBootstrap(diffs, { resamples = 2000, seed = 1 } = {}) {
  const n = diffs.length;
  if (!n) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const r = rng(seed), means = new Array(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += diffs[Math.floor(r() * n)];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return { mean: mean(diffs), lo: means[Math.floor(0.025 * resamples)], hi: means[Math.min(resamples - 1, Math.floor(0.975 * resamples))], n };
}

/** Pair two arms on identical (cell, seed) keys. -> sorted array of {key, cell, a, b}. */
export function pairArms(a, b) {
  const keys = [...a.keys()].filter((k) => b.has(k)).sort();
  return keys.map((key) => ({ key, cell: a.get(key).cell, a: a.get(key), b: b.get(key) }));
}

/** Pooled and per-cell paired deltas of arm `b` minus arm `a` (reward and full-solve rate). */
export function compareArms(a, b, opts = {}) {
  const pairs = pairArms(a, b);
  const delta = (sel) => (xs) => pairedBootstrap(xs.map((p) => sel(p.b) - sel(p.a)), opts);
  const dR = delta((e) => e.reward), dS = delta((e) => (e.solved ? 1 : 0));
  const cells = {};
  for (const p of pairs) (cells[p.cell] ??= []).push(p);
  return {
    pairs: pairs.length,
    pooled: { reward: dR(pairs), solved: dS(pairs) },
    cells: Object.fromEntries(Object.entries(cells).sort().map(([c, ps]) => [c, { n: ps.length, reward: dR(ps), solved: dS(ps) }])),
  };
}

/** A cell is flagged when |dReward| > 0.10 and its interval excludes 0. */
export const flagged = (d) => Math.abs(d.mean) > 0.10 && (d.lo > 0 || d.hi < 0);

/** Per-arm summary over the episodes common to all arms (so the arms stay paired). */
export function summarize(arms) {
  const names = Object.keys(arms);
  const common = names.map((n) => new Set(arms[n].keys())).reduce((s, t) => new Set([...s].filter((k) => t.has(k))));
  const out = {};
  for (const n of names) {
    const eps = [...common].map((k) => arms[n].get(k));
    out[n] = {
      n: eps.length, meanReward: mean(eps.map((e) => e.reward)), solvedRate: mean(eps.map((e) => (e.solved ? 1 : 0))),
      badRate: mean(eps.map((e) => (e.bad ? 1 : 0))), failureCounts: eps.reduce((m, e) => ((m[e.failure ?? 'none'] = (m[e.failure ?? 'none'] ?? 0) + 1), m), {}),
    };
  }
  return { paired: common.size, arms: out };
}

/** Cell table for one arm: solve rate, mean reward and the share of episodes with any reward. */
export function cellTable(arm) {
  const cells = {};
  for (const e of arm.values()) (cells[e.cell] ??= []).push(e);
  return Object.fromEntries(Object.entries(cells).sort().map(([c, es]) => [c, {
    n: es.length, meanReward: mean(es.map((e) => e.reward)), solvedRate: mean(es.map((e) => (e.solved ? 1 : 0))),
    rewardPositive: mean(es.map((e) => (e.reward > 0 ? 1 : 0))), badRate: mean(es.map((e) => (e.bad ? 1 : 0))),
  }]));
}
