# Contrastive harness development

Available from `@metaharness/darwin/contrastive` in 0.11.0. This opt-in API develops declarative harness configurations through measured comparisons. It leaves the existing `evolve` API unchanged.

```js
import {
  runContrastive,
  createContrastiveEditors,
  rememberContrastiveExperience,
  retrieveContrastiveExperiences,
} from '@metaharness/darwin/contrastive';

// executeEditor is your real Ruflo worker or model client. It returns
// {text: '{"edits":[...]}', costUsd}, enforces ceilingUsd and honors signal.
const editors = createContrastiveEditors(executeEditor);
const result = await runContrastive({
  tenantId: 'acme', projectId: 'support',
  baseline: { components: [
    { id: 'procedure', scope: 'invariant', content: { checkInputs: true } },
    { id: 'domain', scope: 'domain', content: { currency: 'USD' } },
  ] },
  task: { request: 'your development task' },
  environment: { model: 'pinned-model-id', evaluatorVersion: 1 },
  envelope: { network: false, shell: false, promotion: false },
  library: { tenantId: 'acme', projectId: 'support', entries: [] },
  budget: { maxUsd: 0.7, maxCalls: 7, timeoutMs: 30000,
    probeUsd: 0.1, proposeUsd: 0.1, composeUsd: 0.1 },
  evaluator: { surfaceAware: true, probe: executeCandidate },
  ...editors,
});
console.log(result.outcome, result.receipts, result.promotion);
```

The example requires two deployment adapters; it does not start an agent by itself. `executeCandidate` must load `input.candidate`, execute it in the declared environment, and return `{appliedDigest, score, observations, costUsd}`. Scores are finite numbers in `[0,1]`. Observations contain `{id, componentId, message}`. Keep heldout answers and production release authority outside the editor.

An edit contains `{componentId, content, citations}`. It can replace content only within its scope; it cannot add components, capabilities or dependencies. Component IDs, dependency closure, reachability, sizes, JSON shape and citation matches are validated. A composer selects a subset of supported edits, and that combination is executed before selection. Identical candidates reuse the current round's probe.

Budget admission reserves ceilings before every effect and never refunds them during a round. This favors safety over maximizing call count. Failed or malformed rounds return the baseline. Timeouts reject late results; the trusted adapter must stop its actual work. A provider response exceeding its ceiling is an invalid round with the reported charge retained in evidence.

Memory helpers produce portable, bounded experimental records. They perform no disk, network or production writes. `rememberContrastiveExperience` requires an improved candidate and matching successful probe receipt; `retrieveContrastiveExperiences` enforces tenant, project and an explicit environment key before lexical ranking. It returns at most eight records, with a four-record default. Libraries hold at most 32 entries. Applications may persist these through AgentDB/RVF and replace lexical ranking with RuVector after the same scope filter. Those integrations are not bundled or implicitly configured.

Callbacks and memory records are trusted deployment inputs, not cryptographically verified evidence. The core never evaluates embedded code. Apply OS isolation and Darwin's generated-code checks when your adapter executes scripts. Digest equality proves content identity within the adapter contract, not honesty of an external executor.

## Reproduce

From a source checkout, build and run:

```bash
npm ci --ignore-scripts
npm run build -w @metaharness/darwin
npm test -w @metaharness/darwin -- --maxWorkers=2 --minWorkers=1
node packages/darwin-mode/bench/contrastive/run.mjs --out=/tmp/contrastive.json
```

For an explicitly paid live editor smoke, set `OPENROUTER_API_KEY` in the process environment and run `node packages/darwin-mode/bench/contrastive/live-pilot.mjs --live --out=/tmp/contrastive-live.json`. It uses real provider editors and a synthetic deterministic executor. The local reservation cap is $0.25. No credentials are written to the report.

The benchmark measures mechanism correctness, operation counts, source identity and orchestration latency. It does not demonstrate general LLM improvement, production safety, or superiority over current Darwin. See [ADR-319](https://github.com/ruvnet/metaharness/blob/main/docs/adrs/ADR-319-bounded-contrastive-development.md).
