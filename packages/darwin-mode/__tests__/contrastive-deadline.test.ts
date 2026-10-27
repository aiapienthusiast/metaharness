// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runContrastive, digestDocument, type ContrastiveOptions, type ProbeInput } from '../src/contrastive/index.js';

function fixture(): ContrastiveOptions {
  return {
    tenantId: 'tenant-a', projectId: 'project-a', task: { prompt: 'Repair task' },
    environment: { model: 'fixed-model', runtime: 'fixed-snapshot' },
    envelope: { network: false, tools: ['read'] },
    library: { tenantId: 'tenant-a', projectId: 'project-a', entries: [] },
    baseline: { components: [
      { id: 'planner', scope: 'invariant', content: { mode: 'base' }, trigger: 'always' },
      { id: 'domain', scope: 'domain', content: { mode: 'base' }, trigger: 'always' },
    ] },
    budget: { maxUsd: 7, maxCalls: 7, timeoutMs: 50, probeUsd: 1, proposeUsd: 1, composeUsd: 1 },
    evaluator: { surfaceAware: true, probe: async i => evidence(i) },
    proposer: { propose: async i => {
      const componentId = i.scope === 'invariant' ? 'planner' : 'domain';
      return { edits: [{ componentId, content: { mode: 'better' }, citations: [`obs-${componentId}`] }], costUsd: 0.1 };
    } },
    composer: { compose: async i => ({ edits: i.supportedEdits, costUsd: 0.1 }) },
  };
}
function evidence(input: ProbeInput) {
  return { appliedDigest: input.candidateDigest,
    score: input.candidate.components.some(c => (c.content as { mode: string }).mode === 'better') ? 0.9 : 0.1,
    costUsd: 0.1,
    observations: input.candidate.components.map(c => ({ id: `obs-${c.id}`, componentId: c.id, message: 'Improve procedure' })),
  };
}
afterEach(() => vi.restoreAllMocks());

describe('one total contrastive round deadline', () => {
  it('rolls back an earlier winner when individually fast calls exhaust the cumulative deadline', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const o = fixture();
    const seen: string[] = [];
    const probe = vi.fn(async (i: ProbeInput) => { seen.push('probe'); elapsed += 15; return evidence(i); });
    const proposer = vi.fn(async (i: Parameters<typeof o.proposer.propose>[0]) => {
      seen.push(`propose:${i.scope}`); elapsed += 15; return o.proposer.propose(i);
    });
    const compose = vi.fn(o.composer!.compose);
    const r = await runContrastive({ ...o, evaluator: { surfaceAware: true, probe }, proposer: { propose: proposer }, composer: { compose } });
    expect(seen).toEqual(['probe', 'propose:invariant', 'probe', 'propose:domain']);
    expect(r.outcome).toBe('baseline');
    expect(r.candidateDigest).toBe(digestDocument(o.baseline));
    expect(r.reason).toBe('timeout');
    expect(r.calls).toBe(4);
    expect(r.reservedUsd).toBe(4);
    // Three valid 0.1 reports; the timed-out fourth call charges its full ceiling.
    expect(r.reportedUsd).toBeCloseTo(1.3);
    expect(r.receipts.at(-1)?.status).toBe('timeout');
    expect(compose).not.toHaveBeenCalled();
    expect(r.promotion).toBe('not-authorized');
  });

  it('does not admit any adapter when setup already consumes the deadline', async () => {
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => reads++ === 0 ? 0 : 51);
    const o = fixture();
    const probe = vi.fn(o.evaluator.probe);
    const r = await runContrastive({ ...o, evaluator: { surfaceAware: true, probe } });
    expect(r.reason).toBe('timeout');
    expect(r.calls).toBe(0);
    expect(r.reservedUsd).toBe(0);
    expect(r.reportedUsd).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a synchronous adapter result exactly at the total deadline', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const o = fixture();
    const propose = vi.fn(o.proposer.propose);
    let signal: AbortSignal | undefined;
    const r = await runContrastive({ ...o, proposer: { propose }, evaluator: { surfaceAware: true, probe: async i => {
      signal = i.signal; elapsed = 50; return evidence(i);
    } } });
    expect(r.reason).toBe('timeout');
    expect(r.outcome).toBe('baseline');
    expect(r.calls).toBe(1);
    expect(r.reservedUsd).toBe(1);
    expect(r.reportedUsd).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(propose).not.toHaveBeenCalled();
  });

  it('accepts a complete round below the total deadline and keeps promotion unauthorized', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const o = fixture();
    const r = await runContrastive({ ...o,
      evaluator: { surfaceAware: true, probe: async i => { elapsed += 5; return evidence(i); } },
      proposer: { propose: async i => { elapsed += 5; return o.proposer.propose(i); } },
      composer: { compose: async i => { elapsed += 5; return o.composer!.compose(i); } },
    });
    expect(r.reason).toBe('development-improvement');
    expect(r.outcome).toBe('candidate');
    expect(r.calls).toBe(7);
    expect(r.reportedUsd).toBeCloseTo(0.7);
    expect(r.promotion).toBe('not-authorized');
  });

  it('returns by the remaining deadline even if a late adapter never cooperates', async () => {
    const o = fixture();
    let pendingSignal: AbortSignal | undefined;
    let settle: (() => void) | undefined;
    const propose = vi.fn(o.proposer.propose);
    const r = await runContrastive({ ...o, budget: { ...o.budget, timeoutMs: 20 }, proposer: { propose }, evaluator: {
      surfaceAware: true, probe: i => {
        pendingSignal = i.signal;
        return new Promise(resolve => { settle = () => resolve(evidence(i)); });
      },
    } });
    const original = JSON.stringify(r);
    expect(r.reason).toBe('timeout');
    expect(pendingSignal?.aborted).toBe(true);
    expect(r.reportedUsd).toBe(1);
    expect(propose).not.toHaveBeenCalled();
    settle?.();
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(r)).toBe(original);
  });
});
