# Independent rule learning gate

Status: experimental integration contract. This does not establish real learning gains.

`evaluateRuleLearning` is exported by `@metaharness/darwin`. A trusted host supplies
three sealed task families and five unique seeds. It binds candidate, executable,
rulebook and corpus hashes before invoking its bounded interpreter. The host owns
answers, computes integer success counts, counts actual interactions and tests
independent invariants. Candidate-provided scores or success flags are not evidence.

Each artifact runs twice per family/seed. All measurements and receipt hashes must
match. Replay and hidden-probe failures reject. Promotion needs a 20 percentage
point gain on two families and 25% fewer total interactions. Family regression is
zero. Nonzero regression overrides are rejected. Scores are
sample-weighted within families. Baseline and candidate sample counts must match.

Errors reject. A rejected report never exposes a promotable evidence object.
Accepted evidence uses `rule-learning-evidence/v1` for Autogenous's independently
signed promotion envelope. Hashes provide identity, not authentication. The trusted
signer must bind run ID to the envelope nonce and sign only accepted reports.
Raw hidden answers never appear in exported evidence. Keep the corpus private.
For Autogenous, `candidateHash` and the baseline's `candidateHash` identify the
signed candidate manifests. The trusted host must resolve each manifest to its
rule artifact, verify that artifact's hash and verify `programHash` independently.
The smoke uses synthetic manifests to exercise this binding, not real signatures.

Timeouts abort asynchronous runners but cannot preempt synchronous JavaScript.
The host must enforce process/worker CPU and memory budgets, or use Dream Machine's
finite DSL interpreter. Never evaluate generated JavaScript or shell strings.

With sibling Dream Machine checkout and Node supporting TypeScript stripping:

```
node --experimental-strip-types scripts/rule-learning-ecosystem-smoke.mjs /tmp/rule-learning-smoke.json
```

The fixture executes Dream Machine's actual interpreter, verifies hash bindings,
measures predictions and retries on synthetic tasks, then exercises a failed probe.
It is not a substitute for three genuinely withheld task families and real cost
measurement. Report its timings as integration overhead only.

## Validation recorded during development

The focused suite passes 24 contract and adversarial tests, plus 20 existing scorer
tests. Standalone strict
TypeScript checking passes. One complete 60-run synthetic integration took about
95 ms on the development container; this is not a p95 or target-device claim.
No new runtime dependencies were added. Full package/repository tests and actual
sealed-task acceptance remain separate release gates.

For gate-only overhead, run:

```
node --experimental-strip-types scripts/benchmark-rule-learning-gate.mjs
```

On Node 24.19.0 in the development container, 30 fixtures after five warmups gave
p50 1.00 ms, p95 2.84 ms and maximum 3.21 ms. Each fixture makes 60 synthetic host
calls. These numbers measure validation, hashing and scheduling with trivial host
measurements; they exclude real evaluation work and cannot establish model or
device latency. Zero interaction counts and unsafe aggregate counts reject.
