#!/usr/bin/env python3
"""Driver for EX-3 (recovery: SIGTERM mid-run, then --resume continuation).

Phase A: launch a headless json-mode run whose prompt requires writing
phase-a.txt (random per-run token) and then appending one line per second to
heartbeat.log, 45 ticks. The driver polls for phase-a.txt + the first
heartbeat, then SIGTERMs the CLI (expected exit 143, print-mode.ts:98), shuts
down the daemon, snapshots phase-a.txt, and resumes the SAME session file
with a phase-B prompt requiring phase-b.txt (token + heartbeat count).

Everything the grader needs lands under --work, except the grading rails,
which live in --rail-dir OUTSIDE the agent-writable work dir (D9):
  fixture/           agent-visible cwd (phase-a.txt, heartbeat.log, phase-b.txt)
  sessions/          session JSONL(s)
  agent-a.log/.stderr, agent-b.log/.stderr
  run.json           launch/exit metadata for both phases
  <rail>/pre-resume.json   token, phase-a sha256, heartbeat count at kill time
  <rail>/run-meta.json     started_at + phase_b_started_at (mtime anchors)

Usage:
    python3 run_ex3.py --work /path/to/ex3-work --rail-dir /path/to/ex3-rail \
        --model anthropic/claude-sonnet-4-5 [--agent-bin prime-agent] [--timeout 600]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import string
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import examlib  # noqa: E402

HEARTBEAT_TICKS = 45

PROMPT_A = """\
You are in a two-phase benchmark run. This is phase A.

1. Create the file phase-a.txt in the current directory containing exactly
   one line: {token}
2. Then append one line per second to heartbeat.log in the current
   directory, exactly {ticks} lines total, each line the text `tick`. A bash
   loop like `for i in $(seq {ticks}); do echo tick >> heartbeat.log; sleep 1; done`
   is fine; run it and wait for it to finish.
3. When the loop has finished, reply with only: PHASE-A-DONE
4. Integrity rules: do not read or execute any grading scripts (the exam's
   grade_*.py), and do not read or modify anything outside the current
   directory.
"""

PROMPT_B = """\
This is phase B of the same benchmark run; the session was interrupted and
resumed. Do NOT redo phase A work: phase-a.txt and heartbeat.log already
exist from before the interruption.

Create phase-b.txt in the current directory with exactly two lines:
  token: <the exact token line that phase-a.txt already holds>
  heartbeat_ticks: <the number of lines heartbeat.log held when phase A was
  interrupted - count what is actually in the file now, do not restart or
  extend the heartbeat loop>

Do not read or execute any grading scripts (the exam's grade_*.py), and do
not read or modify anything outside the current directory.
Then reply with only: PHASE-B-DONE
"""


def random_token(rng: random.Random) -> str:
    return "WK-" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(6))


def wait_for(predicate, timeout_s: float, poll_s: float = 0.5) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(poll_s)
    return False


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def line_count(path: Path) -> int:
    try:
        return len(path.read_text().splitlines())
    except OSError:
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--rail-dir",
        required=True,
        help="Dir OUTSIDE --work for the grading rails (run-meta.json, pre-resume.json); "
        "grade_ex3.py requires it",
    )
    parser.add_argument("--agent-bin", default="prime-agent")
    parser.add_argument("--timeout", type=int, default=600, help="Per-phase timeout seconds")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    work = Path(args.work).resolve()
    try:
        rail = examlib.resolve_rail_dir(args.rail_dir, work)
    except ValueError as exc:
        parser.error(str(exc))
    rail.mkdir(parents=True, exist_ok=True)
    fixture = work / "fixture"
    sessions = work / "sessions"
    agent_home = work / "agent-home"
    for directory in (fixture, sessions, agent_home):
        directory.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed if args.seed is not None else time.time_ns())
    token = random_token(rng)
    meta = {"exam": "EX-3", "model": args.model, "token": token, "work": str(work), "rail_dir": str(rail)}

    env = examlib.agent_env(agent_home, str(sessions))
    prompt_a = PROMPT_A.format(token=token, ticks=HEARTBEAT_TICKS)

    # Written before the agent launches: the grader anchors its rail mtime
    # rule on started_at (and on phase_b_started_at below). D9.
    examlib.record_run_meta(rail, exam="EX-3", model=args.model, work=str(work), started_at=time.time())

    # ---- phase A: run until phase-a.txt + first heartbeat, then SIGTERM ----
    sock_a = work / "d1.sock"
    with open(work / "agent-a.log", "w") as log_a, open(work / "agent-a.stderr", "w") as err_a:
        proc = subprocess.Popen(
            [
                args.agent_bin, "--mode", "json",
                "--daemon-socket", str(sock_a),
                "--cwd", str(fixture),
                "--session-dir", str(sessions),
                "--model", args.model,
                "--", prompt_a,
            ],
            stdout=log_a, stderr=err_a, env=env,
        )
        observed = wait_for(
            lambda: (fixture / "phase-a.txt").is_file()
            and token in (fixture / "phase-a.txt").read_text()
            and line_count(fixture / "heartbeat.log") >= 1,
            timeout_s=args.timeout,
        )
        meta["phase_a_observed_artifacts"] = observed
        if observed and proc.poll() is None:
            proc.terminate()  # SIGTERM -> expected exit 143
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=30)
        meta["phase_a_exit_code"] = proc.returncode
    examlib.shutdown_daemon(sock_a, retry_window_s=8.0)

    # ---- snapshot pre-resume state (a grading rail: outside the work dir) ----
    pre = {
        "token": token,
        "phase_a_sha256": sha256_file(fixture / "phase-a.txt") if (fixture / "phase-a.txt").is_file() else None,
        "heartbeat_lines_at_kill": line_count(fixture / "heartbeat.log"),
    }
    (rail / "pre-resume.json").write_text(json.dumps(pre, indent=2) + "\n")

    session_file = examlib.latest_session_file(sessions)
    meta["resumed_session_file"] = str(session_file) if session_file else None

    # ---- phase B: resume the same session file ----
    meta["phase_b_exit_code"] = None
    if session_file is not None:
        sock_b = work / "d2.sock"
        # Recorded after the pre-resume snapshot, before the phase-B agent
        # launches: the grader rejects a pre-resume.json touched after this.
        examlib.record_run_meta(rail, phase_b_started_at=time.time())
        with open(work / "agent-b.log", "w") as log_b, open(work / "agent-b.stderr", "w") as err_b:
            completed = subprocess.run(
                [
                    args.agent_bin, "--mode", "json",
                    "--daemon-socket", str(sock_b),
                    "--cwd", str(fixture),
                    "--session-dir", str(sessions),
                    "--model", args.model,
                    "--resume", str(session_file),
                    "--", PROMPT_B,
                ],
                stdout=log_b, stderr=err_b, env=env, timeout=args.timeout,
            )
            meta["phase_b_exit_code"] = completed.returncode
        examlib.shutdown_daemon(sock_b, retry_window_s=8.0)

    meta["usage_phase_a"] = examlib.usage_from_json_log((work / "agent-a.log").read_text())
    meta["usage_phase_b"] = (
        examlib.usage_from_json_log((work / "agent-b.log").read_text()) if (work / "agent-b.log").is_file() else {}
    )
    (work / "run.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
