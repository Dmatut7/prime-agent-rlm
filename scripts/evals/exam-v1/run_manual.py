#!/usr/bin/env python3
"""Driver for the single-run exams (EX-1, EX-2, EX-4, EX-5).

One headless `--mode json` run with the exam isolation baked in: a per-exam
agent home at <work>/agent-home (examlib.agent_env copies auth.json and
models.json into it), a per-exam session dir, and a per-exam daemon socket
that receives the shutdown envelope after the run. Because the home is
per-exam, distinct work dirs never share a daemon; reusing one home for two
concurrent runs is refused by the daemon (DaemonAgentDirAlreadyRunningError),
so same-home runs must be serial.

Prompt templates may carry <KEY> placeholders, filled with --var KEY=VALUE
(EX-4: REPO, WORK, SESSIONS; EX-5: REPO, WORK).

Usage:
    python3 run_manual.py --work /path/to/exN-work --model provider/model \
        --prompt-file ex2-needles/prompt.txt [--cwd DIR] [--var REPO=/path] \
        [--agent-bin prime-agent] [--timeout 600]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import examlib  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    parser.add_argument("--model", default=None, help="Omit to use the CLI's configured default model")
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--cwd", default=None, help="Agent cwd (default: --work)")
    parser.add_argument("--var", action="append", default=[], help="KEY=VALUE placeholder fill for the prompt")
    parser.add_argument("--agent-bin", default="prime-agent")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    work = Path(args.work).resolve()
    sessions = work / "sessions"
    agent_home = work / "agent-home"
    for directory in (sessions, agent_home):
        directory.mkdir(parents=True, exist_ok=True)
    cwd = Path(args.cwd).resolve() if args.cwd else work

    prompt = Path(args.prompt_file).read_text()
    for pair in args.var:
        key, sep, value = pair.partition("=")
        if not sep:
            parser.error("--var must be KEY=VALUE, got %r" % pair)
        prompt = prompt.replace("<%s>" % key, value)

    env = examlib.agent_env(agent_home, str(sessions))
    command = [
        args.agent_bin, "--mode", "json",
        "--daemon-socket", str(work / "d.sock"),
        "--cwd", str(cwd),
        "--session-dir", str(sessions),
    ]
    if args.model:
        command += ["--model", args.model]
    command += ["--", prompt]

    meta = {"exam": "RUN-MANUAL", "model": args.model, "work": str(work), "cwd": str(cwd)}
    started = time.monotonic()
    with open(work / "agent.log", "w") as log, open(work / "agent.stderr", "w") as err:
        try:
            completed = subprocess.run(command, stdout=log, stderr=err, env=env, timeout=args.timeout)
            meta["exit_code"] = completed.returncode
        except subprocess.TimeoutExpired:
            meta["exit_code"] = None
            meta["timeout"] = args.timeout
    meta["wall_time_s"] = round(time.monotonic() - started, 1)
    examlib.shutdown_daemon(work / "d.sock", retry_window_s=8.0)

    meta["usage"] = examlib.usage_from_json_log((work / "agent.log").read_text())
    (work / "run.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
