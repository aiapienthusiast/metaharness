#!/usr/bin/env python3
"""Measure the UNTRAINED Qwen3.8-27B on other teams' public OpenEnv Arena envs.

For each registered env (public image + public task list) this script:
  1. pulls the image ANONYMOUSLY (empty DOCKER_CONFIG) and skips it on failure;
  2. runs it in a hardened container (cpus 2, mem 8g, pids 512, cap-drop ALL,
     no-new-privileges, no volumes, no env vars, 127.0.0.1-only random port,
     label ext-eval=1; always removed in finally/atexit/signal);
  3. reads the env's own /schema, builds the same system prompt as
     openenv-arena/scripts/calibrate.py (one JSON action object per reply +
     action schema; user message = JSON observation; thinking off through
     chat_template_kwargs {"enable_thinking": false});
  4. plays episodes over the native OpenEnv WebSocket (/ws), <= 8 steps each,
     up to 24 concurrent workers, with a dollar ledger from provider usage.

The HF token is read inside this process from ${HF_TOKEN_PATH:-${HF_HOME:-
$HOME/.cache/huggingface}/token} (or ARENA_MODEL_API_KEY if already set) and is
only ever used as the Authorization header; it is never printed or stored.

Usage (venv with `websockets`, e.g. /tmp/arena383venv/bin/python):
  ext_env_eval.py --probe                       # start containers, show schema/task ids, no model calls
  ext_env_eval.py --pilot --out DIR             # 1 episode per env (cost calibration)
  ext_env_eval.py --episodes-per-env 96 --seeds 8 --budget 10 --out DIR
  ext_env_eval.py --envs five-desks,audit-trail ...

Safety stops: hard dollar cap (--budget, default 10), HTTP 402 stops at once,
4 consecutive provider failures abort. Never trains, pushes or submits.
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import queue
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from websockets.sync.client import connect

BASE_URL = "https://router.huggingface.co/v1"
MODEL = "Qwen/Qwen3.8-27B:novita"
PRICE_PROMPT = 0.50 / 1e6
PRICE_COMPLETION = 3.20 / 1e6
SYSTEM_PREFIX = ("Solve the task with the available tools. Each reply must be exactly one JSON action "
                 "object, with no markdown. Action schema: ")

HF = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"


@dataclass
class EnvSpec:
    name: str
    image: str
    repo: str | None = None      # public HF dataset holding the task list
    path: str = "tasks.jsonl"
    ids: list | None = None      # explicit ids (when taken from env/docs)


ENVS = [
    EnvSpec("five-desks", "ghcr.io/rca-umb/five-desks:v1", "rca-umb/five-desks"),
    EnvSpec("audit-trail", "ghcr.io/noeflandre/audit-trail:v1", "NoeFlandre/audit-trail"),
    # No public dataset (HF repo returns 401); ids enumerated from the env itself via reset
    # (math-00..07 and caption-00..07 reset OK, media-* and *-08 are rejected).
    EnvSpec("derivation-check", "ghcr.io/noeflandre/derivation-check:v1", None,
            ids=[f"{f}-{i:02d}" for f in ("math", "caption") for i in range(8)]),
    EnvSpec("log-triage", "ghcr.io/noeflandre/log-triage@sha256:3b2a91f3aca7a52d9fb5fea604f961df526f595e9138e0cf71522ea81c939266",
            "NoeFlandre/log-triage"),
    EnvSpec("python-repair-v3", "ghcr.io/louistiti/openenv-python-repair:v3", "Louistiti/openenv-python-repair", "v3/tasks.jsonl"),
    EnvSpec("reconcile-lab", "ghcr.io/qingyuanwunothing/openenv-reconcile-lab@sha256:dd13c35036488a8ac6444a892095c1acdb225f03a783cc794f812b7e91811816",
            "qingyuanwu/reconcile-lab"),
    EnvSpec("trace-path-lab", "docker.io/kshitij190/trace-path-lab@sha256:9dbeab1d60ce2bd3ae1d328ed59457972d7cdaa49b695ca9e6d785109ba648ec",
            "kshitijthakkar/trace-path-lab"),
    EnvSpec("analyst-workbench", "docker.io/aji28/analyst-workbench@sha256:959a21156b3eeecd3bdf42d69f23a354558764b19730400e390eb9c3c5457f40",
            "ajinkyamulay/analyst-workbench", "data/tasks.jsonl"),
    EnvSpec("kvbatch-repair", "docker.io/theykk/kvbatch-repair:v1", "theykk/kvbatch-repair"),
    EnvSpec("ledger-check", "docker.io/theykk/ledger-check:v1", "theykk/ledger-check"),
]

# ---------------------------------------------------------------- containers
_CONTAINERS: list[str] = []
_CLEAN_LOCK = threading.Lock()


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def cleanup_containers():
    with _CLEAN_LOCK:
        ids, _CONTAINERS[:] = list(_CONTAINERS), []
    if ids:
        sh(["docker", "rm", "-f", *ids], timeout=180)


atexit.register(cleanup_containers)


def _die(signum, frame):  # noqa: ARG001
    cleanup_containers()
    os._exit(130)


signal.signal(signal.SIGTERM, _die)
signal.signal(signal.SIGINT, _die)


def anonymous_pull(image: str) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory(prefix="emptydockercfg-") as cfg:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "DOCKER_CONFIG": cfg}
        p = sh(["docker", "pull", "--platform", "linux/amd64", image], env=env, timeout=900)
    return p.returncode == 0, (p.stderr or p.stdout).strip()[-300:]


class Container:
    def __init__(self, env: str, image: str, idx: int):
        self.env, self.image, self.idx = env, image, idx
        self.cid = self.port = self.pid = None
        self.suspicious: set[str] = set()

    def start(self):
        name = f"ext-eval-{self.env}-{self.idx}-{os.getpid()}"
        p = sh(["docker", "run", "-d", "--rm", "--platform", "linux/amd64", "--pull", "never",
                "--name", name, "--cpus", "2", "--memory", "8g", "--pids-limit", "512",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--label", "ext-eval=1",
                "-p", "127.0.0.1::8000", self.image], timeout=120)
        if p.returncode != 0:
            raise RuntimeError("docker run failed: " + p.stderr.strip()[-300:])
        self.cid = p.stdout.strip()
        with _CLEAN_LOCK:
            _CONTAINERS.append(self.cid)
        out = sh(["docker", "port", self.cid, "8000/tcp"]).stdout.split()
        self.port = int(out[-1].rsplit(":", 1)[1])
        self.pid = sh(["docker", "inspect", "-f", "{{.State.Pid}}", self.cid]).stdout.strip()
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if http_json(self.http("/health")) is not None:
                    return self
            except Exception:
                time.sleep(1)
        raise RuntimeError("container never became healthy: " + sh(["docker", "logs", "--tail", "8", self.cid]).stdout[-300:])

    def http(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def ws(self):
        return f"ws://127.0.0.1:{self.port}/ws"

    def netcheck(self):
        """Flag non-loopback outbound TCP from the container netns (host /proc)."""
        for fam in ("tcp", "tcp6"):
            try:
                lines = Path(f"/proc/{self.pid}/net/{fam}").read_text().splitlines()[1:]
            except Exception:
                continue
            for ln in lines:
                f = ln.split()
                lport = int(f[1].split(":")[1], 16)
                rip, st = f[2].split(":")[0], f[3]
                if st in ("01", "02") and lport != 8000:      # ESTABLISHED / SYN_SENT, not inbound
                    if rip not in ("0100007F", "00000000000000000000000001000000"):
                        self.suspicious.add(f"{fam}:{f[2]}")

    def stop(self):
        if self.cid:
            sh(["docker", "rm", "-f", self.cid], timeout=120)
            with _CLEAN_LOCK:
                if self.cid in _CONTAINERS:
                    _CONTAINERS.remove(self.cid)
            self.cid = None


def http_json(url, timeout=10):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as r:
        return json.loads(r.read(8_000_000))


def fetch_ids(spec: EnvSpec):
    if spec.ids is not None:
        return list(spec.ids)
    if not spec.repo:
        return []
    try:
        with urllib.request.urlopen(HF.format(repo=spec.repo, path=spec.path), timeout=60) as r:
            rows = [json.loads(x) for x in r.read().decode().splitlines() if x.strip()]
    except Exception:
        return []
    return [r["task_id"] for r in rows if isinstance(r, dict) and r.get("task_id")]


# ------------------------------------------------------------- provider/ledger
class Ledger:
    def __init__(self, cap):
        self.cap, self.spent, self.inflight = cap, 0.0, 0.0
        self.prompt = self.completion = self.calls = 0
        self.consec_fail = 0
        self.abort: str | None = None
        self.per_env: dict[str, float] = {}
        self.lock = threading.Lock()

    def reserve(self, worst):
        with self.lock:
            if self.abort:
                return False
            if self.spent + self.inflight + worst > self.cap:
                self.abort = "budget_cap"
                return False
            self.inflight += worst
            return True

    def settle(self, worst, env, pt, ct):
        with self.lock:
            self.inflight -= worst
            cost = pt * PRICE_PROMPT + ct * PRICE_COMPLETION
            self.spent += cost
            self.prompt += pt
            self.completion += ct
            self.calls += 1
            self.per_env[env] = self.per_env.get(env, 0.0) + cost
            self.consec_fail = 0
            return cost

    def failed(self, worst, status):
        with self.lock:
            self.inflight -= worst
            self.consec_fail += 1
            if status == 402:
                self.abort = "http_402_credits_exhausted"
            elif self.consec_fail >= 4 and not self.abort:
                self.abort = "4_consecutive_provider_failures"


def load_token():
    tok = os.environ.get("ARENA_MODEL_API_KEY")
    if tok:
        return tok.strip()
    path = os.environ.get("HF_TOKEN_PATH") or os.path.join(
        os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "token")
    return Path(path).read_text().strip()


class Provider:
    def __init__(self, token, ledger, args):
        self.token, self.ledger, self.args = token, ledger, args
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def chat(self, env, messages):
        """Returns (content|None, usage|None, finish_reason, err|None)."""
        a = self.args
        payload = {"model": a.model, "messages": messages, "temperature": a.temperature,
                   "max_tokens": a.max_tokens, "chat_template_kwargs": {"enable_thinking": False}}
        body = json.dumps(payload).encode()
        worst = (len(body) / 3.0) * PRICE_PROMPT + a.max_tokens * PRICE_COMPLETION
        if not self.ledger.reserve(worst):
            return None, None, None, "aborted:" + (self.ledger.abort or "")
        status, err = None, "unknown"
        for attempt in range(3):
            try:
                req = urllib.request.Request(a.base_url.rstrip("/") + "/chat/completions", body,
                                             {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
                with self.opener.open(req, timeout=a.request_timeout) as r:
                    reply = json.loads(r.read(4_000_000))
                ch = reply["choices"][0]
                content = (ch.get("message") or {}).get("content")
                u = reply.get("usage") or {}
                pt, ct = u.get("prompt_tokens"), u.get("completion_tokens")
                est = pt is None or ct is None
                if est:
                    pt = pt if pt is not None else int(len(body) / 3.5)
                    ct = ct if ct is not None else int(len(content or "") / 3.5)
                self.ledger.settle(worst, env, int(pt), int(ct))
                return content, {"prompt_tokens": int(pt), "completion_tokens": int(ct), "estimated": est}, ch.get("finish_reason"), None
            except urllib.error.HTTPError as e:
                status, err = e.code, f"http_{e.code}"
                if e.code == 402 or e.code in (400, 401, 403, 404):
                    break
            except Exception as e:  # timeouts, resets, bad JSON
                status, err = None, type(e).__name__
            time.sleep(2 * (attempt + 1))
        self.ledger.failed(worst, status)
        return None, None, None, err


# ------------------------------------------------------------------ episodes
def observation_text(data: dict) -> str:
    obs = dict(data.get("observation") or {})
    obs["reward"], obs["done"] = data.get("reward"), data.get("done")
    return json.dumps(obs)


def recv(sock, timeout=180):
    return json.loads(sock.recv(timeout=timeout))


def run_episode(c: Container, env: str, schema_action, task_id: str, seed: int, provider: Provider, args) -> dict:
    t0 = time.monotonic()
    rec = {"env": env, "task_id": task_id, "seed": seed, "reward": 0.0, "done": False, "failure": None,
           "replies": 0, "invalid_replies": 0, "fenced_replies": 0, "env_rejected": 0,
           "prompt_tokens": 0, "completion_tokens": 0, "usage_estimated": False, "status": "ok", "cost": 0.0}
    messages = []
    try:
        with connect(c.ws(), proxy=None, open_timeout=20, close_timeout=3, max_size=16_000_000) as sock:
            sock.send(json.dumps({"type": "reset", "data": {"task_id": task_id, "seed": seed}}))
            msg = recv(sock)
            if msg.get("type") != "observation":
                rec.update(status="reset_failed", failure="reset:" + json.dumps(msg)[:200])
                return rec
            data = msg["data"]
            messages = [{"role": "system", "content": SYSTEM_PREFIX + json.dumps(schema_action)},
                        {"role": "user", "content": observation_text(data)}]
            if data.get("done"):
                rec.update(done=True, reward=float(data.get("reward") or 0.0), failure="done_at_reset")
                return rec
            for _ in range(args.max_steps):
                content, usage, finish, err = provider.chat(env, messages)
                if err:
                    rec.update(status="provider_failed" if not err.startswith("aborted") else "aborted", failure=err)
                    return rec
                rec["replies"] += 1
                rec["prompt_tokens"] += usage["prompt_tokens"]
                rec["completion_tokens"] += usage["completion_tokens"]
                rec["usage_estimated"] |= usage["estimated"]
                rec["cost"] += usage["prompt_tokens"] * PRICE_PROMPT + usage["completion_tokens"] * PRICE_COMPLETION
                messages.append({"role": "assistant", "content": content or ""})
                if finish == "length":
                    rec["failure"] = "completion_truncated"
                action = None
                try:
                    action = json.loads(content) if content else None
                except Exception:
                    action = None
                if not isinstance(action, dict):
                    rec["invalid_replies"] += 1
                    s = (content or "").strip()
                    if s.startswith("```"):
                        rec["fenced_replies"] += 1
                    rec["failure"] = rec["failure"] or ("missing_action_content" if not content else "invalid_json_action")
                    break
                sock.send(json.dumps({"type": "step", "data": action}))
                msg = recv(sock)
                if msg.get("type") != "observation":
                    rec["env_rejected"] += 1
                    rec["failure"] = "env_rejected_action:" + json.dumps(msg.get("data"))[:160]
                    break
                data = msg["data"]
                messages.append({"role": "user", "content": observation_text(data)})
                if data.get("done"):
                    rec.update(done=True, reward=float(data.get("reward") or 0.0))
                    break
            else:
                rec["failure"] = rec["failure"] or "step_budget_exhausted"
            if rec["failure"] == "completion_truncated" and rec["done"]:
                rec["failure"] = None
    except Exception as e:
        rec.update(status="error", failure=f"{type(e).__name__}:{str(e)[:160]}")
    finally:
        rec["latency_s"] = round(time.monotonic() - t0, 2)
        rec["messages"] = messages
    return rec


# ---------------------------------------------------------------------- main
def measure_capacity(c: Container, task_id, n=4):
    """How many simultaneous WebSocket sessions does one container accept?"""
    socks, ok = [], 0
    try:
        for i in range(n):
            try:
                s = connect(c.ws(), proxy=None, open_timeout=10, close_timeout=2)
                s.send(json.dumps({"type": "reset", "data": {"task_id": task_id, "seed": 1 + i}}))
                m = recv(s, 30)
                if m.get("type") == "observation":
                    ok += 1
                    socks.append(s)
                else:
                    s.close()
            except Exception:
                break
    finally:
        for s in socks:
            try:
                s.close()
            except Exception:
                pass
    time.sleep(1)
    return max(ok, 1)


def seed_sensitivity(c: Container, task_id):
    """Does the reset observation change with the reset seed? (False => model sampling is the only variance)"""
    seen = []
    for seed in (11, 22):
        try:
            with connect(c.ws(), proxy=None, open_timeout=10, close_timeout=2) as s:
                s.send(json.dumps({"type": "reset", "data": {"task_id": task_id, "seed": seed}}))
                m = recv(s, 30)
                seen.append(json.dumps((m.get("data") or {}).get("observation"), sort_keys=True))
        except Exception:
            return None
    return seen[0] != seen[1]


def pick(ids, n):
    if len(ids) <= n:
        return list(ids)
    return [ids[int(i * len(ids) / n)] for i in range(n)]


class EnvRuntime:
    def __init__(self, spec: EnvSpec):
        self.spec, self.ids, self.skip_reason = spec, [], None
        self.containers: list[Container] = []
        self.slots: queue.Queue = queue.Queue()
        self.schema_action = None
        self.capacity = 1
        self.seed_sensitive = None


def prepare(spec: EnvSpec, args, log) -> EnvRuntime:
    rt = EnvRuntime(spec)
    ok, msg = anonymous_pull(spec.image)
    if not ok:
        rt.skip_reason = "anonymous pull failed: " + msg
        return rt
    rt.ids = fetch_ids(spec)
    try:
        c0 = Container(spec.name, spec.image, 0).start()
        rt.containers.append(c0)
        schema = http_json(c0.http("/schema"))
        rt.schema_action = schema.get("action")
        if not rt.ids:
            rt.ids = discover_ids_from_env(c0)
        if not rt.ids:
            rt.skip_reason = "no task ids found (no public dataset; env does not list them)"
            return rt
        if not rt.schema_action:
            rt.skip_reason = "/schema has no action schema"
            return rt
        rt.capacity = measure_capacity(c0, rt.ids[0]) if not args.probe else 1
    except Exception as e:
        rt.skip_reason = f"container/start error: {e}"
        return rt
    rt.seed_sensitive = seed_sensitivity(rt.containers[0], rt.ids[0])
    log(f"[{spec.name}] ready: {len(rt.ids)} task ids, session capacity/container={rt.capacity}")
    return rt


def discover_ids_from_env(c: Container):
    """Try the env itself: /tasks style endpoints, else a bare reset's observation."""
    for path in ("/tasks", "/task_ids", "/api/tasks", "/openapi.json"):
        try:
            d = http_json(c.http(path), 5)
        except Exception:
            continue
        if path == "/openapi.json":
            continue
        if isinstance(d, list):
            return [x if isinstance(x, str) else x.get("task_id") for x in d if x]
        if isinstance(d, dict):
            for k in ("task_ids", "tasks", "ids"):
                if isinstance(d.get(k), list):
                    return [x if isinstance(x, str) else x.get("task_id") for x in d[k] if x]
    return []


def summarize(env, recs, cost):
    done = [r for r in recs if r["status"] in ("ok", "error") and r["failure"] != "done_at_reset"]
    ok = [r for r in recs if r["status"] == "ok"]
    n = len(ok)
    replies = sum(r["replies"] for r in ok)
    s = {"env": env, "episodes_run": n,
         "episodes_other": {k: sum(1 for r in recs if r["status"] == k) for k in
                            ("reset_failed", "provider_failed", "aborted", "error") if any(r["status"] == k for r in recs)}}
    if n:
        s.update(mean_reward=round(statistics.fmean(r["reward"] for r in ok), 4),
                 share_reward_1=round(sum(1 for r in ok if r["reward"] == 1.0) / n, 4),
                 invalid_reply_share=round(sum(r["invalid_replies"] for r in ok) / max(replies, 1), 4),
                 fenced_reply_share=round(sum(r["fenced_replies"] for r in ok) / max(replies, 1), 4),
                 env_rejected_actions=sum(r["env_rejected"] for r in ok),
                 mean_prompt_tokens=round(statistics.fmean(r["prompt_tokens"] for r in ok), 1),
                 mean_completion_tokens=round(statistics.fmean(r["completion_tokens"] for r in ok), 1),
                 mean_replies=round(replies / n, 2),
                 usage_estimated=any(r["usage_estimated"] for r in ok),
                 tasks_with_episodes=len({r["task_id"] for r in ok}),
                 failures={k: sum(1 for r in ok if (r["failure"] or "").split(":")[0] == k)
                           for k in sorted({(r["failure"] or "").split(":")[0] for r in ok if r["failure"]})})
    s["est_spend_usd"] = round(cost, 4)
    return s


def main(argv=None):
    ap = argparse.ArgumentParser(description="External OpenEnv Arena env evaluator for untrained Qwen3.8-27B")
    ap.add_argument("--envs", help="comma list of env names (default all)")
    ap.add_argument("--out", type=Path, help="output dir for results/episodes (scratchpad recommended)")
    ap.add_argument("--probe", action="store_true", help="start containers and print schema/task info; no model calls")
    ap.add_argument("--pilot", action="store_true", help="1 task x 1 seed per env")
    ap.add_argument("--episodes-per-env", type=int, default=96)
    ap.add_argument("--seeds", type=int, default=8, help="seeds per task id")
    ap.add_argument("--seed-base", type=int, default=9100)
    ap.add_argument("--max-steps", type=int, default=8)
    ap.add_argument("--max-tokens", type=int, default=2048)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--budget", type=float, default=10.0)
    ap.add_argument("--base-url", default=BASE_URL)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--request-timeout", type=int, default=240)
    args = ap.parse_args(argv)

    def log(m):
        print(m, flush=True)

    specs = [s for s in ENVS if not args.envs or s.name in args.envs.split(",")]
    runtimes: dict[str, EnvRuntime] = {}
    try:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for spec, rt in zip(specs, ex.map(lambda s: prepare(s, args, log), specs)):
                runtimes[spec.name] = rt
        for rt in runtimes.values():
            if rt.skip_reason:
                log(f"[{rt.spec.name}] SKIPPED: {rt.skip_reason}")
        if args.probe:
            for rt in runtimes.values():
                if not rt.skip_reason:
                    log(f"[{rt.spec.name}] ids({len(rt.ids)})={rt.ids[:4]} seed_sensitive={rt.seed_sensitive} action_props={list((rt.schema_action or {}).get('properties', {}))}")
            return 0
        token = load_token()
        ledger = Ledger(args.budget)
        provider = Provider(token, ledger, args)
        # replicas so that ~workers/len(envs) sessions can run per env
        live = [rt for rt in runtimes.values() if not rt.skip_reason]
        per_env_workers = max(2, -(-args.workers // max(len(live), 1)) + 1)
        for rt in live:
            want = 1 if args.pilot else max(1, min(4, -(-per_env_workers // rt.capacity)))
            for i in range(1, want):
                rt.containers.append(Container(rt.spec.name, rt.spec.image, i).start())
            for c in rt.containers:
                for _ in range(rt.capacity):
                    rt.slots.put(c)
        seeds = 1 if args.pilot else args.seeds
        chosen, env_seeds = {}, {}
        for rt in live:
            n_fit = max(1, args.episodes_per_env // seeds)
            if args.pilot:
                chosen[rt.spec.name], env_seeds[rt.spec.name] = pick(rt.ids, 1), 1
            elif rt.seed_sensitive is False and len(rt.ids) > n_fit:
                # instance is fixed by the task id: spend episodes on distinct ids instead of repeats
                chosen[rt.spec.name], env_seeds[rt.spec.name] = pick(rt.ids, args.episodes_per_env), 1
            else:
                chosen[rt.spec.name], env_seeds[rt.spec.name] = pick(rt.ids, n_fit), seeds
        jobs = []
        for k in range(seeds):
            for rt in live:
                if k < env_seeds[rt.spec.name]:
                    for tid in chosen[rt.spec.name]:
                        jobs.append((rt, tid, args.seed_base + k))
        log(f"jobs={len(jobs)} envs={len(live)} workers={args.workers} budget=${args.budget}")

        def work(job):
            rt, tid, seed = job
            if ledger.abort:
                return {"env": rt.spec.name, "task_id": tid, "seed": seed, "status": "aborted", "failure": ledger.abort, "messages": [],
                        "reward": 0.0, "replies": 0, "invalid_replies": 0, "fenced_replies": 0, "env_rejected": 0,
                        "prompt_tokens": 0, "completion_tokens": 0, "usage_estimated": False, "cost": 0.0}
            c = rt.slots.get()
            try:
                return run_episode(c, rt.spec.name, rt.schema_action, tid, seed, provider, args)
            finally:
                c.netcheck()
                rt.slots.put(c)

        recs: dict[str, list] = {rt.spec.name: [] for rt in live}
        stop_mon = threading.Event()

        def monitor():
            while not stop_mon.wait(3):
                for rt in live:
                    for c in rt.containers:
                        c.netcheck()
        threading.Thread(target=monitor, daemon=True).start()

        done_n = 0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = [ex.submit(work, j) for j in jobs]
            for f in as_completed(futs):
                r = f.result()
                recs[r["env"]].append(r)
                done_n += 1
                if done_n % 25 == 0 or done_n == len(jobs):
                    log(f"{done_n}/{len(jobs)} episodes, spent ${ledger.spent:.3f}, abort={ledger.abort}")
        stop_mon.set()
        for rt in live:
            for c in rt.containers:
                c.netcheck()
        results = {"model": args.model, "base_url": args.base_url, "thinking": "off", "temperature": args.temperature,
                   "max_tokens": args.max_tokens, "max_steps": args.max_steps, "abort": ledger.abort,
                   "total_est_spend_usd": round(ledger.spent, 4), "prompt_tokens": ledger.prompt,
                   "completion_tokens": ledger.completion, "envs": [], "skipped": {}}
        for rt in runtimes.values():
            if rt.skip_reason:
                results["skipped"][rt.spec.name] = rt.skip_reason
                continue
            s = summarize(rt.spec.name, recs[rt.spec.name], ledger.per_env.get(rt.spec.name, 0.0))
            s.update(image=rt.spec.image, tasks_found=len(rt.ids), tasks_used=len(chosen[rt.spec.name]), seeds_per_task=env_seeds[rt.spec.name],
                     session_capacity_per_container=rt.capacity, reset_varies_with_seed=rt.seed_sensitive,
                     outbound_connections_seen=sorted({x for c in rt.containers for x in c.suspicious}))
            results["envs"].append(s)
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / "results.json").write_text(json.dumps(results, indent=2))
            with open(args.out / "episodes.jsonl", "w") as fh:
                for env_recs in recs.values():
                    for r in env_recs:
                        fh.write(json.dumps(r) + "\n")
        print(json.dumps(results, indent=2))
        return 0
    finally:
        cleanup_containers()


if __name__ == "__main__":
    sys.exit(main())
