"""Model-free self-tests for the exam-v1 pack.

Bidirectional grader checks: every grader must accept a gold sample and
reject wrong samples, and the wave-11 baseline defects (D1-D6, recorded in
README.md) plus the wave-15 integrity defect (D9) must stay fixed:

  D1  EX-2 answers.json lives at fixture/answers.json (one level above
      docs/, as the prompt states), not at the work root.
  D2  ex2-needles/prompt.txt defines the answers.json key format with a
      concrete example whose key drops the NEEDLE- prefix.
  D3  EX-4/EX-5 repo-untouched rails attribute git drift through the agent's
      write-path set (--agent-log); foreign-lane drift no longer fails a run.
  D4  examlib.agent_env copies models.json (custom-provider credentials)
      alongside auth.json, file-to-file.
  D5  README documents that one agent home serves one daemon at a time.
  D6  ex5-sigterm/prompt.txt forbids executing the CLI under test.
  D9  Grading rails (git-status-pre.txt, pre-resume.json, run-meta.json,
      agent.log) live in a --rail-dir OUTSIDE the agent-writable work dir;
      graders fail closed when the rail dir overlaps the work dir, when
      run-meta.json is missing, or when a rail file's mtime postdates the
      run start the driver recorded (the wave-15 incident: the agent
      overwrote the pre-run snapshot mid-run, then self-ran the grader).

No agent, model, or network is invoked. Python 3.9 stdlib only.

Run from the pack root:
    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK / "lib"))
import examlib  # noqa: E402

NEEDLE_RE = re.compile(r"^NEEDLE-([A-Z]+-\d) = (\d{5})$", re.MULTILINE)

# Fake-repo source constants: deliberately different from the real repo's
# values so a grader that stops recomputing (or a test that hardcodes the
# real repo) fails loud.
FAKE_DPV = 71
FAKE_DSR = 144
FAKE_KPV = 41
FAKE_KMIN = 31
FAKE_KDEF = 33
FAKE_KHB = 5123
FAKE_KENV = "KERNEL_HEARTBEAT_TEST_MS"
FAKE_SIGINT = 131
FAKE_SIGHUP = 128
FAKE_SIGTERM = 144

FAKE_DAEMON_PROTOCOL_TS = (
    "export const DAEMON_PROTOCOL_VERSION = %d;\n" % FAKE_DPV
    + "export const DAEMON_SCHEMA_REVISION = %d;\n" % FAKE_DSR
)
FAKE_REPL_PY = (
    "PROTOCOL_VERSION = %d\n" % FAKE_KPV
    + "MIN_PROTOCOL_VERSION = %d\n" % FAKE_KMIN
    + "DEFAULT_PROTOCOL_VERSION = %d\n" % FAKE_KDEF
    + 'HEARTBEAT_INTERVAL_ENV_VAR = "%s"\n' % FAKE_KENV
    + "DEFAULT_HEARTBEAT_INTERVAL_MS = %d\n" % FAKE_KHB
)
FAKE_PRINT_MODE_TS = (
    "function onSignal(signal: string): void {\n"
    '    const exitCode = signal === "SIGINT" ? %d : signal === "SIGHUP" ? %d : %d;\n'
    % (FAKE_SIGINT, FAKE_SIGHUP, FAKE_SIGTERM)
    + "    disposeConnection();\n"
    + "    process.exit(exitCode);\n"
    + "}\n"
)


def run_grader(script: str, *args: str):
    proc = subprocess.run(
        [sys.executable, str(PACK / script)] + list(args),
        capture_output=True,
        text=True,
        timeout=120,
    )
    try:
        verdict = json.loads(proc.stdout)
    except ValueError:
        verdict = None
    return proc.returncode, verdict, proc.stderr


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo)] + list(args), capture_output=True, text=True, timeout=30
    )
    if proc.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout


def make_fake_repo(root: Path) -> Path:
    repo = root / "fake-repo"
    daemon = repo / "packages/coding-agent/src/modes/daemon"
    modes = repo / "packages/coding-agent/src/modes"
    repl = repo / "prime-agent-runtime/src/rlm"
    for directory in (daemon, modes, repl):
        directory.mkdir(parents=True, exist_ok=True)
    (daemon / "daemon-protocol.ts").write_text(FAKE_DAEMON_PROTOCOL_TS)
    (modes / "print-mode.ts").write_text(FAKE_PRINT_MODE_TS)
    (repl / "repl.py").write_text(FAKE_REPL_PY)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=exam", "-c", "user.email=exam@test", "commit", "-qm", "init")
    return repo


def snapshot_pre_status(repo: Path, dest: Path) -> None:
    dest.write_text(git(repo, "status", "--porcelain"))


def agent_log_text(cwd, calls) -> str:
    lines = [
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": "selftest",
                "timestamp": "2026-10-02T00:00:00.000Z",
                "cwd": str(cwd),
                "rlmDepth": 0,
            }
        )
    ]
    for index, (name, args) in enumerate(calls):
        lines.append(
            json.dumps(
                {
                    "type": "tool_execution_start",
                    "toolCallId": "call_%d" % index,
                    "toolName": name,
                    "args": args,
                }
            )
        )
    return "\n".join(lines) + "\n"


def read_only_call(repo: Path):
    target = repo / "packages/coding-agent/src/modes/daemon/daemon-protocol.ts"
    return (
        "ipython",
        {"code": "from pathlib import Path\nprint(Path(%r).read_text()[:80])" % str(target)},
    )


class ExamlibTest(unittest.TestCase):
    def test_agent_env_copies_credentials_and_strips_leaks(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source-home"
            source.mkdir()
            (source / "auth.json").write_text('{"auth": true}')
            (source / "models.json").write_text('{"providers": {}}')
            home = Path(tmp) / "agent-home"
            sessions = str(Path(tmp) / "sessions")
            patched = {
                "PRIME_AGENT_CODING_AGENT_DIR": str(source),
                "RLM_DEPTH": "1",
                "RLM_SESSION_DIR": "/leak",
                "RLM_MAX_DEPTH": "2",
                "PRIME_AGENT_INTERNAL_TOKEN": "x",
                "PATH": os.environ.get("PATH", ""),
            }
            with unittest.mock.patch.dict(os.environ, patched, clear=True):
                env = examlib.agent_env(home, sessions)
            self.assertEqual((home / "auth.json").read_text(), '{"auth": true}')
            # D4: custom providers inline their credentials in models.json.
            self.assertEqual((home / "models.json").read_text(), '{"providers": {}}')
            self.assertEqual(env["PRIME_AGENT_CODING_AGENT_DIR"], str(home))
            self.assertEqual(env["PRIME_AGENT_SESSION_DIR"], sessions)
            for leaked in ("RLM_DEPTH", "RLM_SESSION_DIR", "RLM_MAX_DEPTH", "PRIME_AGENT_INTERNAL_TOKEN"):
                self.assertNotIn(leaked, env)

    def test_usage_from_json_log(self):
        log = "\n".join(
            [
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "usage": {"totalTokens": 100}},
                    }
                ),
                "not json",
                json.dumps({"type": "message_end", "message": {"role": "user"}}),
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "usage": {"totalTokens": 50}},
                    }
                ),
            ]
        )
        self.assertEqual(examlib.usage_from_json_log(log), {"tokens": 150, "turns": 2})

    def test_porcelain_paths(self):
        text = ' M src/a.ts\n?? docs/b.md\nR  old/name.ts -> new/name.ts\n?? "sp ace/x.txt"\n'
        self.assertEqual(
            examlib.porcelain_paths(text),
            {"src/a.ts", "docs/b.md", "old/name.ts", "new/name.ts", "sp ace/x.txt"},
        )
        self.assertEqual(examlib.porcelain_paths(""), set())

    def test_repo_write_paths_from_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "src").mkdir(parents=True)
            (repo / "src/a.ts").write_text("a")
            cwd = Path(tmp) / "work"
            cwd.mkdir()
            target = str(repo / "src/a.ts")

            read_only = agent_log_text(cwd, [read_only_call(repo)])
            self.assertEqual(examlib.repo_write_paths_from_log(read_only, repo), set())

            written = agent_log_text(
                cwd, [("ipython", {"code": "from pathlib import Path\nPath(%r).write_text('x')" % target})]
            )
            self.assertEqual(examlib.repo_write_paths_from_log(written, repo), {"src/a.ts"})

            write_tool = agent_log_text(cwd, [("write", {"path": target, "content": "x"})])
            self.assertEqual(examlib.repo_write_paths_from_log(write_tool, repo), {"src/a.ts"})

            bash_redirect = agent_log_text(cwd, [("bash", {"command": "echo hi > %s" % target})])
            self.assertEqual(examlib.repo_write_paths_from_log(bash_redirect, repo), {"src/a.ts"})

            # wave-11 regression: grep with 2>/dev/null is a read, not a write;
            # only the segment carrying the redirect may attribute paths.
            grep_null = agent_log_text(
                cwd,
                [("bash", {"command": "grep -n sig %s 2>/dev/null | head; echo done > /tmp/out.txt" % target})],
            )
            self.assertEqual(examlib.repo_write_paths_from_log(grep_null, repo), set())

            # Segment scoping: the read segment does not attribute, the write
            # segment does.
            mixed_line = agent_log_text(
                cwd,
                [("bash", {"command": "grep -n sig %s; echo done > %s" % (str(repo / "src/other.ts"), target)})],
            )
            self.assertEqual(examlib.repo_write_paths_from_log(mixed_line, repo), {"src/a.ts"})

            outside = agent_log_text(
                cwd,
                [
                    (
                        "ipython",
                        {
                            "code": "from pathlib import Path\n"
                            + "Path(%r).write_text('x')\n" % str(Path(tmp) / "outside.txt")
                            + "print(Path(%r).read_text())" % target
                        },
                    )
                ],
            )
            # The repo path is only read inside a cell that writes elsewhere:
            # mentioning it must not attribute it.
            self.assertEqual(examlib.repo_write_paths_from_log(outside, repo), set())

            nested = json.dumps(
                {
                    "type": "message_update",
                    "message": {"role": "assistant"},
                    "assistantMessageEvent": {
                        "type": "toolcall_end",
                        "toolCall": {"type": "toolCall", "id": "c9", "name": "edit", "arguments": {"path": target}},
                    },
                }
            )
            nested_log = agent_log_text(cwd, []) + nested + "\n"
            self.assertEqual(examlib.repo_write_paths_from_log(nested_log, repo), {"src/a.ts"})

    def test_resolve_rail_dir_refuses_overlap_with_work(self):
        # D9: everything under --work is agent-writable, so a rail dir that
        # nests either way is forgeable and refused; a sibling is fine.
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "work"
            work.mkdir()
            sibling = Path(tmp) / "rail"
            self.assertEqual(examlib.resolve_rail_dir(sibling, work), sibling.resolve())
            for bad in (work, work / "rail", Path(tmp)):
                with self.assertRaises(ValueError, msg=str(bad)):
                    examlib.resolve_rail_dir(bad, work)

    def test_record_and_read_run_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            rail = Path(tmp) / "rail"
            rail.mkdir()
            examlib.record_run_meta(rail, exam="EX-TEST", started_at=1000.5)
            examlib.record_run_meta(rail, phase_b_started_at=1001.5)
            meta = examlib.read_run_meta(rail)
            self.assertEqual(meta["exam"], "EX-TEST")
            self.assertEqual(meta["started_at"], 1000.5)
            # Later driver phases merge into the same record.
            self.assertEqual(meta["phase_b_started_at"], 1001.5)
            self.assertEqual(examlib.epoch_field(meta, "started_at"), 1000.5)
            self.assertIsNone(examlib.epoch_field(meta, "missing"))
            self.assertIsNone(examlib.epoch_field({"flag": True}, "flag"))
            self.assertIsNone(examlib.epoch_field({"s": "1000"}, "s"))
        self.assertEqual(examlib.read_run_meta(Path(tmp) / "nonexistent"), {})

    def test_verify_rail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            work.mkdir()
            rail = root / "rail"
            rail.mkdir()
            pre = rail / "git-status-pre.txt"
            log = rail / "agent.log"
            pre.write_text("pre\n")
            log.write_text("log\n")
            started_at = time.time() - 60
            old = started_at - 60
            os.utime(pre, (old, old))
            files = [("pre_status", "git-status-pre.txt", started_at), ("agent_log", "agent.log", None)]

            checks = examlib.verify_rail(rail, work, files)
            self.assertTrue(checks["rail_ok"], checks)
            self.assertTrue(checks["rail_dir_outside_work"])
            self.assertTrue(checks["rail_pre_status_present"])
            self.assertTrue(checks["rail_pre_status_predates_run"])
            self.assertTrue(checks["rail_agent_log_present"])

            # D9 incident shape: the snapshot rewritten after the run started.
            pre.write_text("forged mid-run\n")
            checks = examlib.verify_rail(rail, work, files)
            self.assertFalse(checks["rail_ok"])
            self.assertFalse(checks["rail_pre_status_predates_run"])

            # A missing rail file fails closed.
            pre.unlink()
            checks = examlib.verify_rail(rail, work, files)
            self.assertFalse(checks["rail_ok"])
            self.assertFalse(checks["rail_pre_status_present"])
            self.assertFalse(checks["rail_pre_status_predates_run"])

            # A rail dir reachable by the agent is no rail.
            inner = work / "rail"
            inner.mkdir()
            (inner / "git-status-pre.txt").write_text("pre\n")
            checks = examlib.verify_rail(inner, work, [("pre_status", "git-status-pre.txt", None)])
            self.assertFalse(checks["rail_dir_outside_work"])
            self.assertFalse(checks["rail_ok"])


class Ex1Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / "ex1"
        proc = subprocess.run(
            [sys.executable, str(PACK / "ex1-pipeline/gen_ex1.py"), "--out", str(self.work), "--seed", "20261002"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def tearDown(self):
        self.tmp.cleanup()

    def fix_script(self, crashes_only: bool) -> None:
        path = self.work / "fixture" / "analyze.py"
        src = path.read_text()
        original = src
        src, n = re.subn(
            r'    return int\(row\["units"\]\)\n',
            '    return int(row["units"]) if row["units"] else 0\n',
            src,
        )
        self.assertEqual(n, 1, "gen_ex1 template drifted (units_of)")
        src, n = re.subn(
            r'    return int\(row\["units"\]\) \* int\(round\(float\(row\["price"\]\) \* 100\)\)\n',
            '    return (int(row["units"]) if row["units"] else 0)'
            ' * int(round(float(row["price"].lstrip("$")) * 100))\n',
            src,
        )
        self.assertEqual(n, 1, "gen_ex1 template drifted (revenue_cents)")
        if not crashes_only:
            src, n = re.subn(r"q1_rev \+ q1_rev", "q1_rev + q2_rev", src)
            self.assertEqual(n, 1, "gen_ex1 template drifted (doubled q1)")
        self.assertNotEqual(src, original)
        path.write_text(src)

    def grade(self):
        return run_grader("ex1-pipeline/grade_ex1.py", "--work", str(self.work))

    def test_gold_passes(self):
        self.fix_script(crashes_only=False)
        code, verdict, err = self.grade()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))

    def test_unfixed_fails(self):
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["script_exit_zero"])

    def test_crash_only_fix_fails_on_values(self):
        self.fix_script(crashes_only=True)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertTrue(verdict["checks"]["script_exit_zero"])
        self.assertFalse(verdict["checks"]["values"]["total_revenue_cents"])


class Ex2Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / "ex2"
        proc = subprocess.run(
            [sys.executable, str(PACK / "ex2-needles/gen_ex2.py"), "--out", str(self.work), "--seed", "20261002"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Independent recompute (same rule, written here, not imported).
        needles = {}
        for doc in sorted((self.work / "fixture" / "docs").glob("*.md")):
            for match in NEEDLE_RE.finditer(doc.read_text()):
                needles[match.group(1)] = int(match.group(2))
        self.assertGreater(len(needles), 0)
        self.truth = {"needles": needles, "total": sum(needles.values())}

    def tearDown(self):
        self.tmp.cleanup()

    def write_answers(self, answers, where: str = "fixture") -> None:
        # The prompt says "the repository root (one level above docs/)", which
        # is fixture/ when the agent's cwd is fixture/.
        (self.work / where / "answers.json").write_text(json.dumps(answers, indent=2) + "\n")

    def grade(self):
        return run_grader("ex2-needles/grade_ex2.py", "--work", str(self.work))

    def test_gold_passes(self):
        self.write_answers(self.truth)
        code, verdict, err = self.grade()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))

    def test_gold_keys_have_no_needle_prefix(self):
        for key in self.truth["needles"]:
            self.assertRegex(key, r"^[A-Z]+-\d$")

    def test_wrong_value_fails(self):
        answers = json.loads(json.dumps(self.truth))
        key = sorted(answers["needles"])[0]
        answers["needles"][key] += 1
        self.write_answers(answers)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["per_needle"][key])

    def test_prefixed_keys_fail_as_extra_ids(self):
        # D2 semantics lock: NEEDLE-<ID> keys are wrong, the prefix is not
        # part of the id.
        answers = {"needles": {"NEEDLE-" + k: v for k, v in self.truth["needles"].items()}, "total": self.truth["total"]}
        self.write_answers(answers)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertGreater(len(verdict["checks"]["extra_ids"]), 0)

    def test_swallowed_distractor_fails(self):
        answers = json.loads(json.dumps(self.truth))
        answers["needles"]["ZULU-0"] = 12345
        self.write_answers(answers)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])

    def test_prompt_defines_key_format_with_example(self):
        # D2: the prompt must show one concrete entry whose key drops the
        # NEEDLE- prefix, and say so in words.
        prompt = (PACK / "ex2-needles/prompt.txt").read_text()
        self.assertRegex(prompt, r'"[A-Z]+-\d":\s*\d{5}')
        self.assertIn("without the needle- prefix", prompt.lower())


class Ex3Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.work = self.root / "ex3"
        # D9: the pre-resume snapshot is a grading rail and lives outside the
        # agent-writable work dir.
        self.rail = self.root / "ex3-rail"
        self.rail.mkdir()
        fixture = self.work / "fixture"
        fixture.mkdir(parents=True)
        self.token = "WK-AAAA00"
        (fixture / "phase-a.txt").write_text(self.token + "\n")
        (fixture / "heartbeat.log").write_text("tick\n" * 7)
        (fixture / "phase-b.txt").write_text("token: %s\nheartbeat_ticks: 7\n" % self.token)
        self.run = {
            "exam": "EX-3",
            "token": self.token,
            "phase_a_observed_artifacts": True,
            "phase_a_exit_code": 143,
            "phase_b_exit_code": 0,
        }
        self.pre = {
            "token": self.token,
            "phase_a_sha256": hashlib.sha256((self.token + "\n").encode()).hexdigest(),
            "heartbeat_lines_at_kill": 7,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def write_legit_rail(self, pre=None) -> None:
        # Driver order: snapshot the pre-resume state, then record the
        # phase-B launch time over it.
        (self.rail / "pre-resume.json").write_text(json.dumps(pre or self.pre, indent=2) + "\n")
        examlib.record_run_meta(self.rail, exam="EX-3", started_at=time.time() - 120)
        examlib.record_run_meta(self.rail, phase_b_started_at=time.time())

    def grade(self, run=None):
        (self.work / "run.json").write_text(json.dumps(run or self.run))
        return run_grader(
            "ex3-recovery/grade_ex3.py", "--work", str(self.work), "--rail-dir", str(self.rail)
        )

    def test_gold_passes(self):
        self.write_legit_rail()
        code, verdict, err = self.grade()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["rail_ok"], json.dumps(verdict))

    def test_wrong_tick_count_fails(self):
        self.write_legit_rail()
        (self.work / "fixture" / "phase-b.txt").write_text("token: %s\nheartbeat_ticks: 8\n" % self.token)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["phase_b_ticks_ok"])

    def test_rewritten_phase_a_fails(self):
        self.write_legit_rail()
        (self.work / "fixture" / "phase-a.txt").write_text(self.token + "\nredone\n")
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["phase_a_untouched"])

    def test_uninterrupted_phase_a_fails(self):
        self.write_legit_rail()
        run = dict(self.run, phase_a_exit_code=0)
        code, verdict, err = self.grade(run=run)
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["phase_a_interrupted"])

    def test_tampered_pre_resume_grades_red(self):
        # D9: pre-resume.json rewritten after the phase-B launch voids the
        # run even when the tampered content is self-consistent with the
        # agent's (wrong) phase-b.txt - the mtime rule, not the content,
        # catches it.
        tampered = dict(self.pre, heartbeat_lines_at_kill=8)
        examlib.record_run_meta(self.rail, exam="EX-3", started_at=time.time() - 120)
        examlib.record_run_meta(self.rail, phase_b_started_at=time.time() - 60)
        (self.rail / "pre-resume.json").write_text(json.dumps(tampered, indent=2) + "\n")
        (self.work / "fixture" / "phase-b.txt").write_text("token: %s\nheartbeat_ticks: 8\n" % self.token)
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertTrue(verdict["checks"]["phase_b_ticks_ok"], json.dumps(verdict))
        self.assertFalse(verdict["checks"]["rail_pre_resume_predates_run"])
        self.assertFalse(verdict["checks"]["rail_ok"])

    def test_missing_rail_files_grade_red(self):
        # No run-meta.json and no pre-resume.json: fail closed, no crash.
        code, verdict, err = self.grade()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_run_meta_present"])
        self.assertFalse(verdict["checks"]["rail_pre_resume_present"])
        self.assertFalse(verdict["checks"]["rail_ok"])
        self.assertFalse(verdict["checks"]["phase_b_correct"])


class Ex4Ex5Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = make_fake_repo(self.root)
        self.work = self.root / "work"
        self.sessions = self.work / "sessions"
        self.sessions.mkdir(parents=True)
        # D9: rails (pre-run snapshot, run metadata, agent log) live outside
        # the agent-writable work dir; the prompt never names this path.
        self.rail = self.root / "rail"
        self.rail.mkdir()
        self.pre_status = self.rail / "git-status-pre.txt"
        self.agent_log = self.rail / "agent.log"

    def tearDown(self):
        self.tmp.cleanup()

    def start_run(self, started_at=None) -> None:
        # The driver's rail-side record, written before the agent launches.
        examlib.record_run_meta(
            self.rail,
            exam="RUN-MANUAL",
            work=str(self.work),
            started_at=time.time() if started_at is None else started_at,
        )

    def write_log(self, calls) -> None:
        self.agent_log.write_text(agent_log_text(self.work, calls))

    def grade_ex4(self):
        return run_grader(
            "ex4-repo-facts/grade_ex4.py",
            "--repo",
            str(self.repo),
            "--work",
            str(self.work),
            "--sessions-dir",
            str(self.sessions),
            "--rail-dir",
            str(self.rail),
        )

    def grade_ex5(self):
        return run_grader(
            "ex5-sigterm/grade_ex5.py",
            "--repo",
            str(self.repo),
            "--work",
            str(self.work),
            "--rail-dir",
            str(self.rail),
        )

    def expected_ex4(self):
        return {
            "daemon_protocol_version": FAKE_DPV,
            "daemon_schema_revision": FAKE_DSR,
            "kernel_protocol_version": FAKE_KPV,
            "kernel_min_protocol": FAKE_KMIN,
            "kernel_default_protocol": FAKE_KDEF,
            "kernel_heartbeat_interval_ms": FAKE_KHB,
            "kernel_heartbeat_env_var": FAKE_KENV,
            # Independent recompute of the ledger digest contract.
            "ledger_digest": hashlib.sha256(os.path.realpath(str(self.sessions)).encode("utf-8")).hexdigest()[:16],
        }

    def expected_ex5(self):
        return {
            "sigint_exit": FAKE_SIGINT,
            "sighup_exit": FAKE_SIGHUP,
            "sigterm_exit": FAKE_SIGTERM,
            "file": "packages/coding-agent/src/modes/print-mode.ts",
        }


class Ex4Test(Ex4Ex5Base):
    def test_gold_passes(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["rail_ok"], json.dumps(verdict))

    def test_stale_value_fails(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        answers = self.expected_ex4()
        answers["daemon_schema_revision"] = FAKE_DSR - 1
        (self.work / "answers.json").write_text(json.dumps(answers))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["per_key"]["daemon_schema_revision"])

    def test_foreign_lane_drift_does_not_fail(self):
        # D3: a path another lane dirtied mid-run is reported, not blamed.
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        drift = self.repo / "packages/coding-agent/src/other-lane.ts"
        drift.write_text("// written by a parallel lane\n")
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["repo_untouched"])
        self.assertEqual(verdict["checks"]["foreign_drift"], ["packages/coding-agent/src/other-lane.ts"])

    def test_drifted_path_read_by_agent_stays_foreign(self):
        # Reading a repo file never attributes its drift to the agent. The
        # drift appends a comment, so recomputed values are unchanged and the
        # run passes with the drift reported as foreign.
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        drifted = self.repo / "packages/coding-agent/src/modes/daemon/daemon-protocol.ts"
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        drifted.write_text(FAKE_DAEMON_PROTOCOL_TS + "// parallel-lane edit\n")
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["repo_untouched"])
        self.assertEqual(
            verdict["checks"]["foreign_drift"], ["packages/coding-agent/src/modes/daemon/daemon-protocol.ts"]
        )

    def test_agent_repo_write_is_blamed(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        target = self.repo / "packages/coding-agent/src/modes/daemon/daemon-protocol.ts"
        self.write_log(
            [
                read_only_call(self.repo),
                ("ipython", {"code": "from pathlib import Path\nPath(%r).write_text('x')" % str(target)}),
            ]
        )
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        target.write_text(FAKE_DAEMON_PROTOCOL_TS + "// agent edit\n")
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["repo_untouched"])
        self.assertEqual(
            verdict["checks"]["agent_repo_writes"], ["packages/coding-agent/src/modes/daemon/daemon-protocol.ts"]
        )

    def test_preexisting_dirty_file_is_not_drift(self):
        dirty = self.repo / "packages/coding-agent/src/modes/print-mode.ts"
        dirty.write_text(FAKE_PRINT_MODE_TS + "// already dirty before the run\n")
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))

    def test_forged_pre_status_mid_run_grades_red(self):
        # D9 incident replay (wave-15, claude line): the agent overwrote the
        # pre-run snapshot with a mid-run `git status`, erasing the drift the
        # rail would have reported. The mtime rule voids the run even though
        # pre and post now agree.
        now = time.time()
        snapshot_pre_status(self.repo, self.pre_status)
        os.utime(self.pre_status, (now - 120, now - 120))  # operator snapshotted pre-launch
        self.start_run(started_at=now - 60)
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        drift = self.repo / "packages/coding-agent/src/other-lane.ts"
        drift.write_text("// drift the agent wants to hide\n")
        snapshot_pre_status(self.repo, self.pre_status)  # the forgery: pre := post
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_pre_status_predates_run"])
        self.assertFalse(verdict["checks"]["rail_ok"])
        self.assertFalse(verdict["checks"]["repo_untouched"])

    def test_rail_dir_inside_work_grades_red(self):
        # A rail the agent can reach is no rail: refuse to grade on it even
        # when every file inside is consistent.
        self.rail = self.work / "rail"
        self.rail.mkdir()
        self.pre_status = self.rail / "git-status-pre.txt"
        self.agent_log = self.rail / "agent.log"
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_dir_outside_work"])
        self.assertFalse(verdict["checks"]["rail_ok"])
        self.assertFalse(verdict["checks"]["repo_untouched"])

    def test_missing_run_meta_grades_red(self):
        # Without the driver's run-start record the mtime rule has no anchor;
        # fail closed instead of trusting the snapshot.
        snapshot_pre_status(self.repo, self.pre_status)
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_run_meta_present"])
        self.assertFalse(verdict["checks"]["rail_ok"])
        self.assertFalse(verdict["checks"]["repo_untouched"])

    def test_missing_agent_log_grades_red(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex4()))
        code, verdict, err = self.grade_ex4()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_agent_log_present"])
        self.assertFalse(verdict["checks"]["repo_untouched"])

    def test_prompt_forbids_grader_and_rail_access(self):
        # D9: the prompt itself must outlaw the wave-15 tampering moves.
        prompt = " ".join((PACK / "ex4-repo-facts/prompt.txt").read_text().lower().split())
        self.assertIn("do not read or execute any grading scripts", prompt)
        self.assertIn("git-status-pre.txt", prompt)
        self.assertIn("run-meta.json", prompt)
        self.assertIn("agent.log", prompt)


class Ex5Test(Ex4Ex5Base):
    def test_gold_passes(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex5()))
        code, verdict, err = self.grade_ex5()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["rail_ok"], json.dumps(verdict))

    def test_wrong_exit_code_fails(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        answers = self.expected_ex5()
        answers["sigterm_exit"] = 1
        (self.work / "answers.json").write_text(json.dumps(answers))
        code, verdict, err = self.grade_ex5()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["per_key"]["sigterm_exit"])

    def test_foreign_lane_drift_does_not_fail(self):
        snapshot_pre_status(self.repo, self.pre_status)
        self.start_run()
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex5()))
        (self.repo / "packages/coding-agent/src/other-lane.ts").write_text("// parallel\n")
        code, verdict, err = self.grade_ex5()
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["repo_untouched"])

    def test_forged_pre_status_mid_run_grades_red(self):
        # D9: same mtime rule as EX-4 - a re-snapshotted pre-status voids the
        # run even when its content matches the post state.
        now = time.time()
        snapshot_pre_status(self.repo, self.pre_status)
        os.utime(self.pre_status, (now - 120, now - 120))
        self.start_run(started_at=now - 60)
        self.write_log([read_only_call(self.repo)])
        (self.work / "answers.json").write_text(json.dumps(self.expected_ex5()))
        snapshot_pre_status(self.repo, self.pre_status)  # the forgery
        code, verdict, err = self.grade_ex5()
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["rail_pre_status_predates_run"])
        self.assertFalse(verdict["checks"]["repo_untouched"])

    def test_prompt_forbids_executing_the_cli(self):
        # D6: no empirical signal harnesses; source reading only.
        prompt = " ".join((PACK / "ex5-sigterm/prompt.txt").read_text().lower().split())
        self.assertIn("do not execute", prompt)
        self.assertIn("signal the cli under test", prompt)

    def test_prompt_forbids_grader_and_rail_access(self):
        # D9: the prompt itself must outlaw the wave-15 tampering moves.
        prompt = " ".join((PACK / "ex5-sigterm/prompt.txt").read_text().lower().split())
        self.assertIn("do not read or execute any grading scripts", prompt)
        self.assertIn("git-status-pre.txt", prompt)


class Ex7Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / "ex7"
        (self.work / "fixture").mkdir(parents=True)
        self.expected = {"FACT-2": "TK-NEW111", "FACT-4": "TK-444444", "FACT-5": "TK-555555"}
        self.meta = {
            "exam": "EX-7",
            "exit_code": 0,
            "expected": self.expected,
            "superseded_value": "TK-OLD222",
        }

    def tearDown(self):
        self.tmp.cleanup()

    def grade(self, facts):
        (self.work / "run.json").write_text(json.dumps(self.meta))
        (self.work / "fixture" / "facts.json").write_text(json.dumps(facts))
        return run_grader("ex7-session-recall/grade_ex7.py", "--work", str(self.work))

    def test_gold_passes(self):
        code, verdict, err = self.grade(dict(self.expected))
        self.assertEqual(code, 0, err)
        self.assertTrue(verdict["pass"], json.dumps(verdict))

    def test_superseded_value_fails(self):
        facts = dict(self.expected, **{"FACT-2": "TK-OLD222"})
        code, verdict, err = self.grade(facts)
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["superseded_not_used"])

    def test_extra_key_fails(self):
        facts = dict(self.expected, **{"FACT-1": "TK-111111"})
        code, verdict, err = self.grade(facts)
        self.assertEqual(code, 1, err)
        self.assertFalse(verdict["pass"])
        self.assertFalse(verdict["checks"]["exact_key_set"])


# --- stub agent + socket stub for driver wiring tests -----------------------
#
# The stub is a stand-in for the real CLI: it receives the same launch
# arguments the drivers would give prime-agent, emits one assistant
# message_end line (so usage accounting has something to sum), and plays
# both EX-3 phases from the launch flags. The socket stub accepts the
# driver's shutdown envelope so examlib.shutdown_daemon returns at once.

STUB_AGENT = """\
#!/usr/bin/env python3
# Stub CLI for the exam-v1 driver wiring tests.
import json
import re
import sys
from pathlib import Path

argv = sys.argv[1:]
cwd = Path(argv[argv.index("--cwd") + 1])
sessions = Path(argv[argv.index("--session-dir") + 1])
prompt = argv[argv.index("--") + 1] if "--" in argv else ""

print(json.dumps({"type": "message_end", "message": {"role": "assistant", "usage": {"totalTokens": 25}}}))

if "--resume" in argv:
    # EX-3 phase B: report the surviving token and the heartbeat count.
    token = (cwd / "phase-a.txt").read_text().strip()
    ticks = len((cwd / "heartbeat.log").read_text().splitlines())
    (cwd / "phase-b.txt").write_text("token: %s\\nheartbeat_ticks: %d\\n" % (token, ticks))
    sys.exit(0)

match = re.search(r"one line: (\\S+)", prompt)
if match:
    # EX-3 phase A: plant the artifacts plus a resumable session file, then
    # exit 143 (the print-mode SIGTERM mapping the driver expects).
    (cwd / "phase-a.txt").write_text(match.group(1) + "\\n")
    (cwd / "heartbeat.log").write_text("tick\\n")
    (sessions / "stub-session.jsonl").write_text(json.dumps({"type": "session", "id": "stub"}) + "\\n")
    sys.exit(143)
sys.exit(0)
"""


class SocketStub:
    """Accept one shutdown-envelope connection, then close (daemon stand-in)."""

    def __init__(self, path: Path):
        self.path = path
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(1)
        self.server.settimeout(15)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        try:
            connection, _ = self.server.accept()
            connection.settimeout(5)
            try:
                connection.recv(4096)
            except OSError:
                pass
            connection.close()
        except OSError:
            pass
        finally:
            self.server.close()

    def close(self) -> None:
        # Unblock a still-waiting accept (the driver errored before its
        # shutdown); on the happy path the envelope was already served and
        # this connect just fails.
        unblock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            unblock.settimeout(1)
            unblock.connect(str(self.path))
        except OSError:
            pass
        finally:
            unblock.close()
        self.thread.join(timeout=20)


class DriverRailBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.rail = self.root / "rail"
        # An empty stand-in agent home: agent_env must never read the real
        # ~/.prime/agent for credentials.
        self.fake_home = self.root / "source-home"
        self.fake_home.mkdir()
        self.stub = self.root / "stub-agent"
        self.stub.write_text(STUB_AGENT)
        self.stub.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_driver(self, script: str, *extra: str):
        env = dict(os.environ)
        env["PRIME_AGENT_CODING_AGENT_DIR"] = str(self.fake_home)
        for leaked in ("RLM_DEPTH", "RLM_SESSION_DIR", "RLM_MAX_DEPTH"):
            env.pop(leaked, None)
        return subprocess.run(
            [sys.executable, str(PACK / script)] + list(extra),
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )


class RunManualRailTest(DriverRailBase):
    def run_manual(self, *extra: str):
        return self.run_driver(
            "run_manual.py",
            "--work",
            str(self.work),
            "--prompt-file",
            str(PACK / "ex4-repo-facts/prompt.txt"),
            "--agent-bin",
            str(self.stub),
            "--timeout",
            "60",
            *extra,
        )

    def test_rail_dir_inside_work_is_refused(self):
        proc = self.run_manual("--rail-dir", str(self.work / "rail"))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("outside", proc.stderr)

    def test_rail_run_writes_rails_outside_work(self):
        server = SocketStub(self.work / "d.sock")
        proc = self.run_manual("--rail-dir", str(self.rail))
        server.close()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        run_meta = json.loads((self.rail / "run-meta.json").read_text())
        self.assertEqual(run_meta["exam"], "RUN-MANUAL")
        self.assertIsInstance(run_meta["started_at"], (int, float))
        agent_log = self.rail / "agent.log"
        self.assertTrue(agent_log.is_file())
        self.assertIn('"totalTokens": 25', agent_log.read_text())
        # Nothing agent-writable holds a grading rail anymore.
        self.assertFalse((self.work / "agent.log").exists())
        run_json = json.loads((self.work / "run.json").read_text())
        self.assertEqual(run_json["usage"], {"tokens": 25, "turns": 1})
        self.assertEqual(run_json["rail_dir"], str(self.rail.resolve()))

    def test_without_rail_dir_keeps_legacy_layout(self):
        # EX-1/EX-2 have no drift rail; run_manual still works without one.
        server = SocketStub(self.work / "d.sock")
        proc = self.run_manual()
        server.close()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.work / "agent.log").is_file())
        self.assertFalse((self.root / "rail" / "run-meta.json").exists())


class RunEx3RailTest(DriverRailBase):
    def run_ex3(self, *extra: str):
        return self.run_driver(
            "ex3-recovery/run_ex3.py",
            "--work",
            str(self.work),
            "--model",
            "test/fake",
            "--agent-bin",
            str(self.stub),
            "--timeout",
            "60",
            "--seed",
            "1",
            *extra,
        )

    def test_rail_dir_inside_work_is_refused(self):
        proc = self.run_ex3("--rail-dir", str(self.work / "rail"))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("outside", proc.stderr)

    def test_full_stub_run_writes_rails_and_grades_green(self):
        # End to end, model-free: the stub agent plays both EX-3 phases, the
        # driver lands every rail outside the work dir, and the grader passes
        # on the rail flow.
        servers = [SocketStub(self.work / "d1.sock"), SocketStub(self.work / "d2.sock")]
        proc = self.run_ex3("--rail-dir", str(self.rail))
        for server in servers:
            server.close()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.rail / "pre-resume.json").is_file())
        self.assertFalse((self.work / "pre-resume.json").exists())
        run_meta = json.loads((self.rail / "run-meta.json").read_text())
        self.assertIsInstance(run_meta["started_at"], (int, float))
        self.assertIsInstance(run_meta["phase_b_started_at"], (int, float))
        pre_mtime = (self.rail / "pre-resume.json").stat().st_mtime
        self.assertLessEqual(pre_mtime, run_meta["phase_b_started_at"])
        code, verdict, err = run_grader(
            "ex3-recovery/grade_ex3.py", "--work", str(self.work), "--rail-dir", str(self.rail)
        )
        self.assertEqual(code, 0, err + json.dumps(verdict))
        self.assertTrue(verdict["pass"], json.dumps(verdict))
        self.assertTrue(verdict["checks"]["rail_ok"], json.dumps(verdict))


class DocsTest(unittest.TestCase):
    def test_readme_documents_same_home_serialization(self):
        # D5: a second daemon on one agent home is refused with
        # DaemonAgentDirAlreadyRunningError; the how-to-run must say so.
        readme = PACK / "README.md"
        self.assertTrue(readme.is_file(), "scripts/evals/exam-v1/README.md is missing")
        text = readme.read_text()
        self.assertIn("DaemonAgentDirAlreadyRunningError", text)
        self.assertRegex(text.lower(), r"serial")

    def test_readme_documents_the_rail_dir_contract(self):
        # D9: the how-to-run must put grading rails outside the work dir.
        text = (PACK / "README.md").read_text()
        self.assertIn("--rail-dir", text)
        self.assertIn("run-meta.json", text)

    def test_every_exam_has_a_prompt_source(self):
        for rel in (
            "ex1-pipeline/prompt.txt",
            "ex2-needles/prompt.txt",
            "ex4-repo-facts/prompt.txt",
            "ex5-sigterm/prompt.txt",
        ):
            self.assertTrue((PACK / rel).is_file(), rel + " missing")

    def test_driver_prompts_forbid_grader_access(self):
        # D9: the inline prompts (EX-3 phases, EX-7 final) carry the same
        # prohibition as the prompt files.
        ex3 = (PACK / "ex3-recovery/run_ex3.py").read_text().lower()
        self.assertEqual(ex3.count("do not read or execute any grading scripts"), 2)
        ex7 = (PACK / "ex7-session-recall/run_ex7.py").read_text().lower()
        self.assertIn("do not read or execute any grading scripts", ex7)
        for rel in ("ex1-pipeline/prompt.txt", "ex2-needles/prompt.txt"):
            prompt = " ".join((PACK / rel).read_text().lower().split())
            self.assertIn("do not read or execute any grading scripts", prompt, rel)


if __name__ == "__main__":
    unittest.main()
