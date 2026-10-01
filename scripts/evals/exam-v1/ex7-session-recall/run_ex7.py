#!/usr/bin/env python3
"""Driver for EX-7 (multi-prompt in-session recall with a superseded fact).

One headless json-mode run, seven positional prompts sent sequentially in a
single session (positional args -> messages[], args.ts:234/465; print-mode.ts
sends them in order). Prompts 1-6 each plant one FACT-n token; prompt 5 also
supersedes FACT-2 with a new value. Prompt 7 demands facts.json holding only
FACT-2, FACT-4, FACT-5 at their CURRENT values.

Usage:
    python3 run_ex7.py --work /path/to/ex7-work --model anthropic/claude-sonnet-4-5 \
        [--agent-bin prime-agent] [--timeout 600] [--seed 20261002]
"""
from __future__ import annotations

import argparse
import json
import random
import string
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402

QUERY_KEYS = ["FACT-2", "FACT-4", "FACT-5"]
SUPERSEDED_KEY = "FACT-2"


def token(rng: random.Random) -> str:
    return "TK-" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(6))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--agent-bin", default="prime-agent")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--seed", type=int, default=20261002)
    args = parser.parse_args()

    work = Path(args.work).resolve()
    fixture = work / "fixture"
    sessions = work / "sessions"
    agent_home = work / "agent-home"
    for directory in (fixture, sessions, agent_home):
        directory.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)
    facts = {"FACT-{}".format(i): token(rng) for i in range(1, 7)}
    superseded = token(rng)
    final_values = dict(facts)
    final_values[SUPERSEDED_KEY] = superseded

    prompts = []
    for index in range(1, 7):
        key = "FACT-{}".format(index)
        line = "Remember {}: {}.".format(key, facts[key])
        if index == 5:
            line += " Also: {} is now {}, superseding the earlier value.".format(SUPERSEDED_KEY, superseded)
        prompts.append(line + " Reply with only OK.")
    prompts.append(
        "Write the file facts.json in the current directory: a JSON object mapping exactly the keys "
        + ", ".join(QUERY_KEYS)
        + " to their current values (use the superseding value where one was given). "
        "Then reply with only DONE."
    )

    meta = {
        "exam": "EX-7",
        "model": args.model,
        "work": str(work),
        "prompts": len(prompts),
        "expected": {key: final_values[key] for key in QUERY_KEYS},
        "superseded_value": facts[SUPERSEDED_KEY],
    }

    env = examlib.agent_env(agent_home, str(sessions))
    sock = work / "d.sock"
    started = time.monotonic()
    with open(work / "agent.log", "w") as log, open(work / "agent.stderr", "w") as err:
        completed = subprocess.run(
            [
                args.agent_bin, "--mode", "json",
                "--daemon-socket", str(sock),
                "--cwd", str(fixture),
                "--session-dir", str(sessions),
                "--model", args.model,
                "--",
            ]
            + prompts,
            stdout=log, stderr=err, env=env, timeout=args.timeout,
        )
        meta["exit_code"] = completed.returncode
    meta["wall_time_s"] = round(time.monotonic() - started, 1)
    examlib.shutdown_daemon(sock, retry_window_s=8.0)

    meta["usage"] = examlib.usage_from_json_log((work / "agent.log").read_text())
    (work / "run.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
