# ADR-321: OpenEnv Arena `focus4` result and the entry of 2026-10-14

**Status**: Proposed (Result filled in 2026-10-13 04:30Z after the evaluation; the entry decision for 2026-10-14 is awaiting the owner)
**Date**: 2026-10-13
**Scope**: `integrations/openenv-arena-darwin/**` (branch `feat/openenv-arena`) and the daily submission procedure
**Related**: ADR-320 (decisions 27 to 34: held-out learning experiments, rung scan, predictions for this run), ADR-319 `openenv-arena-curriculum` (environment lane, PR #383, not duplicated here)

## Context

State at 2026-10-13 ~03:00Z (public leaderboard and Trackio, our own receipts):

- Account best-per-domain total is 8/40 (office 3, industrial 2, finance 1, media 1, software 1, security 0, math 0, science 0), ahead of akseljoonas and NoeFlandre at 6/40. It is a composite of four runs scoring 4, 4, 2 and 4; no single run is above the untrained 4/40.
- The board's own noise analysis (rca-umb #182, 45 runs): industrial behaves like two coin-flip tasks (0/1/2 = 11/22/12 runs), office like one sure task plus one coin flip, software 1 appears in about 29% of runs; the untrained expectation is near 2.9, trained runs average 2.98, and no entrant differs from chance (permutation p = 0.6). The null control (#161, zero gradient) scored 1/40 and zero-learning runs span 1 to 4. Reading: best-per-domain totals are partly a count of draws.
- Local, pre-registered, held-out evidence (ADR-320 d27 to d33): binary-reward training on office_reconciliation + software_change d1/d2 raised full solves on those families on two training seeds (7.3% to 30.2%, 4.2% to 25.0%) and transferred across difficulty within a family (office d3 0.0% to 37.5% untrained-on-d3); it did not transfer across families; adding d3 to the mix did not help; the generator knobs give no learnable rung in science or software. All of it is on our generators, our recipe and strict scoring (which the arena guide confirms is the rule: exactly one JSON object per reply).
- The entry under study, `metaharness-focus4-20261013`, trains the arena's fixed recipe on four tasks (office_reconciliation d1/d2, software_change d1/d2). It was accepted at 2026-10-13T00:41:34.506Z through the single checked path (all pre-submit checks on image digest `2f3f12b9...6b37`, request sha256 `8fb43a33...f75a`); Trackio run `40c917900f26e0b0d3462f3f` started 00:44:48Z. Predictions P1 to P3 were written before the result (ADR-320 d34).
- Process facts that shaped this entry: two Claude sessions on the host both believed they were primary; the environment lane's HOLD note of 2026-10-11 ~23:10Z was never answered by the owner; the submission went out under the owner's standing approval ("continue"), with Slack treated as input, not approval.

## Result (to be filled in once the run is evaluated)

| Field | Value |
|---|---|
| Run id | 40c917900f26e0b0d3462f3f |
| Evaluated score (of 40) | 4 (evaluated 2026-10-13 ~04:24Z, 273 updates, 4 train tasks) |
| Per domain | industrial 2, office 2, software 0, finance 0, media 0, science 0, math 0, security 0 |
| Delta against untrained 4/40 | 0 |
| Account best-per-domain total after this run (was 8) | 8 (unchanged: office 3, industrial 2, finance 1, media 1, software 1); composite of five runs (4, 4, 2, 4, 4) |
| Standing on the board | #1 at 8/40; akseljoonas and NoeFlandre 6/40; 48 evaluated runs on the leaderboard |
| Trackio (199 of 273 steps logged; the service was down for part of the run) | reward first quarter 0.369, second 0.385, third 0.491, last 0.508; grad_norm > 0 on 107 of 199 logged steps (54%); mean frac_reward_zero_std 0.462; completions/clipped_ratio 0.992; mean completion length 137; 3 step retries |
| Posted to | board #190, #swarm, federation pub:showcase, core-memory#147 (comment 6138208220): done |

### Comparison with the pre-registered predictions (ADR-320 d34)

- P1 (private score 2 to 5, most likely 3 or 4; office 1 to 3, software 0 to 2): hit. Total 4, office 2, software 0, all inside the stated ranges.
- P2 (account total most likely unchanged at 8; any increase roughly one in five): hit. Unchanged at 8; no domain improved (office 2 against banked 3, software 0 against banked 1, industrial 2 equal).
- P3 (reward rises first to last quarter, about 0.3 to 0.4 to 0.5; nonzero-gradient share above the office-only runs' 22 to 24%): hit. Reward 0.369 to 0.508 (the last quarter sits at the top edge of the stated range); gradient share 54% against 22 to 24% for the office-only d3 runs and 48% for mix8; clipped_ratio 0.99 again (consistent with the accounting-artefact reading, still an inference).
- Verdict on the local lever, applying the rule fixed in d34: the failure signatures (flat reward, or gradient share at or below the office-only runs) did not occur, and a single score from 2 to 5 settles nothing. So the arena's own recipe produced a healthy training signal and rising training reward on these tasks, but the private score did not move: this run is neither evidence for nor against the lever reaching the private score. It is consistent with the board's noise analysis (#161, #182) and with rca-umb's open question (#188).

## Decision: the entry of 2026-10-14 (slot opens about 00:41:36Z, 24 hours after the acceptance above)

Constraints, fixed now so the choice is not made with hindsight:

1. One submission per rolling 24 hours; banked per-domain bests cannot be lowered, so a weak run costs only the slot. The slot is worth (a) a draw for the bank and (b) one more data point on the arena-level effect of a recipe. Because the score is so noisy, (b) can only be learned by repeating a recipe many times; one run never confirms or refutes it.
2. Tasks that give no gradient (all-zero groups) cost optimizer steps without teaching anything, so padding the task list with zero-solve families dilutes training on the cells that are learnable. A mixed list is therefore not a free hedge.
3. Marginal value by domain for the bank (today's bests): office 3 and software 1 are the only domains our local lever touches; industrial 2 is at the highest value anyone has seen; finance 1 and media 1 are rare to improve; security, math and science are 0 and almost never solved by any entrant. No option below changes these odds much.

Options for the entry:

- O1. Repeat `focus4` unchanged (same request, same tasks). Builds an arena-level sample of one recipe.
- O2. Resubmit the `mix8` form (the incumbent used for the 4, 4 and 4 arena scores, mixed cells). Serves as the control arm.
- O3. A one-change variant of `focus4`. Not available until a lever with local evidence exists; the d3 lever and the knob rungs are both closed (ADR-320 d31, d33).
- O4. Run rca-umb's collapse control (board #188, pre-registered by them) from our account: the identical public request (image `ghcr.io/rca-umb/five-desks@sha256:8d805ada...9471`, request `rca-umb/five-desks-control` revision `ab596332...`, only `submission_id` changed), where the reward pays only for ending early. Question it answers: does 4-hour training reach the private score at all? Their prediction: if it does, the private result falls to 0 or 1 of 40 (no run has scored 0; about 9% of runs score 1 or less); if it scores 2 or more while Trackio rewards are near 1, the evaluation is not measuring what training changed and environment design cannot move the board. They submit at 21:53Z on 2026-10-13 and ask for replicates ("two replicates beat one"). Cost to us: that day's draw for the bank (banked bests cannot be lowered). Value: it is the only design in the discussion that can separate "training does not reach the score" from "the effect is hidden by noise", and the answer decides whether any further environment work (ours included) can move the board. It is not a candidate for the score, so it needs the owner's decision; the standing approval covers the best available scoring candidate. Requires the same checked path on that image digest; their `submission_request.json` must be read in full before use.

Decision rule (applied once the Result table is filled in):

- Applying the rule now that the signals passed P3: the default for 2026-10-14 is O1 (repeat `focus4` unchanged), unless the owner approves O4 for this slot, in which case O4 replaces it (recommended: the collapse control is the one experiment that could change what we do next, and a second replicate is worth more than a second draw on the same noisy recipe). If O4 is run, a result of 0 or 1 supports "training reaches the score" (low n, one replicate), a result of 2 or more with Trackio rewards near 1 supports "the eval does not reflect training"; neither is conclusive alone and both are read together with rca-umb's own replicate.
- If the training signals fail P3 (reward flat across quarters, or nonzero-gradient share at or below the office-only runs), the local lever has not reproduced in the arena's own recipe and the entry switches to O2 as the control arm.
- A score change alone does not change the default in either direction (R1: a single run is not evidence of a training effect; selection over noisy draws is the leading explanation for any lead we hold).
- Alternating arms across days (O1 on some days, O2 on others) is the only way to get a comparison from daily slots, and even seven days gives about three or four runs per arm, which can only detect a large effect. This is stated so nobody reads a small difference as a result.
- Regardless of the option, arming follows the process below.

## Process decisions

1. One submitter. Exactly one armed primary job and at most one fallback timer, owned by one named session; before arming, list every armed path (jobs, systemd timers, cron) and record the owner.
2. The owner (rUv) decides which session owns arena submissions and whether the environment lane's HOLD gates an entry; until recorded, the entry that is armed is posted for review in #swarm at least a few hours before the slot, with the cancel commands.
3. Read #swarm and the board before any POST; results are posted once each to the board, #swarm, pub:showcase and core-memory#147, with the composite and noise caveats; Slack notes are input, not approval.
4. Tokens are never echoed into output; npm token rotation is outstanding after the earlier exposure.

## New information, 2026-10-13 14:30Z: the private-eval interface may differ from the one we train on (board #196, partly verified)

dnakhla (#196) argues the private heldout-v2 tasks may be served the way the operator's own public smoke tests are: Terminal-Bench 2 tasks through OpenEnv's `tbench2_env` (actions `exec | write_file | evaluate`, observations with the whole instruction repeated each turn, an in-container pytest verifier), with the smoke limits (completion_tokens 4096, context_tokens 8192, tool_calls_total 32, tool_wall_s 110). Verified by us from the operator's public files (benchflow dataset `openenv-smoke-fix-git`, `submission.json`, sha `5cd6b066...`): the task is a Terminal-Bench 2 `fix-git` task, the action schema has `action_type`, `command`, `file_path`, `content`, `session_id`, `wait_seconds`, the example action is `{"action_type": "evaluate"}`, and the limits are exactly 4096 / 8192 / 32 / 110. Not verified (an inference by #196, not a fact): that the private heldout-v2 uses this wrapper and these budgets; the Space is paused and the private tasks are unpublished. The model-card figure (73% on Terminal-Bench 2.1 with thinking on, against 10% here) is also theirs and unchecked by us.

Why it matters to our result: every entry so far, ours included, trains a JSON `read/submit` answer interface with 12288/16384 token budgets and 8 tool calls, which resembles the private interface in none of these respects if the hypothesis is right. That would explain why training reward rises (focus4: 0.37 to 0.51) while the private score stays at chance, and why local gains do not reach it, without any single run being unlucky. It makes within-family difficulty transfer on our own interface (ADR-320 d28 to d31) uninformative about the private score.

Consequences recorded now (no action taken):
- The easier-task-variants build (previous section) should be scoped, if approved, as an environment that mirrors the operator's schema byte for byte, repeats the instruction each turn, keeps the 4096/8192/32 limits, and calibrates base solve rates before any training. dnakhla has pre-registered such a v2; their result is the cheapest evidence on the hypothesis.
- The collapse control (O4) remains valuable: it tests whether training reaches the private score at all, independent of interface.
- Questions still unanswered by the operator (asked in #196): whether heldout-v2 goes through tbench2_env with the smoke budgets; whether eval decoding is sampled or greedy with thinking off.
- #195 (GlobalBusinessAdvisors): their Darwin confirmation failed on a power-plan mismatch (8 paired blocks available against 13 required at candidateBudget 7) in their own configuration; no request to this lane.

## Next research item (needs the owner's approval before any build)

The only remaining route to making the zero-solve families learnable is new task content: genuinely easier variants shipped in a new or extended environment image (not the knobs). Scope, pre-registration and cost are to be written as a separate ADR if approved. Nothing is started.

## Consequences

- Positive: the next entry is chosen by a rule fixed before the result, not by the result; the noise limits are written next to every claim; a failed local lever is detected from training signals rather than from a single noisy score.
- Negative: the default (repeat) buys information slowly; the arena cannot resolve small effects at one run a day; the zero-solve families stay unaddressed until task content is built.

## Evidence

- Leaderboard and Trackio reads, 2026-10-13; board messages #161, #162, #182; our receipts (acceptance 2026-10-13T00:41:34.506Z, request sha256 `8fb43a335d888faa534dba9951b02c1d270ad14f20d0b165b1df81fc25b8f75a`).
- Local held-out experiments and predictions: ADR-320 decisions 27 to 34 (local commits through `89231d11`).

## Integration log

- 2026-10-13 ~03:00Z: draft created; run training; Result and Decision rows pending.
- 2026-10-13 ~04:30Z: result integrated (4/40, account total unchanged at 8, predictions P1 to P3 hit), posted to board #190, #swarm, pub:showcase and core-memory#147. Owner decision on O1 versus O4 outstanding; nothing armed for 2026-10-14.
- 2026-10-13 ~03:20Z: board #188 (rca-umb collapse control) added as option O4, recommendation recorded, owner decision requested.
