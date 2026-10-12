#!/usr/bin/env python3
"""Local multi-turn GRPO prototype on the arena environment (small-model testbed).

The arena trains with TRL's GRPO (its Trackio metric names are TRL's). This script reproduces that loop locally with a
custom `rollout_func`: the arena's own text protocol (the model replies with exactly one JSON action per turn, the
environment answers with an observation), one training sequence per episode, loss only on the model's own tokens
(`env_mask`). Instance seeds come from the TRAIN range only (see eval/paired/splits.mjs); held-out evaluation is a
separate process on a different seed range.

Prototype limits (kept honest): a small model, HF generation (no vLLM), history rendered as generated (an empty think
block stays in earlier assistant turns, which the chat template would strip at inference), no reference model (beta=0).
"""
import argparse, json, os, random, sys, time

TRAIN_LO, TRAIN_HI = 2_000_000, 3_000_000  # must match eval/paired/splits.mjs
EVAL_SPLITS = {"heldout": (900_000, 910_000), "select": (910_000, 920_000), "confirm": (920_000, 930_000)}  # ditto
SOLVED = 0.999  # reward at or above this counts as a full solve
DECODE = {"greedy": False}

ap = argparse.ArgumentParser()
ap.add_argument("--env-dir", required=True, help="directory that contains the arena_env package (the environment variant)")
ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
ap.add_argument("--revision", default=None, help="model revision to pin")
ap.add_argument("--lora-r", type=int, default=16)
ap.add_argument("--debug-reward-format", action="store_true", help="DEBUG ONLY: reward = 1 if the first reply is a valid action, to prove gradient flows when rewards differ")
ap.add_argument("--no-template-check", action="store_true", help="skip the chat-template layout assertion (small local models only)")
ap.add_argument("--families", nargs="+", default=["office_reconciliation"])
ap.add_argument("--difficulties", type=int, nargs="+", default=[1])
ap.add_argument("--prompts-per-step", type=int, default=2)
ap.add_argument("--group", type=int, default=8)
ap.add_argument("--steps", type=int, default=10)
ap.add_argument("--max-turns", type=int, default=6)
ap.add_argument("--max-new", type=int, default=320)
ap.add_argument("--max-completion", type=int, default=6144)
ap.add_argument("--lr", type=float, default=5e-5)
ap.add_argument("--gen-batch", type=int, default=4, help="episodes sampled at once (bounds prefill memory)")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--out", required=True)
ap.add_argument("--dry-rollout", action="store_true", help="run one rollout batch and print stats, no training")
ap.add_argument("--reward-mode", choices=["partial", "binary"], default="partial",
                help="training reward: the environment's own reward, or 1.0 only for a full solve")
ap.add_argument("--adapter", default=None, help="load a saved LoRA adapter (used with --eval-only)")
ap.add_argument("--eval-only", action="store_true", help="evaluate (base model, or --adapter) and exit; no training")
ap.add_argument("--eval-split", choices=["heldout", "select", "confirm"], default=None,
                help="run evaluation episodes on this seed range: before training (tag base) and after it (tag trained)")
ap.add_argument("--eval-families", nargs="+", default=None, help="families to evaluate on (default: the training families)")
ap.add_argument("--eval-difficulties", type=int, nargs="+", default=None)
ap.add_argument("--eval-instances", type=int, default=16, help="instances per cell; the same seeds for every tag, so arms are paired")
ap.add_argument("--eval-repeats", type=int, default=1, help="samples per instance")
ap.add_argument("--eval-decoding", choices=["sample", "greedy"], default="sample")
ap.add_argument("--eval-tag", default="eval", help="output folder name for --eval-only")
args = ap.parse_args()

sys.path.insert(0, args.env_dir)
import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import GRPOConfig, GRPOTrainer
from arena_env.environment import ArenaAction, ArenaEnvironment
from arena_env.tasks import format_task_id

SYSTEM = ("Solve the task with the available tools. Each reply must be exactly one JSON action object, with no markdown. "
          "Action schema: " + json.dumps(ArenaAction.model_json_schema()))
os.makedirs(args.out, exist_ok=True)
random.seed(args.seed)

tok = AutoTokenizer.from_pretrained(args.model, revision=args.revision)
IM_END = tok.convert_tokens_to_ids("<|im_end|>")
EOS_IDS = [i for i in {IM_END, tok.eos_token_id} if i is not None]
PAD = tok.pad_token_id if tok.pad_token_id is not None else IM_END


def first_prompt_ids(messages):
    text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    return tok(text, add_special_tokens=False)["input_ids"]


def env_suffix_ids(observation_text):
    """Tokens that follow a model reply: close the turn, add the observation, open the next assistant turn (thinking off)."""
    text = f"\n<|im_start|>user\n{observation_text}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    return tok(text, add_special_tokens=False)["input_ids"]


def generate_batch(model, seqs):
    """Sample every active episode, `--gen-batch` at a time. -> [(gen_ids_including_eos, per_token_logprobs, hit_eos)]"""
    res = []
    for k in range(0, len(seqs), args.gen_batch):
        res += _generate_chunk(model, seqs[k:k + args.gen_batch])
        torch.cuda.empty_cache()
    return res


def _check_template():
    """Fail fast if the chat template no longer renders multi-turn history the way env_suffix_ids() assumes."""
    sysm, u1, u2 = {"role": "system", "content": "S"}, {"role": "user", "content": "U1"}, {"role": "user", "content": "U2"}
    base = tok.apply_chat_template([sysm, u1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    full = tok.apply_chat_template([sysm, u1, {"role": "assistant", "content": "A"}, u2], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    manual = base + "A<|im_end|>" + "\n<|im_start|>user\nU2<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    assert full == manual, f"chat template differs from the assumed layout:\n{full!r}\n{manual!r}"


if not args.no_template_check:
    _check_template()


@torch.no_grad()
def _generate_chunk(model, seqs):
    """Left-padded sampling for one chunk."""
    n, longest = len(seqs), max(len(s) for s in seqs)
    ids = torch.full((n, longest), PAD, dtype=torch.long)
    attn = torch.zeros((n, longest), dtype=torch.long)
    for i, s in enumerate(seqs):
        ids[i, longest - len(s):] = torch.tensor(s)
        attn[i, longest - len(s):] = 1
    dev = next(model.parameters()).device
    sampling = {"do_sample": True, "temperature": 1.0, "top_p": 1.0, "top_k": 0} if not DECODE["greedy"] else {"do_sample": False}
    out = model.generate(input_ids=ids.to(dev), attention_mask=attn.to(dev), **sampling,
                         max_new_tokens=args.max_new, eos_token_id=EOS_IDS, pad_token_id=PAD, output_scores=True, return_dict_in_generate=True)
    gen = out.sequences[:, longest:]
    scores = torch.stack(out.scores, dim=1).float()            # [n, T, V] processed logits (temperature 1.0 -> raw)
    logp = torch.log_softmax(scores, dim=-1).gather(-1, gen.unsqueeze(-1)).squeeze(-1)
    res = []
    for i in range(n):
        row = gen[i].tolist()
        cut, hit = len(row), False
        for j, t in enumerate(row):
            if t in EOS_IDS:
                cut, hit = j + 1, True
                break
        res.append((row[:cut], logp[i, :cut].tolist(), hit))
    return res


def run_episodes(model, specs):
    """Play one episode per spec with `model` (training and evaluation share this path).
    -> (prompt_ids, completion_ids, logprobs, env_mask, per-episode state, per-episode chat messages)."""
    n = len(specs)
    envs, msgs, prompt_ids, comp, lps, mask = [], [], [], [], [], []
    state = []  # per episode: dict(done, reward, failure, turns, invalid)
    for sp in specs:
        env = ArenaEnvironment()
        reset = env.reset(task_id=format_task_id(sp["family"], sp["difficulty"]), seed=sp["seed"])
        first = reset.model_dump_json()
        m = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": first}]
        envs.append(env); msgs.append(m)
        pid = first_prompt_ids(m)
        prompt_ids.append(pid); comp.append([]); lps.append([]); mask.append([])
        state.append({"done": False, "reward": 0.0, "failure": None, "turns": 0})
    for _turn in range(args.max_turns):
        active = [i for i in range(n) if not state[i]["done"]]
        if not active:
            break
        seqs = [prompt_ids[i] + comp[i] for i in active]
        outs = generate_batch(model, seqs)
        for i, (gen_ids, gen_lp, hit) in zip(active, outs):
            comp[i] += gen_ids; lps[i] += gen_lp; mask[i] += [1] * len(gen_ids)
            state[i]["turns"] += 1
            if not hit:
                state[i].update(done=True, failure="completion_truncated"); continue
            content = tok.decode(gen_ids[:-1], skip_special_tokens=True)
            msgs[i].append({"role": "assistant", "content": content})
            try:
                action = ArenaAction.model_validate_json(content)
            except Exception:
                state[i].update(done=True, failure="invalid_json_action"); continue
            try:
                obs = envs[i].step(action)
            except Exception:
                state[i].update(done=True, failure="environment_step_failed"); continue
            obs_text = obs.model_dump_json()
            msgs[i].append({"role": "user", "content": obs_text})
            suffix = env_suffix_ids(obs_text)
            comp[i] += suffix; lps[i] += [0.0] * len(suffix); mask[i] += [0] * len(suffix)
            if obs.done:
                state[i].update(done=True, reward=float(obs.reward))
        for i in range(n):
            if not state[i]["done"] and state[i]["turns"] >= args.max_turns:
                state[i].update(done=True, failure="step_budget_exhausted")
    # trim every completion to the completion budget
    for i in range(n):
        if len(comp[i]) > args.max_completion:
            comp[i], lps[i], mask[i] = comp[i][:args.max_completion], lps[i][:args.max_completion], mask[i][:args.max_completion]
    return prompt_ids, comp, lps, mask, state, msgs


def training_reward(s):
    """The reward the trainer sees: the environment's own, or 1.0 only for a full solve."""
    if args.debug_reward_format:
        return 0.0 if s["failure"] == "invalid_json_action" and s["turns"] == 1 else 1.0
    return (1.0 if s["reward"] >= SOLVED else 0.0) if args.reward_mode == "binary" else s["reward"]


def rollout_func(prompts, trainer):
    """One episode per entry of `prompts` (TRL already repeats each prompt `group` times). Returns the TRL rollout dict."""
    _t0 = time.time()
    model = trainer.accelerator.unwrap_model(trainer.model)
    was_training = model.training
    model.eval()
    DECODE["greedy"] = False
    specs = [json.loads(p) for p in prompts]
    n = len(specs)
    prompt_ids, comp, lps, mask, state, _msgs = run_episodes(model, specs)
    if was_training:
        model.train()
    rollout_func.last = {"state": state, "turns": [s["turns"] for s in state], "len": [len(c) for c in comp]}
    print("ROLLOUT " + json.dumps({"seconds": round(time.time() - _t0, 1), "episodes": n, "mean_reward": round(sum(x["reward"] for x in state) / n, 3),
                                    "mean_turns": round(sum(rollout_func.last["turns"]) / n, 2), "mean_tokens": round(sum(rollout_func.last["len"]) / n),
                                    "failures": {str(k): [x["failure"] for x in state].count(k) for k in set(x["failure"] for x in state)},
                                    "peak_gpu_gib": round(torch.cuda.max_memory_allocated() / 2**30, 1) if torch.cuda.is_available() else None}), flush=True)
    return {"prompt_ids": prompt_ids, "completion_ids": comp, "logprobs": lps, "env_mask": mask,
            "episode_reward": [training_reward(s) for s in state],
            "failure": [s["failure"] or "" for s in state]}


def reward_fn(prompts, completions, episode_reward=None, **kwargs):
    return [float(r) for r in episode_reward]


def make_dataset(n_rows):
    rows = []
    for _ in range(n_rows):
        rows.append(json.dumps({"family": random.choice(args.families), "difficulty": random.choice(args.difficulties),
                                "seed": random.randrange(TRAIN_LO, TRAIN_HI)}))
    for r in rows:
        assert TRAIN_LO <= json.loads(r)["seed"] < TRAIN_HI
    return Dataset.from_dict({"prompt": rows})


def evaluate(model, tag):
    """Run held-out episodes and write them in the layout eval/paired/paired-analyze.mjs reads:
    <out>/eval/<tag>/<family>_d<difficulty>_s<lo>[_r<rep>].jsonl. Seeds are lo+0..lo+instances-1, identical for every tag."""
    assert args.eval_split, "evaluate() needs --eval-split"
    lo, hi = EVAL_SPLITS[args.eval_split]
    assert args.eval_instances <= hi - lo
    outdir = os.path.join(args.out, "eval", tag)
    os.makedirs(outdir, exist_ok=True)
    was_training = model.training
    model.eval()
    DECODE["greedy"] = args.eval_decoding == "greedy"
    summary, t0 = {}, time.time()
    for fam in (args.eval_families or args.families):
        for d in (args.eval_difficulties or args.difficulties):
            specs = [{"family": fam, "difficulty": d, "seed": lo + k} for k in range(args.eval_instances)]
            assert all(lo <= s["seed"] < hi for s in specs)
            cell = f"{fam}_d{d}"
            for rep in range(args.eval_repeats):
                *_, state, msgs = run_episodes(model, specs)
                with open(os.path.join(outdir, f"{cell}_s{lo}{f'_r{rep}' if rep else ''}.jsonl"), "w") as f:
                    for sp, st, m in zip(specs, state, msgs):
                        f.write(json.dumps({"type": "episode", "seed": sp["seed"], "reward": st["reward"], "solved": st["reward"] >= SOLVED,
                                            "failure": st["failure"], "trajectory": {"messages": m, "failure": st["failure"]}}) + "\n")
                s = summary.setdefault(cell, {"n": 0, "solved": 0, "reward": 0.0})
                s["n"] += len(state); s["solved"] += sum(1 for st in state if st["reward"] >= SOLVED); s["reward"] += sum(st["reward"] for st in state)
    DECODE["greedy"] = False
    if was_training:
        model.train()
    total_n = sum(v["n"] for v in summary.values())
    print("EVAL " + json.dumps({"tag": tag, "split": args.eval_split, "decoding": args.eval_decoding, "seconds": round(time.time() - t0),
                                "episodes": total_n, "solved_rate": round(sum(v["solved"] for v in summary.values()) / max(1, total_n), 4),
                                "cells": {c: {"n": v["n"], "solved": v["solved"], "mean_reward": round(v["reward"] / v["n"], 3)} for c, v in summary.items()}}), flush=True)


model = AutoModelForCausalLM.from_pretrained(args.model, revision=args.revision, dtype=torch.bfloat16,
                                             device_map={"": 0} if torch.cuda.is_available() else None)
model.config.use_cache = True
if args.eval_only:
    if args.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
    evaluate(model, args.eval_tag)
    sys.exit(0)
gb = args.prompts_per_step * args.group
cfg = GRPOConfig(
    output_dir=args.out, per_device_train_batch_size=1, gradient_accumulation_steps=gb, num_generations=args.group,
    max_steps=args.steps, learning_rate=args.lr, lr_scheduler_type="constant", beta=0.0, temperature=1.0,
    max_completion_length=args.max_completion, bf16=True, gradient_checkpointing=True, logging_steps=1, save_strategy="no",
    report_to="none", seed=args.seed, remove_unused_columns=False, log_completions=False,
)
trainer = GRPOTrainer(model=model, args=cfg, train_dataset=make_dataset(args.steps * args.prompts_per_step + 4), processing_class=tok,
                      reward_funcs=[reward_fn], rollout_func=rollout_func,
                      peft_config=LoraConfig(r=args.lora_r, lora_alpha=2 * args.lora_r,
                                             target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
                                             task_type="CAUSAL_LM"))

if args.dry_rollout:
    prompts = [json.dumps({"family": args.families[0], "difficulty": args.difficulties[0], "seed": TRAIN_LO + k // args.group}) for k in range(gb)]
    t0 = time.time()
    out = rollout_func(prompts, trainer)
    st = rollout_func.last
    print(json.dumps({"seconds": round(time.time() - t0, 1), "episodes": len(prompts), "peak_gpu_gib": round(torch.cuda.max_memory_allocated() / 2**30, 1) if torch.cuda.is_available() else None, "mean_reward": sum(out["episode_reward"]) / len(prompts),
                      "failures": {k: out["failure"].count(k) for k in set(out["failure"])}, "mean_turns": sum(st["turns"]) / len(st["turns"]),
                      "mean_len": sum(st["len"]) / len(st["len"]), "max_len": max(st["len"])}))
    sys.exit(0)

if args.eval_split:  # the LoRA B matrices start at zero, so this is the base model, through the same code path as the trained one
    evaluate(trainer.accelerator.unwrap_model(trainer.model), "base")
t0 = time.time()
trainer.train()
train_seconds = time.time() - t0
trainer.model.save_pretrained(os.path.join(args.out, "adapter"))
if args.eval_split:
    evaluate(trainer.accelerator.unwrap_model(trainer.model), "trained")
log = [h for h in trainer.state.log_history if "loss" in h or "reward" in h or "rewards/reward_fn/mean" in h]
json.dump(trainer.state.log_history, open(os.path.join(args.out, "log_history.json"), "w"), indent=1)
peak = round(torch.cuda.max_memory_allocated() / 2**30, 1) if torch.cuda.is_available() else None
print(json.dumps({"train_seconds": round(train_seconds, 1), "entries": len(log), "peak_gpu_gib": peak, "steps": args.steps,
                  "seconds_per_step": round(train_seconds / max(1, args.steps), 1)}))
