// SPDX-License-Identifier: MIT
//
// iter 117 — verifies the new metaharness subcommand router. Per the user's
// directive: "Before generation: metaharness. Inside generated harness: harness."
//
// We cover the structural surface (router recognizes the verbs, falls
// through correctly, errors helpfully). The from-repo verb invokes git
// over the network — we test the missing-args error path without touching
// the actual clone code.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let main: (argv: string[]) => Promise<number>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'index.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'index.js')}`);
  main = mod.main;
});

// `main()` uses console.log / console.error. We patch those directly so the
// test output stays clean and we get a deterministic capture (the underlying
// process.stdout.write override gets bypassed by vitest's own pipe wrapping).
async function captureMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const chunksOut: string[] = [];
  const chunksErr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { chunksOut.push(a.map(x => String(x)).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { chunksErr.push(a.map(x => String(x)).join(' ') + '\n'); };
  try {
    const code = await main(argv);
    return { code, out: chunksOut.join(''), err: chunksErr.join('') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe('metaharness subcommand router (iter 117)', () => {
  it('from-repo with missing args returns exit 2 with usage', async () => {
    const r = await captureMain(['from-repo']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: npx metaharness from-repo/);
  });

  it('from-repo with only URL returns exit 2 (still need name)', async () => {
    const r = await captureMain(['from-repo', 'https://github.com/foo/bar']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: npx metaharness from-repo/);
  });

  it('analyze runs analyze-repo against a real local dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metaharness-analyze-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf-8');
      await writeFile(join(dir, 'README.md'), '# demo', 'utf-8');
      const r = await captureMain(['analyze', dir]);
      // analyze-repo exits 0 on a sane local dir.
      expect([0, 1]).toContain(r.code);
      // Some signal of having read the dir.
      expect(r.out.length).toBeGreaterThan(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('genome runs the genome command against a real dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metaharness-genome-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }), 'utf-8');
      const r = await captureMain(['genome', dir]);
      // Genome can return 0, 1, or 2 depending on the scorecard. Just verify
      // it ran something coherent.
      expect([0, 1, 2]).toContain(r.code);
      expect(r.out).toMatch(/harness genome|Repo profile|Scorecard|exit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('genome with missing path returns exit 2 with usage', async () => {
    const r = await captureMain(['genome']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Usage: harness genome/);
  });

  it('bare name (back-compat) still works — falls through to legacy scaffold', async () => {
    // No name + no subcommand → prints usage with exit 2.
    const r = await captureMain([]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Usage: npx metaharness/);
  });

  it('unknown first-arg verb (not a subcommand, not a flag) falls through to legacy scaffold', async () => {
    // "unknown-name" isn't a subcommand → router returns null → legacy scaffold runs.
    // We chdir to a tempdir so the legacy scaffold writes there, not into the
    // repo root (iter 118 caught a stray artifact from the old version of this test).
    const dir = await mkdtemp(join(tmpdir(), 'metaharness-bare-'));
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const r = await captureMain(['unknown-name-here', '--force']);
      // Whatever the result, the "from-repo" usage line MUST NOT appear —
      // confirms the router did not intercept the unknown verb.
      expect(r.err).not.toMatch(/Usage: npx metaharness from-repo/);
    } finally {
      process.chdir(origCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Dream Cycle 2026-10-20 (generator-genome) — closes the 2026-08-27
  // deferral: `doctor`/`diag`/etc. aren't real subcommands, so the router
  // above returns null for them too, but unlike "unknown-name-here" they
  // read as a command a user typed by habit — this guard stops the legacy
  // scaffold from silently running (and exiting 0) for exactly that set.
  for (const word of [
    'doctor', 'diag', 'audit', 'validate', 'compare', 'mcp-scan', 'help', 'version',
    // Round 2 (independent critic, same night): the generated harness's own
    // `harness <verb>` subcommands (subcommands.ts) hit the identical bug.
    'verify', 'sign', 'federate', 'mcp', 'publish', 'upgrade', 'completions',
    'analyze-repo', 'export-config', 'oia-manifest', 'plugin-init',
  ]) {
    it(`reserved look-alike word "${word}" errors instead of silently scaffolding`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'metaharness-reserved-'));
      const origCwd = process.cwd();
      try {
        process.chdir(dir);
        const r = await captureMain([word]);
        expect(r.code).toBe(2);
        expect(r.err).toMatch(/looks like a command, not a project name/);
        expect(existsSync(join(dir, word))).toBe(false);
      } finally {
        process.chdir(origCwd);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('reserved look-alike word still scaffolds with --force (escape hatch preserved)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metaharness-reserved-force-'));
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const r = await captureMain(['doctor', '--force']);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, 'doctor', 'package.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a name that merely resembles a reserved word (not an exact match) still scaffolds normally', async () => {
    // Exact-match only by design (see RESERVED_LOOKS_LIKE_A_COMMAND) — a
    // Levenshtein/fuzzy guard risks false-positiving on legitimate project
    // names (e.g. "doctor-bot"); confirmed scope stays narrow.
    const dir = await mkdtemp(join(tmpdir(), 'metaharness-notreserved-'));
    const origCwd = process.cwd();
    try {
      process.chdir(dir);
      const r = await captureMain(['doctor-bot']);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, 'doctor-bot', 'package.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
