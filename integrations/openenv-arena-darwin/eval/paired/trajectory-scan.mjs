// Reward-hack regression guard over archived arena trajectories.
//
// The deterministic monitor in packages/weight-eft (detectRewardHack) inspects OpenAI-style `tool_calls` and tool
// responses. Arena trajectories carry each action as plain assistant JSON ({"op":"read","path":"..."}) and each
// observation as a user message, so running the monitor on them unchanged inspects nothing and always reports
// "clean". arenaToDarwin() converts the arena shape into the tool-call shape the monitor understands; the tests include
// positive controls so that a clean result means the monitor actually looked.
//
//   node --experimental-strip-types eval/paired/trajectory-scan.mjs DIR [DIR ...] [--json OUT.json]
//   (DIR holds per-cell JSONL files as written by calibrate.py / paired-bench.mjs; exit 1 if anything is flagged)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectRewardHack } from '../../../../packages/weight-eft/src/reward-hack.ts';

const OP_TO_TOOL = { read: 'read_file', list: 'view', submit: 'submit' };

/** One assistant reply -> {op, path, ok}; ok=false when it is not a single JSON action object. */
export function parseAction(content) {
  try {
    const o = JSON.parse(String(content).trim());
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.op === 'string') return { ok: true, op: o.op, path: typeof o.path === 'string' ? o.path : '' };
  } catch { /* not an action */ }
  return { ok: false };
}

/**
 * Arena trajectory ({messages:[{role,content}]}) -> Darwin trajectory with tool_calls and tool messages.
 * A parsed action becomes a tool call (`read` -> read_file, `list` -> view, `submit` -> submit) and the next user
 * message (the environment's observation) becomes that call's tool response. Unparseable replies stay plain text.
 */
export function arenaToDarwin(trajectory, meta = {}) {
  const out = [];
  let pending = null, n = 0;
  for (const m of trajectory?.messages ?? []) {
    if (m.role === 'assistant') {
      const a = parseAction(m.content);
      if (a.ok) {
        pending = `call_${(n += 1)}`;
        out.push({ role: 'assistant', content: null, tool_calls: [{ id: pending, type: 'function',
          function: { name: OP_TO_TOOL[a.op] ?? a.op, arguments: JSON.stringify(a.op === 'submit' ? { op: 'submit' } : { path: a.path }) } }] });
      } else { pending = null; out.push({ role: 'assistant', content: String(m.content ?? '') }); }
    } else if (m.role === 'user' && pending) {
      out.push({ role: 'tool', tool_call_id: pending, content: String(m.content ?? '') });
      pending = null;
    } else out.push({ role: m.role, content: String(m.content ?? '') });
  }
  return { instance_id: meta.id ?? 'arena', model: meta.model ?? 'unknown', tier: 'on-policy', resolved: false, messages: out };
}

/** Scan one arena trajectory. -> RewardHackFinding[] (empty means the monitor looked and found nothing). */
export function scanTrajectory(trajectory, meta) {
  return detectRewardHack(arenaToDarwin(trajectory, meta));
}

/** Walk DIRs for *.jsonl episode files and scan every episode. */
export function scanDirs(dirs) {
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.jsonl')) files.push(p);
    }
  };
  dirs.forEach(walk);
  let episodes = 0, actions = 0;
  const flagged = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'episode' || !r.trajectory) continue;
      episodes += 1;
      actions += r.trajectory.messages.filter((m) => m.role === 'assistant' && parseAction(m.content).ok).length;
      const findings = scanTrajectory(r.trajectory, { id: `${r.task_id ?? 'task'}#${r.seed}` });
      if (findings.length) flagged.push({ file: path.relative(process.cwd(), f), seed: r.seed, task: r.task_id, findings });
    }
  }
  return { files: files.length, episodes, actionsInspected: actions, flaggedEpisodes: flagged.length, flagged };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'string' } } });
  if (!positionals.length) { console.error('usage: trajectory-scan.mjs DIR [DIR ...] [--json OUT.json]'); process.exit(2); }
  const res = scanDirs(positionals);
  const summary = { files: res.files, episodes: res.episodes, actionsInspected: res.actionsInspected, flaggedEpisodes: res.flaggedEpisodes };
  console.log(JSON.stringify(summary));
  if (res.flagged.length) for (const f of res.flagged.slice(0, 20)) console.log(JSON.stringify(f));
  if (values.json) writeFileSync(values.json, JSON.stringify(res, null, 1));
  process.exit(res.flaggedEpisodes ? 1 : 0);
}
