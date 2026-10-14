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

### Addendum, 2026-10-13 17:30Z: board #197 (rca-umb) points to SkillsBench as the likely source of the private tasks

Claim: the arena's eight domain ids are the task taxonomy of SkillsBench v1.1 verbatim, the operator (benchflow) publishes the TB2 smoke test and the arena runtime Spaces, and a SkillsBench task is a container with real files, a prose instruction, terminal and Python, and a pytest-checked output file (reward 1 or 0, timeouts 600 to 1800 s). Published frontier trials pass 17 to 50% per category using a median of about 1.6M tokens, so an untrained 27B scoring about 4/40 would be the few short tasks, and training JSON answers to synthetic questions practises little of what these need. They ask the organizers whether heldout-v2 is drawn from the public v1.1 tasks or unreleased ones, and which wrapper and budgets serve it; their collapse control (#188) was scheduled for 17:53 EDT.

Verified by us: the public dataset `benchflow/skillsbench` (sha `be2a6ce2...`) has 87 task directories each with a `task.md`; the one we opened (`3d-scan-calc`) declares `category: industrial-physical-systems`, `interface: terminal, python`, `verifier: test-script`, i.e. the arena's exact domain id string and a terminal-and-file interface. Not verified: the per-category counts, the frontier trial numbers, and above all that heldout-v2 is drawn from these tasks (the organizers have not answered).

Implication for the decision above: together with #196 this is a second independent line of inference that the private interface is shell-and-files with an output file, which none of our entries (or most others') has trained. If true, repeating `focus4` buys a draw on a recipe that practises the wrong thing, and the collapse control (O4) becomes comparatively more valuable because it asks the prior question independent of interface. It does not change the standing-approval default (a free draw cannot lower the bank) but it lowers the information value of O1.

### Addendum, 2026-10-14 02:30Z: the collapse test result (rca-umb, board #201) and the interface measurements (dnakhla, board #202)

Collapse test (rca-umb's `five-desks-v5`, run `f40cfa9dc177cd5c8efe6828`, 254 updates, reward pays only for ending early): private score 3/40 (finance 1, media 1, office 1; delta -1 against untrained 4/40). Training reward rose from 0.48 to 0.76 (first against last 32 steps) on all eight tasks and mean reply length fell on every task (science 316 to 88 tokens); the policy learned to stop after about 3 calls instead of 6 but never collapsed to ending on its first reply. Their pre-registered reading: 0 or 1 of 40 would support "trained behaviour reaches the private score"; 3/40 is not that, but the strong reading needed training reward near 1 and they got 0.76, so they call it a weak negative, not a clean one. They note that a policy that stops after about 3 calls would still solve the few short tasks the base model solves if the evaluation is SkillsBench-shaped under small budgets (#197). Their own summary: a run trained for 254 updates to quit early lands in the same 2 to 5 band as every other run; together with dnakhla's #191 (reward 0.69 to 0.89, 3/40) and our focus4 (reward 0.37 to 0.51, 4/40), within-run training has not been seen to move the private score either way.

Interface measurements (dnakhla, terminal-desk-v2 accepted 02:17Z, run `c8fd802d5bbb24e4b103e225`, 25 mixed-outcome tasks on the operator's tbench2_env contract): on the 87 public SkillsBench tasks under the arena budget an observation costs a median 633 tokens (the instruction, median 1,212 characters, rides along every turn), so a policy gets a median 6 actions, and a minimal write-run-evaluate episode fits 4,096 tokens in 44 of 87 tasks. Untrained Qwen3.8-27B (thinking off, temperature 1.0) on 10 of those tasks under that contract, 50 episodes: 3 solved, and 46 of 47 losses ended before any answer was judged (reported causes include prose before the JSON, JSON escaping, tool_call tags, empty replies and scripts cut by the reply cap). Pre-registered by them: the interface hypothesis is counted against if terminal-desk-v2 scores 4 or less. Not verified by us: their counts and runs; we verified only the operator's public files cited in #196 and #197 earlier.

What this changes for us:
- The collapse test has now been run once by someone else, with a weak negative. The case for spending our own slot on a replicate (option O4) is weaker than when it was written; a cleaner variant (training reward near 1) is the only version that would add information, and rca-umb says their next run moves to the evaluation's likely shape.
- Entries that train our JSON read/submit interface (focus4, repeated) are expected to stay in the 2 to 5 band; their information value is low, as the earlier note says.
- If the evaluation resembles the shell-and-files contract, the dominant failure for an untrained model is reply format and length discipline (prose before the JSON, escaping, truncation), not task knowledge. Our locally trained adapters did nearly eliminate malformed replies (ADR-320 d28, d30), but on our interface; whether that habit carries to a different harness is untested.
- terminal-desk-v2 (dnakhla) is now the live test of the interface hypothesis; its result (expected around 06:00Z to 07:00Z) should be read before any decision to rebuild our environment.

### Result of the repeat, 2026-10-14 04:22Z: `metaharness-focus4-20261014` scored 2/40

Run `5d05ffeec75d1498b43560c0` (289 updates; request identical to the 2026-10-13 entry except the submission id; accepted 2026-10-14T00:41:45.318Z): 2/40 (industrial 1, office 1, every other domain 0), delta -2 against untrained 4/40. Best-per-domain total unchanged at 8/40, now a composite of six runs (4, 4, 2, 4, 4, 2); rca-umb stands at 7/40 over five runs. Posted to board #203, #swarm, federation pub:showcase and core-memory#147 (comment 6160839325).

Comparison of the two identical-recipe runs (Trackio, all steps logged for the second):

| | 2026-10-13 (4/40) | 2026-10-14 (2/40) |
|---|---|---|
| reward, first vs last quarter | 0.369 vs 0.508 | 0.391 vs 0.519 |
| steps with grad_norm > 0 | 107 of 199 logged (54%) | 158 of 289 (55%) |
| mean frac_reward_zero_std | 0.462 | 0.453 |
| completions/clipped_ratio | 0.992 | 0.997 |
| step retries | 3 | 1 |

Same recipe, same task list, near-identical training signals, private scores 4 and 2. With n = 2 this is only a rough read, but it is a direct measurement that a run's private score moves by about two tasks with training behaviour held essentially constant; it agrees with the null control (#161), the 45-run analysis (#182) and the collapse test (#201). It also reproduces the earlier pattern for this recipe: healthy training signals, no detectable effect on the private score.

Decision (applying the rule in this ADR): the default for the next slot (O1, repeat `focus4`) is withdrawn. A third identical run is not informative, so nothing is armed for the slot of about 2026-10-15T00:41:47Z. A different entry needs a reason: either the owner's decision on a cleaner collapse variant (training reward near 1), or a rebuilt environment mirroring the operator's contract (#196, #197, #202), which should wait for dnakhla's terminal-desk-v2 result (expected about 06:00Z to 07:00Z, pre-registered by them: 4 or less counts against the interface hypothesis). Both are the owner's decisions.

### Result of the interface test, 2026-10-14 06:10Z: dnakhla's terminal-desk-v2 scored 3/40

Run `c8fd802d5bbb24e4b103e225` (accepted 02:17Z; 25 mixed-outcome tasks on the operator's tbench2_env contract, binary artifact reward; their pre-registration, board #202: it keeps industrial 2 and office 2 and adds a solve elsewhere, and 4 or less counts against the interface hypothesis). Read from the public leaderboard by us (their own board post had not appeared yet): 3/40 with industrial 1, office 1, science 1, every other domain 0. By their rule this counts against the hypothesis that training on the operator's likely interface moves the private score: the total is in the same 2 to 5 band as every other run, industrial and office are below their pre-registered 2 and 2, and the one new solve is in science, a domain almost no entrant solves (a single solve, not distinguishable from a lucky draw at this sample size). One run, so weak evidence, like the collapse test (#201).

Position after four independent attempts to move the private score by training (our focus4 twice, 4 and 2; rca-umb's collapse test, 3; dnakhla's terminal-desk-v1 and v2, 3 and 3; plus the earlier board-wide analysis): no training design tried so far has been seen to move the private score above chance, including one built on the operator's own contract. The remaining readings are that the effect is real but small relative to the evaluation noise (about two tasks, measured by our repeat), that the trained model's behaviour does not carry into the evaluation harness, or that the private tasks need capabilities a four-hour run cannot add. This ADR cannot separate them.

Consequence for the decision above: the case for rebuilding our environment to mirror the operator's contract is weaker than when it was first written (#196, #197), since an entry that did so did not score better. Nothing is armed. If the owner wants any further entry, the information-bearing options are a cleaner collapse variant (training reward near 1) or many repeated runs of one recipe over days (the only way to resolve a small effect against a noise of about two tasks); both cost slots and neither has been approved.

### Pre-registration, 2026-10-14 09:40Z: screen of public arena envs with HF inference (owner: "try a few different approaches")

Why: nothing that moved held-out full solves locally has moved the private score, and one arena run per day cannot see an effect smaller than about 2 tasks. HF inference serves Qwen3.8-27B (the arena's base model, Novita, listed at 0.42 in / 3.0 out USD per million tokens), so base-model behaviour can be measured on many task sources for cents, without a rented GPU. Pilot 2026-10-14 (8 envs, 1 episode each): works, about 0.05 USD in total, about 0.005 USD per episode; five-desks and analyst-workbench failed at reset (one episode each), not investigated yet.

Stage 1 (this entry): `eval/ext_env_eval.py`, all reachable public envs, up to 96 episodes per env, 8 seeds, hard cap 8 USD, thinking off, temperature 0.7. Measured per env: mean reward, share of full solves, and learnability = share of task ids whose repeat samples do not all score the same (the GRPO signal; zero-variance groups teach nothing). Our own families are the comparison (office and software d1/d2 are known to be learnable).
Stage 2 (only if stage 1 shows a gap): a knowledge-graph-embedding screen. Build triples (task, family), (task, difficulty), (task, failure mode seen in the Stage 1 trajectories) and fit a small embedding (TransE-style, or ruvector's graph tooling); the claim to test is that it predicts which unmeasured task ids are learnable better than difficulty alone, scored on held-out task ids with measured learnability. If it does not beat the difficulty-only baseline, it is dropped.

Predictions (written before the run): (1) public envs differ widely: at least two have base full-solve share under 10% and at least two over 50%; (2) learnability peaks for envs whose mean reward is between 0.2 and 0.8, and is near zero at both ends; (3) none of the public envs is more learnable than office d1/d2; (4) total spend under 8 USD.
What would count against the screen as a method: learnability measured on one run of 96 episodes disagreeing with a second run by more than 15 points on the same env. What this cannot show: anything about the private tasks. The screen picks task sources worth training on; only repeated arena runs, or a proxy of the private distribution, can test transfer.

### Result of the stage 1 screen, 2026-10-14 11:10Z (8 of 10 public envs measured, 1.99 USD of the 8 USD cap)

Untrained Qwen3.8-27B through HF inference (Novita), thinking off, temperature 0.7, 8 seeds per task id where the env varies with the seed. five-desks (18 resets) and analyst-workbench (58 resets) failed at reset every time, so they are unmeasured, not zero.

| env | episodes | mean reward | full solves | task ids with a mixed outcome |
|---|---|---|---|---|
| log-triage | 96 | 0.99 | 99% | 1 of 12 |
| python-repair-v3 | 96 | 0.67 | 64% | 8 of 12 |
| ledger-check | 96 | 0.59 | 59% | not measurable (one seed per id) |
| trace-path-lab | 64 | 0.20 | 9% | 5 of 8 |
| reconcile-lab | 72 | 0.12 | 10% | 4 of 9 |
| derivation-check | 16 | 0.13 | 13% | not measurable |
| audit-trail | 24 | 0.08 | 8% | not measurable |
| kvbatch-repair | 16 | 0.00 | 0% | 0 of 2 |

Against the predictions: (1) hit, four envs under 10% full solves and three over 50%; (2) mostly hit: the two envs with mean reward 0.2 to 0.7 (python-repair-v3, trace-path-lab) have the highest mixed share (about two thirds) and the saturated env (log-triage) has almost none, but reconcile-lab at 0.12 still has 4 of 9 mixed, so learnability does not fall to zero at the low end; (3) not yet checked, the office and software d1/d2 mixed share from our own runs has not been put beside these numbers; (4) hit. Mixed shares rest on 8 to 12 task ids each, so they are rough. The reproducibility test named above (a second run within 15 points) has not been run.

Reading: python-repair-v3, trace-path-lab and reconcile-lab are the public task sources where this model's outcomes vary within a task id, which is what GRPO needs. This says nothing about the private tasks. Stage 2 (the knowledge-graph embedding screen) is not started.

### Addendum, 2026-10-14 15:10Z: dnakhla posts the terminal-desk-v2 detail (board #217), including the first natural-science solve

Their own reading: 3/40 is a miss against their pre-registration, so the interface-mirror hypothesis is not supported (already recorded above). New: it is the first natural-science solve on the board (0 of 325 task attempts across 65 evaluated runs before it). Their v2 training set had three science ids (two reaction-kinetics fits, one stoichiometry batch; stdlib arithmetic on a CSV, all-or-nothing check on one output file). They call it a lead, not a result, until a second run repeats it, and they note the loss of one industrial and one office solve is ordinary noise. Training reward 0.75 to 0.84, zero-std share rising 0.53 to 0.70 (tasks saturated too fast). Their next entry (v3, slot about 02:17Z on 2026-10-15) adds SkillsBench-shaped tasks screened so the untrained model solves 1 to 3 of 4 per id, keeps science in the mix, and queues a hard control (reward 1 iff evaluate is the first action) if v3 scores 4 or less.

Bearing on this lane (our reading, not a measurement of ours): a family-matched training set is the one design so far that coincides with a solve in a domain no other run has solved, which is the within-family pattern our local runs show (office and software d1/d2 raise held-out full solves) and cross-family transfer is still absent. Our own science cells were not learnable by the knob scan (ADR-320 d33), so we have not trained on science. n = 1 solve; it can be a coincidence at the rate they estimate (about one run in fifty).

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
- 2026-10-14 ~04:30Z: repeat run evaluated at 2/40; default O1 withdrawn; nothing armed for 2026-10-15.
- 2026-10-13 ~04:30Z: result integrated (4/40, account total unchanged at 8, predictions P1 to P3 hit), posted to board #190, #swarm, pub:showcase and core-memory#147. Owner decision on O1 versus O4 outstanding; nothing armed for 2026-10-14.
- 2026-10-13 ~03:20Z: board #188 (rca-umb collapse control) added as option O4, recommendation recorded, owner decision requested.
