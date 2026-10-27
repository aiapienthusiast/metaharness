# ADR-321: One deadline for contrastive development and confirmation

**Status**: implemented experimentally; no automatic production promotion.

## Context

ADR-319 already provides bounded contrastive development, scoped improvement memory, evidence citations, selective composition, and duplicate probe suppression. ADR-320 adds independent paired confirmation. These implementations were present on `darwin-v0.12.0` but absent from the earlier main checkout. Reuse this existing implementation rather than introducing a second loop.

Inspection found that the development engine restarted `budget.timeoutMs` for every callback. Seven sequential effects could therefore take nearly seven times the configured timeout. The existing confirmation engine already has a shared session deadline. Call and dollar reservations remain independently bounded, but development timeout did not bound the whole operation.

## Decision

Capture a monotonic start time once per development round, aligning it with the existing confirmation session deadline. Compute one deadline from the configured timeout. Before admitting each effect, reject work at or past that deadline. Pass only the remaining duration to the timer and cancel the active adapter when it expires. Count development input validation and orchestration against that same elapsed budget. Confirmation retains its existing timing boundary.

Preserve receipt, money reservation, candidate-selection, evidence, and independent confirmation semantics. Never reset the deadline because an earlier callback finished quickly. Duplicate proposals still reuse the reference probe, and they do not extend the deadline. No new dependency or provider call is introduced.

Adapters remain trusted effect boundaries. JavaScript timers and AbortSignal cannot interrupt synchronous event-loop blocking, kill an uncooperative child process, or establish an OS sandbox. The host must enforce external process limits and cancellation. Timeout receipts do not certify that an external effect stopped.

## Alternatives

* Keep per-call timeout and document it: preserves accidental behavior, but leaves the session unbounded by the stated budget.
* Add a second optional session timeout: useful for future policy but unnecessarily preserves the unsafe default and expands the public contract.
* Replace the contrastive engine: duplicates already tested capabilities and expands regression risk.

## Acceptance

1. A sequence of individually fast callbacks exceeding the total timeout stops before the full sequence completes.
2. An expired round admits no additional effect or reservation.
3. Independent confirmation continues to use its existing shared session deadline.
4. Existing budget, citation, memory, deduplication, and independent confirmation regressions continue to pass.
5. The synthetic benchmark retains its original call accounting and selected configurations across three fixed seeds.

`bench/contrastive/deadline.mjs` measures five repetitions with seven possible 30ms callbacks and a 100ms budget, optionally comparing a separately supplied old engine. This measures prevented excess work, not faster task completion. `bench/contrastive/run-suite.mjs` executes the existing benchmark at three fixed seeds, retaining full receipts and source/build provenance.

## Claims and deployment gate

Synthetic parser benchmarks validate mechanics only. Their handcrafted proposers and common task distribution do not establish model capability, current Darwin optimizer superiority, or cross-domain transfer. Equal-budget sampling means equal logical operations, not equal LLM tokens or provider dollars. No live model benchmark or production promotion follows automatically.

Before a capability claim, compare the configured current Darwin optimizer, this loop, and a matched total-cost retry control on preregistered unseen professional tasks. Isolate confirmation answers and require measured benefit, zero policy violations, and declared cost and latency limits. An independent evaluator and host isolation remain required deployment dependencies.

Rollback: revert only the shared deadline change if necessary; the prior contrastive implementation and evidence schema remain intact. A rollback restores the previous per-call timing behavior and must not be described as a complete-session timeout.

## Consequences

The implementation adds explicit evidence and validation requirements. Its results remain bounded by the experimental scope and limitations described above; they do not authorize automatic production promotion.
