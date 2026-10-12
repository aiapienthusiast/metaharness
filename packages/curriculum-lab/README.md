# @metaharness/curriculum-lab

Experimental host harness for verifier-grounded curriculum learning. **Private draft, not published. No live LLM gain, Arena transfer or RSI is established.**

It connects a frozen experiment contract to Hugging Face proposal inference and an already-owned running Vast instance. It neither rents machines nor submits to Arena. The host retains authority and credentials; candidate proposals contain only one bounded numeric parameter.

## Run now without credentials

From this directory, on Node 24.19+ and Python 3:

```sh
npm test
npm run smoke
node src/cli.mjs plan examples/spec.json
```

The example spec has placeholder hashes, model revision and budget. It is illustrative and is **not permission or a live experiment registration**. Replace them with independently verified source/model/settings pins before preparing any live job. Production package runtime requires Node 20+; the repository-source Darwin integration test requires Node 24's TypeScript stripping. No dependency installation is needed for these tests.

The CPU smoke performs actual REINFORCE weight updates on a two-parameter logistic policy. For seeds 7, 19 and 31, fixed and hand-authored staged curricula both achieved 1000/1000 on fresh synthetic examples after 3600 updates per arm. There is **zero curriculum advantage**. This is a saturated numerical toy, not an LLM, autonomous task generation, genuinely different reasoning families or evidence of recursive improvement. A hand-authored oracle also gets 100%. The negative result is retained in `examples/local-learning-receipt.json`.

## Architecture and integration contract

1. `freezeSpec` validates and hashes source, verifier, trainer, model revision, settings, fixed cells, disjoint training/confirmation families and seeds, and resource ceilings. Register this digest durably before seeing outcomes. The returned object is a detached JSON snapshot; callers must not mutate it.
2. `proposeDarwin` uses the actual `@metaharness/darwin` numeric mutator, restricted to one knob and projected to one approved step. The optional peer is exactly 0.10.3. No shell evaluator is used, so its inherited environment cannot expose host credentials to candidate execution.
3. `proposeHF` is an alternative auxiliary proposer using an explicit model/provider. It sends only training families, knob and incumbent. It uses the Portfolio-compatible `json_object`, low reasoning effort and 2048 output ceiling. It does not replace the official target model. Support, license, price and data permission must be verified by the host before authorization.
4. `trainingManifest` renders a content-addressed job with no confirmation examples. `dispatchVast` checks that the authorized instance exists and is running, then sends a fixed hash-checked runner command through the official API. HTTP acknowledgement yields `QUEUED_UNVERIFIED`, never completion. Returned log URLs are not fetched or trusted.
5. `examples/runner.py` executes a preinstalled, hash-pinned trainer with a minimal environment. It retains immutable intent, private output and unsigned receipts, and refuses uncertain reruns. Install it as `/workspace/curriculum-lab/runner.py`, the reviewed trainer as `trainer.py`, and the exact manifest bytes at `manifests/<hash>.json`. Trainer contract: public training spec on stdin, `--output <path>`, one JSON result file. `local_learning.py` implements this contract for CPU smoke. A production Qwen/TRL trainer and evaluator are **not supplied or validated yet**; integrate the existing ruvultra driver after owner review.
6. `reviewComparison` checks fixed-cell discovery/confirmation improvement and paired transfer results, with complete trajectory hashes, source/settings binding and verified accounting. Every output has `promote:false` and `signed:false`. Passing numeric checks only queues independent review. Caller assertions and hashes are not trusted attestations, signatures or proof that trajectories exist.

```js
import {freezeSpec, proposeHF, trainingManifest, dispatchVast} from '@metaharness/curriculum-lab';
import {proposeDarwin} from '@metaharness/curriculum-lab/darwin';

const {spec, specHash} = freezeSpec(reviewedSpec);
const proposed = await proposeDarwin(spec, 7, 1);
const job = trainingManifest(spec, proposed.proposal, 600);
// Review/install pinned runner, trainer and job bytes on the owned executor.
// Host supplies a spec-bound authorization and loads only VAST_API_KEY in process.
// await dispatchVast({spec, directory, authorization, token, job: dispatchDescriptor});
```

## Provider authorization and accounting

`authorization` is a trusted host object, never a field accepted from model output. It binds `specHash`, `owner`, `operations`, expiry, and either exact HF `model` plus `maxRequestUsd`, or Vast `instanceId`, `runnerHash`, `manifestHash`, `maxJobUsd`. It is an explicit caller permission contract, **not** cryptographic authorization. The application must resolve ownership and user budget before constructing it.

Use one protected persistent directory per registered experiment. HF call/token/time/cost reservations and Vast job reservations are persisted before requests and never refunded after failure. Duplicate exact operations reuse immutable receipts. A process crash with intent but no result requires human reconciliation; there is no automatic retry. Locks fail closed and are never automatically broken. Scope the directory to one confidentiality context; do not share across users.

Reservations are conservative host estimates, not provider billing enforcement. Vast compute/storage can continue billing after a trainer stops. The owning executor must manage the existing instance's lifecycle and account-level limits. This package deliberately cannot stop or destroy another owner's instance. Actual billed cost stays `null` until independently obtained. `rounds <= 3` bounds the registration; the host scheduler must enforce generation sequencing and the learner's token/step limits.

`examples/ruos_secret.py` reads only HF_TOKEN or VAST_API_KEY from the protected binding, checks owner/mode and refuses symlinks/duplicates. It parses quoting as inert text, never sources a shell file. Do not print its return value, persist it, put it in argv, or pass it to the training instance. Provider response text, reasoning and raw transport errors are not written to receipts. The shared HF compatibility receipts remain authoritative; no paid compatibility retry is required.

## Trust and limitations

Host adapters, trainer, manifests, evidence directory and evaluator are trusted code/data. Candidate execution needs a separate isolated container without credentials or host mounts. The Python runner's empty environment and timeout are not a security sandbox. Its outer Vast timeout should exceed the manifest trainer timeout by at least 30 seconds; the operator must confirm whole-job termination remotely. OS/process constraints and independent result verification remain required before live use.

Training and confirmation data must be genuinely distinct. The checker cannot discover semantic leakage, attest hidden-set secrecy, verify a trajectory from its hash, or establish statistical significance. A mixed cell requires complete boolean outcomes; malformed actions, truncation and accounting/provider errors exclude the whole cell without shrinking its denominator. Full transfer evaluation must pair task identities and retain all failures. Do not tune on private Arena scores.

Flywheel/Autogenous signed promotion and existing rGi durable execution remain separate integration gates. This package does not claim to run either. It does not repair Arena issue384, merge policies, automatically publish a package, or enable submission. Vast/HF adapters are tested with contract fixtures; **live authentication and execution remain unverified**.

## Next experiment

After repairing the existing evidence gate and obtaining a budget, use a pinned small Qwen model and independently verified tasks. Compare equal-total-compute fixed curriculum, adaptive curriculum with frozen proposer, and adaptive curriculum with learning proposer. Run multiple training seeds and at most three generations. Freeze fresh confirmation families; count rejected proposals and evaluation costs. Accept an RSI-related result only if the learned proposer improves subsequent held-out learning over the frozen proposer, with uncertainty and regression checks. A successful transport or one better checkpoint is insufficient.

References checked 2026-10-11:

* https://arxiv.org/abs/2505.03335 (Absolute Zero)
* https://arxiv.org/abs/2605.14392 (EvoEnv, work in progress)
* https://arxiv.org/abs/2607.22529 (Skill Self-Play)
* https://docs.vast.ai/api-reference/instances/execute
* https://huggingface.co/docs/inference-providers/tasks/chat-completion
