# Contrastive integration and deadline validation

This change reuses the existing `darwin-v0.12.0` implementation and its independent confirmation gate. That branch was absent from main. The new runtime change is the development round deadline described in ADR-321. No duplicate refinement engine is added.

## Results

* Darwin package: 840 tests passed, 14 skipped, zero failed. Build and type check passed.
* Five new deadline regressions pass. The original released engine fails two of these tests: cumulative budget and setup expiry.
* Offline confirmation: disjoint development/confirmation inputs and provider contract checks pass, with zero real provider calls.
* Three synthetic parser seeds: frozen 88/300, selected sampling control 165/300, contrastive 300/300. Across 96 control seed runs, mean control success is 78.60/100 (range 46–100). Do not compare only against the weaker selected control.
* Full contrastive loop: median 0.77–1.03 ms and p95 1.28–1.86 ms across seed runs. These are local callback measurements, not model latency.
* Five timed rounds, seven possible 30 ms callbacks, 100 ms budget: old median 219.90 ms and seven admissions; patched median 100.43 ms and four admissions. This is 54.33% earlier termination of incomplete work, not faster successful completion.
* Identical proposals suppress two candidate probes; the reference execution remains required. This optimization already existed and is now revalidated.

The JSON reports retain source/build hashes; all listed hashes were checked against the delivered files. The recorded commit is the parent of the change, so the file hashes bind the measured working tree. Reports are synthetic mechanism evidence, not model accuracy or cross-domain transfer evidence.

## Security review

The delta admits no new capabilities, persistence, provider requests or dependencies. The deadline uses a monotonic clock and is checked before effects, after callbacks/validation, and on cache hits. Failure preserves the baseline and conservative reservations. The new tests cover late results and absence of subsequent effects. Existing citation, scoped memory, malformed input, budget and confirmation adversarial tests pass.

Trusted adapters must enforce cost ceilings and process termination. AbortSignal cannot preempt blocking JavaScript or stop a remote provider. Memory remains experimental, scoped lexical retrieval; no native RuVector ranking or memory expiry is claimed. A returned development candidate never authorizes production promotion.

## Reproduction and boundaries

Use the commands in `validation.json` and the benchmark README. `deadline.mjs` accepts a separately extracted old engine to reproduce the comparison. Pin TypeScript 5.4.5 and Vitest 2.1.9 for these results.

Root `npm ci` encountered preexisting missing optional kernel entries in the lockfile. Tests used isolated pinned tooling without modifying dependencies. This validates the Darwin package, not a clean full monorepo installation. No paid model run or new release was performed.

The prior model pilot in `../confirmation-0.12.0/` found 38/40 for every arm with higher candidate inference cost. That remains the relevant live evidence; the synthetic result does not supersede it. Before a capability claim, preregister fresh tasks and compare current Darwin, contrastive refinement and equal total cost retries, followed by isolated confirmation.
