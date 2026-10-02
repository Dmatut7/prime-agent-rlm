"""Change tracking (rlm.effects): what a cell changed and did, reported as display-only records.

Every case drives a real `python -m rlm.repl` process in a throwaway directory, so the
wrappers, the git before/after comparison and the protocol framing are the shipped ones.
"""

from __future__ import annotations

import difflib
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, SRC)

from rlm import effects  # noqa: E402

FILE = effects.FILE_CHANGE_MIME
MEMORY = effects.MEMORY_CHANGE_MIME
ACTIVITY = effects.ACTIVITY_MIME
STATUS = effects.TRACKING_STATUS_MIME
HAS_GIT = shutil.which("git") is not None
_LEAKED_PREFIXES = ("RLM_", "PRIME_AGENT_", "PI_")


class Kernel:
    """One kernel process with its own cwd and a sanitized environment."""

    def __init__(self, cwd: str, env: dict[str, str] | None = None, host_replies: dict | None = None) -> None:
        base = {k: v for k, v in os.environ.items() if not k.startswith(_LEAKED_PREFIXES)}
        base["PYTHONPATH"] = SRC + os.pathsep + os.environ.get("PYTHONPATH", "")
        base.update(env or {})
        self.host_replies = host_replies or {}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "rlm.repl"],
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=base,
        )
        self._lines: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        ready = self._event()
        assert ready["event"] == "ready", ready
        self._counter = 0

    def _read(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self._lines.put(line)
        except ValueError:
            pass
        self._lines.put(None)

    def _event(self, timeout: float = 60.0) -> dict:
        line = self._lines.get(timeout=timeout)
        if line is None:
            raise EOFError("kernel closed its protocol stream")
        return json.loads(line)

    def _send(self, request: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()

    def run(self, code: str, interrupt_after: float | None = None) -> "Cell":
        self._counter += 1
        rid = f"cell-{self._counter}"
        self._send({"type": "execute", "id": rid, "code": code})
        if interrupt_after is not None:
            timer = threading.Timer(interrupt_after, lambda: self._send({"type": "interrupt", "id": rid}))
            timer.daemon = True
            timer.start()
        events: list[dict] = []
        while True:
            event = self._event()
            if event.get("event") == "host_request":
                reply = self.host_replies.get(event["data"].get("type"))
                data = {"status": "ok", "result": reply} if reply is not None else {"status": "error", "error": "no"}
                self._send({"type": "host_reply", "id": event["id"], "data": data})
                continue
            events.append(event)
            if event.get("event") == "done" and event.get("id") == rid:
                return Cell(rid, events)

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self._send({"type": "shutdown", "id": "__shutdown__"})
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                self.proc.kill()
                self.proc.wait(timeout=10)
        for stream in (self.proc.stdin, self.proc.stdout):
            if stream is not None:
                stream.close()


class Cell:
    def __init__(self, rid: str, events: list[dict]) -> None:
        self.rid = rid
        self.events = events

    def payloads(self, mime: str) -> list[dict]:
        return [e["data"][mime] for e in self.events if e.get("event") == "display" and mime in e.get("data", {})]

    def files(self) -> dict[str, dict]:
        """Latest record per path, retractions applied: what the host ends up showing."""
        latest: dict[str, dict] = {}
        for record in self.payloads(FILE):
            if record.get("retracted"):
                latest.pop(record["path"], None)
            else:
                latest[record["path"]] = record
        return latest

    def by_rel(self) -> dict[str, dict]:
        return {record.get("relPath") or record["path"]: record for record in self.files().values()}

    def activities(self) -> dict[str, dict]:
        latest: dict[str, dict] = {}
        for record in self.payloads(ACTIVITY):
            latest[record["id"]] = record
        return latest

    def memory(self) -> dict[tuple, dict]:
        latest: dict[tuple, dict] = {}
        for record in self.payloads(MEMORY):
            key = (record["kind"], record["scope"], record["id"])
            if record.get("retracted"):
                latest.pop(key, None)
            else:
                latest[key] = record
        return latest

    @property
    def status(self) -> str:
        return self.events[-1]["status"]

    def stdout(self) -> str:
        return "".join(e["text"] for e in self.events if e.get("event") == "stdout")

    def error(self) -> dict | None:
        return next((e for e in self.events if e.get("event") == "error"), None)


def _git(cwd: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


class TrackerCase(unittest.TestCase):
    use_git = True
    extra_env: dict[str, str] = {}

    def setUp(self) -> None:
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="rlm-effects-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "project")
        os.makedirs(self.root)
        self.agent_dir = os.path.join(self.tmp, "agent")
        os.makedirs(self.agent_dir)
        self.write("a.txt", "one\ntwo\nthree\n")
        self.write("b.txt", "keep\n")
        self.write(".gitignore", "ignored.txt\nbuild-out/\n")
        if self.use_git and HAS_GIT:
            _git(self.root, "init", "-q", "-b", "main")
            _git(self.root, "add", ".")
            _git(self.root, "commit", "-qm", "init")
        env = {
            "PRIME_AGENT_CODING_AGENT_DIR": self.agent_dir,
            "RLM_HARNESS_STATE_DIR": os.path.join(self.tmp, "harness-local"),
            "RLM_GLOBAL_HARNESS_STATE_DIR": os.path.join(self.tmp, "harness-global"),
            **self.kernel_env(),
        }
        self.kernel = Kernel(self.root, env, host_replies=self.host_replies())
        self.addCleanup(self.kernel.close)
        self.kernel.run("import rlm\nbash = rlm.bash")

    def host_replies(self) -> dict:
        return {}

    def kernel_env(self) -> dict[str, str]:
        return dict(self.extra_env)

    def path(self, rel: str) -> str:
        return os.path.join(self.root, rel)

    def write(self, rel: str, text: str) -> None:
        full = self.path(rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as handle:
            handle.write(text)


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class PythonWriteTests(TrackerCase):
    def test_multiple_writes_to_one_file_coalesce_into_one_start_to_end_diff(self):
        cell = self.kernel.run(
            "with open('a.txt', 'w') as f:\n    f.write('one\\nTWO\\nthree\\n')\n"
            "with open('a.txt', 'a') as f:\n    f.write('four\\n')\n"
        )
        self.assertEqual(cell.status, "ok")
        files = cell.by_rel()
        self.assertEqual(list(files), ["a.txt"])
        record = files["a.txt"]
        self.assertEqual(record["kind"], "modified")
        self.assertEqual(record["scope"], "project")
        self.assertEqual(record["source"], "python")
        self.assertEqual((record["added"], record["removed"]), (2, 1))
        self.assertIn("-two\n+TWO\n", record["diff"])
        self.assertIn("+four\n", record["diff"])
        self.assertEqual(record["path"], self.path("a.txt"))
        # Well within the budget: nothing claims the list is partial.
        self.assertEqual(cell.payloads(STATUS), [])

    def test_pathlib_writes_and_touch_are_seen(self):
        cell = self.kernel.run(
            "from pathlib import Path\n"
            "Path('p1.txt').write_text('x\\ny\\n')\n"
            "Path('p2.bin').write_bytes(b'\\x00\\x01\\x02')\n"
            "Path('p3.txt').touch()\n"
        )
        files = cell.by_rel()
        self.assertEqual(files["p1.txt"]["kind"], "created")
        self.assertEqual(files["p1.txt"]["added"], 2)
        self.assertTrue(files["p2.bin"]["binary"])
        self.assertNotIn("diff", files["p2.bin"])
        self.assertEqual(files["p3.txt"]["kind"], "created")
        self.assertEqual(files["p3.txt"]["added"], 0)

    def test_rename_reports_old_path_and_atomic_replace_reports_a_modification(self):
        cell = self.kernel.run(
            "import os, tempfile\n"
            "os.rename('b.txt', 'c.txt')\n"
            "fd, tmp = tempfile.mkstemp(dir='.')\n"
            "os.write(fd, b'one\\ntwo\\nthree\\nfour\\n'); os.close(fd)\n"
            "os.replace(tmp, 'a.txt')\n"
        )
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["a.txt", "c.txt"])
        self.assertEqual(files["c.txt"]["kind"], "renamed")
        self.assertEqual(files["c.txt"]["oldPath"], self.path("b.txt"))
        self.assertEqual((files["c.txt"]["added"], files["c.txt"]["removed"]), (0, 0))
        self.assertEqual(files["a.txt"]["kind"], "modified")
        self.assertEqual((files["a.txt"]["added"], files["a.txt"]["removed"]), (1, 0))

    def test_deletes_through_os_pathlib_and_rmtree(self):
        self.write("tree/x.txt", "x\n")
        self.write("tree/sub/y.txt", "y\ny\n")
        cell = self.kernel.run(
            "import os, shutil\nfrom pathlib import Path\n"
            "os.remove('a.txt')\nPath('b.txt').unlink()\nshutil.rmtree('tree')\n"
        )
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["a.txt", "b.txt", "tree/sub/y.txt", "tree/x.txt"])
        self.assertTrue(all(record["kind"] == "deleted" for record in files.values()))
        self.assertEqual(files["a.txt"]["removed"], 3)
        self.assertEqual(files["tree/sub/y.txt"]["removed"], 2)

    def test_shutil_copy_and_move_are_seen_through_open_and_rename(self):
        cell = self.kernel.run("import shutil\nshutil.copy('a.txt', 'copy.txt')\nshutil.move('b.txt', 'moved.txt')\n")
        files = cell.by_rel()
        self.assertEqual(files["copy.txt"]["kind"], "created")
        self.assertEqual(files["copy.txt"]["added"], 3)
        self.assertEqual(files["moved.txt"]["kind"], "renamed")

    def test_writing_identical_content_reports_nothing(self):
        cell = self.kernel.run("open('a.txt', 'w').write('one\\ntwo\\nthree\\n')\n")
        self.assertEqual(cell.files(), {})

    def test_a_change_reverted_later_in_the_cell_is_retracted(self):
        cell = self.kernel.run(
            "import time\n"
            "open('a.txt', 'w').write('changed\\n')\n"
            "time.sleep(0.6)\n"  # long enough for the live report to go out
            "open('a.txt', 'w').write('one\\ntwo\\nthree\\n')\n"
        )
        self.assertTrue(any(not record.get("retracted") for record in cell.payloads(FILE)))
        self.assertEqual(cell.files(), {})

    def test_live_record_arrives_before_the_cell_ends(self):
        cell = self.kernel.run(
            "import time\nopen('live.txt', 'w').write('hi\\n')\ntime.sleep(0.8)\nprint('end')\n"
        )
        displays = [i for i, e in enumerate(cell.events) if e.get("event") == "display" and FILE in e["data"]]
        prints = [i for i, e in enumerate(cell.events) if e.get("event") == "stdout" and "end" in e["text"]]
        self.assertTrue(displays and prints)
        self.assertLess(displays[0], prints[0])

    def test_exceptions_in_the_cell_are_untouched_and_changes_still_reported(self):
        cell = self.kernel.run("open('a.txt', 'w').write('boom\\n')\nraise ValueError('nope')\n")
        self.assertEqual(cell.status, "error")
        self.assertEqual(cell.error()["ename"], "ValueError")
        self.assertEqual(cell.error()["evalue"], "nope")
        self.assertEqual(cell.by_rel()["a.txt"]["kind"], "modified")

    def test_failed_writes_raise_the_original_error_and_report_nothing(self):
        cell = self.kernel.run(
            "try:\n    open('missing-dir/x.txt', 'w')\nexcept FileNotFoundError as e:\n    print(type(e).__name__)\n"
            "import os\ntry:\n    os.rename('nope.txt', 'x.txt')\nexcept FileNotFoundError as e:\n    print(type(e).__name__)\n"
        )
        self.assertEqual(cell.stdout().split(), ["FileNotFoundError", "FileNotFoundError"])
        self.assertEqual(cell.files(), {})

    def test_cwd_change_inside_the_cell(self):
        os.makedirs(self.path("sub"))
        cell = self.kernel.run(
            "import os\nos.chdir('sub')\nopen('inner.txt', 'w').write('in\\n')\n"
            "await bash('echo made > by_shell.txt')\nos.chdir('..')\n"
        )
        files = cell.by_rel()
        self.assertEqual(files["sub/inner.txt"]["kind"], "created")
        self.assertEqual(files["sub/by_shell.txt"]["source"], "shell")

    def test_scopes_scratch_rules_and_ignored_and_skipped(self):
        outside = os.path.join(self.tmp, "outside.txt")
        cell = self.kernel.run(
            f"open({outside!r}, 'w').write('s\\n')\n"
            "open('AGENTS.md', 'w').write('# rules\\n')\n"
            "open('ignored.txt', 'w').write('i\\n')\n"
            "import os\nos.makedirs('node_modules/pkg', exist_ok=True)\n"
            "open('node_modules/pkg/index.js', 'w').write('x')\n"
            "os.makedirs('build-out', exist_ok=True)\nopen('build-out/o.txt', 'w').write('o')\n"
        )
        files = cell.files()
        self.assertEqual(files[outside]["scope"], "scratch")
        self.assertNotIn("relPath", files[outside])
        self.assertEqual(files[self.path("AGENTS.md")]["scope"], "memory")
        self.assertEqual(sorted(files), sorted([outside, self.path("AGENTS.md")]))
        rules = cell.memory()[("rules_file", "project", self.path("AGENTS.md"))]
        self.assertEqual(rules["op"], "created")
        self.assertEqual(rules["after"], "# rules\n")

    def test_global_rules_file_is_memory_scope_global(self):
        target = os.path.join(self.agent_dir, "AGENTS.md")
        cell = self.kernel.run(f"open({target!r}, 'w').write('global rule\\n')\n")
        self.assertEqual(cell.files()[target]["scope"], "memory")
        self.assertEqual(cell.memory()[("rules_file", "global", target)]["op"], "created")

    def test_large_file_keeps_counts_without_a_diff_and_long_diffs_are_capped(self):
        # Past MAX_BASELINE_FILE_BYTES the before-content is not kept: counts without a diff.
        big = "".join(f"line {i:08d}\n" for i in range(effects.MAX_BASELINE_FILE_BYTES // 14 + 1))
        self.assertGreater(len(big), effects.MAX_BASELINE_FILE_BYTES)
        self.write("big.txt", big)
        cell = self.kernel.run(
            "open('big.txt', 'a').write('tail\\n')\n"
            "open('long.txt', 'w').write(''.join(f'l{i}\\n' for i in range(1000)))\n"
        )
        files = cell.by_rel()
        self.assertEqual(files["big.txt"]["diffOmitted"], "too_large")
        self.assertNotIn("diff", files["big.txt"])
        self.assertEqual(files["long.txt"]["added"], 1000)
        self.assertTrue(files["long.txt"]["diffTruncated"])
        self.assertLessEqual(files["long.txt"]["diff"].count("\n"), effects.MAX_DIFF_LINES)

    def test_edit_skill_writes_are_attributed_to_edit(self):
        cell = self.kernel.run(
            "from rlm.effects import write_source\nfrom pathlib import Path\n"
            "with write_source('edit'):\n    Path('a.txt').write_text('one\\n2\\nthree\\n')\n"
        )
        self.assertEqual(cell.by_rel()["a.txt"]["source"], "edit")

    def test_open_is_still_io_open_and_reads_work(self):
        cell = self.kernel.run("import io, builtins\n(open is io.open, builtins.open is io.open, open('a.txt').read())")
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertEqual(result["text"], "(True, True, 'one\\ntwo\\nthree\\n')")


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class ShellTests(TrackerCase):
    def test_sed_through_bash_on_a_file_dirty_before_the_cell(self):
        self.kernel.run("open('b.txt', 'a').write('dirty\\n')")
        cell = self.kernel.run("await bash(\"sed -i.bak 's/dirty/DIRTY/' b.txt && rm b.txt.bak\")")
        record = cell.by_rel()["b.txt"]
        self.assertEqual(record["source"], "shell")
        self.assertEqual(record["kind"], "modified")
        self.assertIn("-dirty\n+DIRTY\n", record["diff"])
        self.assertEqual((record["added"], record["removed"]), (1, 1))

    def test_git_checkout_of_a_file_restores_it(self):
        self.kernel.run("open('a.txt', 'w').write('local edit\\n')")
        cell = self.kernel.run("await bash('git checkout -- a.txt')")
        record = cell.by_rel()["a.txt"]
        self.assertEqual(record["source"], "shell")
        self.assertIn("-local edit\n", record["diff"])
        self.assertIn("+two\n", record["diff"])

    def test_branch_switch_reports_files_that_differ_between_commits(self):
        _git(self.root, "checkout", "-q", "-b", "other")
        self.write("a.txt", "other branch\n")
        self.write("only-other.txt", "o\n")
        _git(self.root, "add", ".")
        _git(self.root, "commit", "-qm", "other")
        _git(self.root, "checkout", "-q", "main")
        cell = self.kernel.run("await bash('git checkout -q other')")
        files = cell.by_rel()
        self.assertEqual(files["a.txt"]["kind"], "modified")
        self.assertIn("+other branch\n", files["a.txt"]["diff"])
        self.assertEqual(files["only-other.txt"]["kind"], "created")

    def test_subprocess_run_is_compared_too(self):
        cell = self.kernel.run("import subprocess\nsubprocess.run(['sh', '-c', 'echo x > sp.txt'], check=True)")
        self.assertEqual(cell.by_rel()["sp.txt"]["source"], "shell")

    def test_background_handle_from_an_earlier_cell_is_compared_in_the_next_cell(self):
        self.kernel.run("h = bash('sleep 0.5; echo late > late.txt')\nh.pid")
        cell = self.kernel.run("await h")
        self.assertEqual(cell.by_rel()["late.txt"]["kind"], "created")

    def test_command_activity_running_updates_and_outcome(self):
        cell = self.kernel.run(
            "await bash('echo first; sleep 0.7; echo second; sleep 0.7; echo \"Ran 3 tests in 0.1s\"; echo; echo OK')\n"
            "await bash('echo bad; exit 3')\n"
        )
        commands = [record for record in cell.payloads(ACTIVITY) if record["kind"] == "command"]
        first_id = commands[0]["id"]
        first = [record for record in commands if record["id"] == first_id]
        self.assertEqual(first[0]["status"], "running")
        running_details = [record.get("detail") for record in first if record["status"] == "running"]
        self.assertIn("first", running_details)
        self.assertIn("second", running_details)
        self.assertEqual(first[-1]["status"], "ok")
        self.assertEqual(first[-1]["detail"], "3 tests, OK")
        self.assertIn("endedAt", first[-1])
        latest = cell.activities()
        failed = [record for record in latest.values() if record["kind"] == "command" and record["id"] != first_id][0]
        self.assertEqual(failed["status"], "error")
        self.assertTrue(failed["detail"].startswith("exit 3"))

    def test_read_activities_are_per_file_inside_the_cwd_and_deduplicated(self):
        outside = os.path.join(self.tmp, "outside.txt")
        with open(outside, "w") as handle:
            handle.write("o")
        cell = self.kernel.run(
            f"open('a.txt').read(); open('a.txt').read(); open('b.txt').read(); open({outside!r}).read()\n"
            "from pathlib import Path\nPath('a.txt').read_text()\n"
        )
        reads = [record["label"] for record in cell.activities().values() if record["kind"] == "read"]
        self.assertEqual(reads, ["a.txt", "b.txt"])


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class MemoryTests(TrackerCase):
    def test_create_update_delete_and_scopes(self):
        cell = self.kernel.run(
            "h = rlm.harness\n"
            "h.create_memory('Deploy steps', 'use make deploy', id='deploy')\n"
            "h.create_skill('Lint', 'run lint', id='lint', reference={'type': 'python', 'import': 'x', 'callable': 'run'})\n"
            "h.create_prompt_note('Tone', 'be brief', id='tone', global_=True)\n"
            "h.create_subagent('Reviewer', 'review diffs', id='rev')\n"
        )
        memory = cell.memory()
        self.assertEqual(
            sorted(memory),
            [
                ("memory", "session", "deploy"),
                ("prompt_note", "global", "tone"),
                ("skill", "session", "lint"),
                ("subagent", "session", "rev"),
            ],
        )
        self.assertEqual(memory[("memory", "session", "deploy")]["op"], "created")
        self.assertEqual(memory[("memory", "session", "deploy")]["after"], "use make deploy")
        cell = self.kernel.run(
            "h.update_memory('deploy', 'Deploy steps v2', 'use make ship')\n"
            "h.update_memory('deploy', 'Deploy steps v3', 'use make ship --prod')\n"
            "h.delete_subagent('rev')\n"
        )
        memory = cell.memory()
        updated = memory[("memory", "session", "deploy")]
        self.assertEqual(updated["op"], "updated")
        self.assertEqual(updated["before"], "use make deploy")
        self.assertEqual(updated["after"], "use make ship --prod")
        self.assertEqual(updated["previousTitle"], "Deploy steps")
        self.assertEqual(updated["title"], "Deploy steps v3")
        deleted = memory[("subagent", "session", "rev")]
        self.assertEqual(deleted["op"], "deleted")
        self.assertEqual(deleted["before"], "review diffs")

    def test_created_then_deleted_in_one_cell_leaves_nothing(self):
        cell = self.kernel.run(
            "rlm.harness.create_memory('Temp', 'x', id='tmp')\nrlm.harness.delete_memory('tmp')\n"
        )
        self.assertEqual(cell.memory(), {})
        self.assertTrue(any(record.get("retracted") for record in cell.payloads(MEMORY)))

    def test_harness_saves_are_memory_records_but_direct_state_edits_are_file_changes(self):
        state_file = os.path.join(self.tmp, "harness-local", "harness_state.json")
        cell = self.kernel.run("rlm.harness.create_memory('A', 'a', id='a')")
        self.assertEqual(cell.files(), {})
        self.assertEqual(len(cell.memory()), 1)
        cell = self.kernel.run(f"open({state_file!r}, 'a').write('\\n')")
        record = cell.files()[state_file]
        self.assertEqual((record["scope"], record["kind"]), ("memory", "modified"))

    def test_rejected_write_reports_nothing(self):
        cell = self.kernel.run(
            "try:\n    rlm.harness.create_memory('', 'x')\nexcept ValueError:\n    print('rejected')\n"
        )
        self.assertEqual(cell.stdout().strip(), "rejected")
        self.assertEqual(cell.payloads(MEMORY), [])


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class SubagentStepTests(TrackerCase):
    def host_replies(self) -> dict:
        return {
            "rlm.run": {
                "rlm_child_id": "c1",
                "name": "researcher",
                "session_dir": "/tmp/child",
                "model": "prov/model-x",
            }
        }

    def test_spawn_is_reported_with_the_child_name(self):
        cell = self.kernel.run("handle = await rlm.run('look into the flaky test')\nhandle.name")
        steps = [record for record in cell.payloads(ACTIVITY) if record["kind"] == "subagent"]
        self.assertEqual(steps[0]["status"], "running")
        self.assertEqual(steps[0]["label"], "look into the flaky test")
        self.assertEqual(steps[-1]["status"], "ok")
        self.assertEqual(steps[-1]["label"], "researcher")
        self.assertEqual(steps[-1]["detail"], "prov/model-x")


class NoGitTests(TrackerCase):
    use_git = False

    def test_shell_changes_outside_git_come_from_the_mtime_scan(self):
        cell = self.kernel.run("await bash('echo new > fresh.txt && echo more >> a.txt')")
        files = cell.by_rel()
        self.assertEqual(files["fresh.txt"]["kind"], "created")
        self.assertEqual(files["fresh.txt"]["source"], "shell")
        self.assertEqual(files["a.txt"]["kind"], "modified")
        self.assertIn("+more\n", files["a.txt"]["diff"])

    def test_build_output_is_skipped_outside_git(self):
        cell = self.kernel.run("import os\nos.makedirs('dist', exist_ok=True)\nopen('dist/x.js', 'w').write('x')\n")
        self.assertEqual(cell.files(), {})

    def test_a_background_command_that_ends_between_cells_reports_its_files_in_the_next_cell(self):
        first = self.kernel.run("h = bash('sleep 0.3; echo late > late.txt')\nh.pid")
        self.assertNotIn("late.txt", first.by_rel())
        time.sleep(1.2)  # the model thinking: the command ends while no cell runs
        second = self.kernel.run("x = 1")
        record = second.by_rel()["late.txt"]
        self.assertEqual((record["kind"], record["source"], record["added"]), ("created", "shell", 1))


# Every function _install_wrappers replaces; each wrapper carries `__wrapped__` (functools.wraps).
_WRAP_PROBE = (
    "import builtins, io, os, shutil, subprocess\n"
    "_points = {'builtins.open': builtins.open, 'io.open': io.open, 'os.open': os.open, 'os.remove': os.remove,\n"
    "    'os.unlink': os.unlink, 'os.truncate': os.truncate, 'os.rename': os.rename, 'os.replace': os.replace,\n"
    "    'shutil.rmtree': shutil.rmtree, 'subprocess.Popen.__init__': subprocess.Popen.__init__,\n"
    "    'os.system': os.system, 'os.posix_spawn': getattr(os, 'posix_spawn', None),\n"
    "    'os.posix_spawnp': getattr(os, 'posix_spawnp', None)}\n"
    "sorted(name for name, fn in _points.items() if fn is not None and hasattr(fn, '__wrapped__'))"
)
_WRAPPED_POINTS = sorted(
    [
        "builtins.open",
        "io.open",
        "os.open",
        "os.remove",
        "os.unlink",
        "os.truncate",
        "os.rename",
        "os.replace",
        "shutil.rmtree",
        "subprocess.Popen.__init__",
        "os.system",
        *(["os.posix_spawn"] if hasattr(os, "posix_spawn") else []),
        *(["os.posix_spawnp"] if hasattr(os, "posix_spawnp") else []),
    ]
)


# Fake credentials, split so no complete one sits in this file.
_OLD_KEY = "sk-" + "OLDFAKE" + "0" * 24
_NEW_KEY = "sk-" + "NEWFAKE" + "0" * 24
_AWS_KEY = "AKIA" + "FAKE" + "0" * 12
_PEM = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\n"


def _anywhere(cell: Cell, *needles: str) -> list[str]:
    """Which needles appear anywhere in a cell's protocol events (records, outputs, everything)."""
    text = json.dumps(cell.events)
    return [needle for needle in needles if needle in text]


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class SecretTests(TrackerCase):
    """Records are saved with the session: credentials must not ride along in diffs or memory texts."""

    def test_an_env_file_written_by_python_keeps_its_counts_but_no_diff(self):
        cell = self.kernel.run(f"open('.env', 'w').write('OPENAI_API_KEY={_OLD_KEY}\\nAWS_KEY={_AWS_KEY}\\n')")
        record = cell.by_rel()[".env"]
        self.assertEqual((record["kind"], record["source"], record["added"], record["removed"]), ("created", "python", 2, 0))
        self.assertEqual(record["diffOmitted"], effects.SENSITIVE)
        self.assertNotIn("diff", record)
        self.assertEqual(_anywhere(cell, _OLD_KEY, _AWS_KEY), [])

    def test_a_tracked_env_file_rotated_by_bash_keeps_neither_value(self):
        self.write(".env", f"OPENAI_API_KEY={_OLD_KEY}\n")
        _git(self.root, "add", ".env")
        _git(self.root, "commit", "-qm", "env")
        cell = self.kernel.run("await bash(\"sed -i.bak 's/OLDFAKE/NEWFAKE/' .env && rm .env.bak\")")
        record = cell.by_rel()[".env"]
        self.assertEqual((record["kind"], record["source"], record["added"], record["removed"]), ("modified", "shell", 1, 1))
        self.assertEqual(record["diffOmitted"], effects.SENSITIVE)
        self.assertEqual(_anywhere(cell, _OLD_KEY, _NEW_KEY), [])

    def test_a_secret_inside_an_ordinary_file_withholds_that_files_diff_only(self):
        cell = self.kernel.run(
            f"open('config.py', 'w').write('API_KEY = \"{_OLD_KEY}\"\\nDEBUG = True\\n')\n"
            "open('settings.py', 'w').write('DB_PASSWORD = \"hunter2hunter2\"\\n')\n"
            "open('a.txt', 'a').write('four\\n')\n"
        )
        files = cell.by_rel()
        for rel, added in (("config.py", 2), ("settings.py", 1)):
            self.assertEqual(files[rel]["diffOmitted"], effects.SENSITIVE, rel)
            self.assertNotIn("diff", files[rel])
            self.assertEqual(files[rel]["added"], added, rel)
        self.assertIn("+four\n", files["a.txt"]["diff"])
        self.assertEqual(_anywhere(cell, _OLD_KEY, "hunter2hunter2"), [])

    def test_ordinary_code_about_secrets_keeps_its_diff(self):
        code = (
            "import os\\n"
            "class SecretManager:\\n"
            "    def load(self, request):\\n"
            "        password = request.form[\\\"password\\\"]\\n"
            "        token = tokenizer(text)\\n"
            "        max_tokens = 4096\\n"
            "        api_key = os.environ[\\\"API_KEY\\\"]\\n"
            "        secret = None\\n"
            "        return password == \\\"\\\" or token != secret\\n"
        )
        cell = self.kernel.run(f"open('secret_manager.py', 'w').write(\"{code}\")")
        record = cell.by_rel()["secret_manager.py"]
        self.assertNotIn("diffOmitted", record)
        self.assertIn("+class SecretManager:\n", record["diff"])
        self.assertEqual(record["added"], 9)

    def test_a_memory_entry_holding_a_token_keeps_its_record_but_no_texts(self):
        cell = self.kernel.run(
            f"rlm.harness.create_memory('Deploy creds', 'token={_OLD_KEY}', id='creds')\n"
            "rlm.harness.create_memory('Deploy steps', 'use make deploy', id='deploy')\n"
        )
        memory = cell.memory()
        withheld = memory[("memory", "session", "creds")]
        self.assertEqual((withheld["op"], withheld["title"], withheld["textOmitted"]), ("created", "Deploy creds", "sensitive"))
        self.assertNotIn("after", withheld)
        self.assertEqual(memory[("memory", "session", "deploy")]["after"], "use make deploy")
        # A later edit in the same cell that drops the token still shows no text: the first one held it.
        cell = self.kernel.run(
            f"rlm.harness.update_memory('creds', 'Deploy creds', 'token={_NEW_KEY}')\n"
            "rlm.harness.update_memory('creds', 'Deploy creds', 'ask ops for the token')\n"
        )
        updated = cell.memory()[("memory", "session", "creds")]
        self.assertEqual((updated["op"], updated["textOmitted"]), ("updated", "sensitive"))
        self.assertNotIn("before", updated)
        self.assertNotIn("after", updated)
        self.assertEqual(_anywhere(cell, _OLD_KEY, _NEW_KEY), [])

    def test_a_write_through_a_link_to_a_secret_file_withholds_the_targets_diff(self):
        # Coverage: a write through a symlink is filed under its real target (K3), so the target's
        # own name still drives the sensitive-path check (T5); this confirms the two compose.
        self.write(".env", f"OPENAI_API_KEY={_OLD_KEY}\n")
        os.symlink(".env", self.path("link-to-env"))
        _git(self.root, "add", ".env", "link-to-env")
        _git(self.root, "commit", "-qm", "env+link")
        cell = self.kernel.run(f"open('link-to-env', 'a').write('AWS_KEY={_AWS_KEY}\\n')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), [".env"])
        self.assertEqual(files[".env"]["diffOmitted"], effects.SENSITIVE)
        self.assertNotIn("diff", files[".env"])
        self.assertEqual(_anywhere(cell, _OLD_KEY, _AWS_KEY), [])


class SecretNoGitTests(TrackerCase):
    use_git = False

    def test_private_key_files_outside_git_keep_no_diff(self):
        cell = self.kernel.run(
            f"open('server.pem', 'w').write({_PEM!r})\n"
            f"open('backup-notes.txt', 'w').write('restore with\\n' + {_PEM!r})\n"
            "await bash('mkdir -p keys && printf \"k\\\\n\" > keys/id_ed25519')\n"
        )
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["backup-notes.txt", "keys/id_ed25519", "server.pem"])
        for rel, record in files.items():
            self.assertEqual(record["kind"], "created", rel)
            self.assertEqual(record["diffOmitted"], effects.SENSITIVE, rel)
            self.assertGreater(record["added"], 0, rel)
        self.assertEqual(_anywhere(cell, "MIIEfake"), [])


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class SessionStorageInProjectTests(TrackerCase):
    """A session folder inside the working folder holds the agent's own files, not the cell's work."""

    def kernel_env(self) -> dict[str, str]:
        session = os.path.join(self.root, "agent-session")
        return {"RLM_SESSION_DIR": session, "RLM_HARNESS_STATE_DIR": os.path.join(session, "harness")}

    def test_the_session_folder_and_harness_saves_are_not_file_changes(self):
        cell = self.kernel.run(
            "await bash('mkdir -p agent-session/sub-1 && echo log > agent-session/sub-1/out.txt && echo x > work.txt')\n"
            "rlm.harness.create_memory('A', 'a', id='a')\n"
            "open('agent-session/notes.txt', 'w').write('n\\n')\n"
        )
        self.assertEqual(sorted(cell.by_rel()), ["work.txt"])
        self.assertEqual(list(cell.memory()), [("memory", "session", "a")])


class WrapPointTests(TrackerCase):
    def test_tracking_wraps_every_write_and_spawn_point(self):
        cell = self.kernel.run(_WRAP_PROBE)
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertEqual(result["text"], repr(_WRAPPED_POINTS))


class DisabledTests(TrackerCase):
    extra_env = {"PRIME_AGENT_CHANGE_TRACKING": "0"}

    def test_disabled_tracking_installs_nothing_and_sends_nothing(self):
        cell = self.kernel.run(
            "open('a.txt', 'w').write('x\\n')\nawait bash('echo y > y.txt')\n"
            "rlm.harness.create_memory('M', 'm', id='m')\n"
        )
        self.assertEqual(cell.status, "ok")
        self.assertEqual([e for e in cell.events if e.get("event") == "display"], [])
        # The positive control is WrapPointTests: the same probe lists every point there.
        probe = self.kernel.run(_WRAP_PROBE)
        result = next(e for e in probe.events if e.get("event") == "result")
        self.assertEqual(result["text"], "[]")


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class BackgroundCommandTests(TrackerCase):
    def _command(self, cell: Cell) -> dict:
        commands = [record for record in cell.activities().values() if record["kind"] == "command"]
        self.assertEqual(len(commands), 1, commands)
        return commands[0]

    def test_a_command_left_running_is_marked_background_and_its_end_reported_later(self):
        first = self.kernel.run("h = bash('sleep 0.8; echo finished')\nh.pid")
        left = self._command(first)
        self.assertEqual(left["status"], "running")
        self.assertTrue(left["background"])
        # The host words the hand-off itself, from `background`; the runtime sends no screen text.
        self.assertNotIn("detail", left)
        self.assertGreaterEqual(left["endedAt"], left["startedAt"])
        second = self.kernel.run("import time\ntime.sleep(1.5)")
        done = second.activities()[left["id"]]
        self.assertEqual(done["status"], "ok")
        self.assertTrue(done["background"])
        self.assertEqual(done["detail"], "finished")
        self.assertEqual(done["startedAt"], left["startedAt"])
        self.assertGreater(done["endedAt"], left["endedAt"])

    def test_a_background_end_between_cells_is_reported_at_the_next_cell_start(self):
        first = self.kernel.run("h = bash('sleep 0.2; exit 3')\nh.pid")
        left = self._command(first)
        time.sleep(0.8)
        second = self.kernel.run("x = 1")
        displays = [e for e in second.events if e.get("event") == "display"]
        self.assertTrue(displays)
        first_record = displays[0]["data"][ACTIVITY]
        self.assertEqual(first_record["id"], left["id"])
        self.assertEqual(first_record["status"], "error")
        self.assertTrue(first_record["background"])
        self.assertTrue(first_record["detail"].startswith("exit 3"))

    def test_a_command_left_running_does_not_keep_its_cell_alive(self):
        # A dev server runs for hours; its cell's snapshots and file baselines must not live as long.
        self.kernel.run("h = bash('sleep 5')\nh.pid")
        cell = self.kernel.run("import gc\ngc.collect()\nsum(type(o).__name__ == '_Cell' for o in gc.get_objects())")
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertEqual(result["text"], "1")  # the running cell only
        self.kernel.run("h.kill()")

    def test_a_background_command_that_ends_between_cells_reports_its_files_in_the_next_cell(self):
        first = self.kernel.run("h = bash('sleep 0.3; echo late > late.txt; echo more >> a.txt')\nh.pid")
        self.assertEqual(first.files(), {})
        time.sleep(1.2)  # the model thinking: the command ends while no cell runs
        second = self.kernel.run("x = 1")
        command = self._command(second)
        self.assertEqual((command["status"], command["background"]), ("ok", True))
        files = second.by_rel()
        self.assertEqual(sorted(files), ["a.txt", "late.txt"])
        self.assertEqual((files["late.txt"]["kind"], files["late.txt"]["source"]), ("created", "shell"))
        self.assertIn("+late\n", files["late.txt"]["diff"])
        self.assertEqual(files["a.txt"]["kind"], "modified")
        self.assertIn("+more\n", files["a.txt"]["diff"])
        # Reported once, in the cell that also reports the command's end.
        third = self.kernel.run("x = 2")
        self.assertEqual(third.files(), {})

    def test_a_background_command_that_writes_a_secret_between_cells_keeps_no_diff(self):
        # Coverage: a background command's changes are filed through the same build()/publish()
        # pipeline as any other shell change (K3), so T5's sensitive-path check still applies.
        first = self.kernel.run(f"h = bash('sleep 0.3; echo OPENAI_API_KEY={_OLD_KEY} > .env')\nh.pid")
        self.assertEqual(first.files(), {})
        time.sleep(1.2)  # the model thinking: the command ends while no cell runs
        second = self.kernel.run("x = 1")
        files = second.by_rel()
        self.assertEqual(files[".env"]["kind"], "created")
        self.assertEqual(files[".env"]["diffOmitted"], effects.SENSITIVE)
        self.assertNotIn("diff", files[".env"])
        # The key stays out of the file record itself; it may still show in the command's own
        # label, since that is the source line the model wrote, not recorded output.
        self.assertNotIn(_OLD_KEY, json.dumps(files[".env"]))

    def test_an_awaited_command_is_never_marked_background(self):
        cell = self.kernel.run("await bash('echo hi')")
        record = self._command(cell)
        self.assertEqual(record["status"], "ok")
        self.assertNotIn("background", record)
        self.assertFalse(any(r.get("background") for r in cell.payloads(ACTIVITY)))

    def test_a_successful_git_commit_carries_its_commit_id(self):
        cell = self.kernel.run(
            "await bash(\"git -c user.email=t@example.com -c user.name=t commit --allow-empty -m 'tracked commit'\")"
        )
        record = self._command(cell)
        head = _git(self.root, "rev-parse", "HEAD").strip()
        self.assertEqual(record["status"], "ok")
        self.assertGreaterEqual(len(record["commit"]), 7)
        self.assertTrue(head.startswith(record["commit"]), (head, record["commit"]))
        failed = self.kernel.run("await bash('git commit -m nothing-staged')")
        self.assertEqual(self._command(failed)["status"], "error")
        self.assertNotIn("commit", self._command(failed))

    def test_commit_id_parsing(self):
        output = "hook output\n[main (root-commit) 1a2b3c4] first\n 1 file changed\n[main 9f8e7d6] second\n"
        self.assertEqual(effects._commit_id("git commit -m x", 0, output), "9f8e7d6")
        self.assertIsNone(effects._commit_id("git commit -m x", 1, output))
        self.assertIsNone(effects._commit_id("echo '[main 1a2b3c4] x'", 0, "[main 1a2b3c4] x\n"))
        self.assertEqual(effects._commit_id("git cherry-pick abc", 0, "[detached HEAD 0123abc] pick\n"), "0123abc")
        self.assertEqual(effects._commit_id("git commit -m x", 0, "[feature/x 1a2b3c4] x\n"), "1a2b3c4")
        # Bracketed hex that is not git's `[<branch> <sha>]` line.
        self.assertIsNone(effects._commit_id("git log -1", 0, "[build/deadbeef1] x\n"))
        self.assertIsNone(effects._commit_id("git log -1", 0, "[deadbeef123] x\n"))
        self.assertIsNone(effects._commit_id("git log -1", 0, "[main] 1a2b3c4] x\n"))


class CommandDetailSecretTests(TrackerCase):
    """A command's activity `detail` (its latest/last output line) is display text like a diff or a
    memory text: it must not carry a credential. `bash()`'s own return value is a separate object,
    built and stored before the step's record is sent (see `bash.py`'s `_finalize`), so it is
    untouched; each test below checks that directly.
    """

    def _command(self, cell: Cell) -> dict:
        commands = [record for record in cell.activities().values() if record["kind"] == "command"]
        self.assertEqual(len(commands), 1, commands)
        return commands[0]

    def test_a_finished_commands_detail_never_carries_a_leaked_key(self):
        cell = self.kernel.run(f"r = await bash('echo {_OLD_KEY}')\nr.output")
        record = self._command(cell)
        self.assertEqual(record["status"], "ok")
        self.assertNotIn("detail", record)
        result = next(e for e in cell.events if e.get("event") == "result")
        # Display-only: the model's own tool result still carries the command's real output.
        self.assertIn(_OLD_KEY, result["text"])

    def test_a_cat_of_an_env_files_last_line_is_withheld_from_detail(self):
        self.write(".env", f"OPENAI_API_KEY={_OLD_KEY}\n")
        cell = self.kernel.run("r = await bash('cat .env')\nr.output")
        record = self._command(cell)
        self.assertNotIn("detail", record)
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertIn(_OLD_KEY, result["text"])

    def test_a_failing_commands_leaked_detail_is_withheld_too(self):
        # A failing command's detail is "exit <code> · <last line>"; a leaked last line withholds
        # the whole detail, same as a passing command's.
        cell = self.kernel.run(f"r = await bash('echo {_OLD_KEY}; exit 3')\nr.output")
        record = self._command(cell)
        self.assertEqual(record["status"], "error")
        self.assertNotIn("detail", record)
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertIn(_OLD_KEY, result["text"])

    @unittest.skipUnless(HAS_GIT, "the background gap check needs a work tree")
    def test_a_background_commands_finish_detail_never_carries_a_leaked_key(self):
        first = self.kernel.run(f"h = bash('sleep 0.2; echo {_OLD_KEY}')\nh.pid")
        time.sleep(0.8)  # the model thinking: the command ends while no cell runs
        second = self.kernel.run("x = 1")
        commands = [r for r in second.activities().values() if r["kind"] == "command"]
        self.assertEqual(len(commands), 1, commands)
        self.assertEqual((commands[0]["status"], commands[0]["background"]), ("ok", True))
        # The key stays out of the recorded output; the command's own label (its source line,
        # which the model wrote) is untouched, so it alone is not enough to prove the fix.
        self.assertNotIn("detail", commands[0])


@unittest.skipUnless(HAS_GIT and os.name == "posix", "needs git and a POSIX shell")
class TempFileTests(TrackerCase):
    def _all_paths(self, *cells: Cell) -> set[str]:
        return {record.get("relPath") or record["path"] for cell in cells for record in cell.payloads(FILE)}

    def test_a_sed_temp_file_left_at_the_cells_end_is_never_a_creation(self):
        # BSD sed's in-place edit, slowed down: the new content sits in `.!<pid>!a.txt` as the cell
        # ends and is renamed over a.txt while no cell runs.
        first = self.kernel.run(
            "await bash('printf \"one\\\\nTWO\\\\nthree\\\\n\" > .!4242!a.txt')\n"
            "h = bash('sleep 0.3; mv .!4242!a.txt a.txt')\nh.pid"
        )
        time.sleep(1.2)
        second = self.kernel.run("x = 1")
        self.assertEqual(self._all_paths(first, second), {"a.txt"})
        record = second.by_rel()["a.txt"]
        self.assertEqual((record["kind"], record["source"]), ("modified", "shell"))
        self.assertIn("-two\n+TWO\n", record["diff"])

    @unittest.skipUnless(sys.platform == "darwin", "only BSD sed (macOS) edits through a .!<pid>!<name> file")
    def test_an_unawaited_sed_on_a_large_file_reports_the_file_and_never_its_temp_copy(self):
        self.write("big.txt", "".join(f"line {i:06d} padding padding padding padding padding\n" for i in range(400_000)))
        _git(self.root, "add", "big.txt")
        _git(self.root, "commit", "-qm", "big")
        first = self.kernel.run("h = bash('sed -i \"\" \"s/line 050000/line 050000 SED/\" big.txt')\nh.pid")
        time.sleep(2.0)
        second = self.kernel.run("x = 1")
        self.assertEqual(_git(self.root, "status", "--porcelain"), " M big.txt\n")
        self.assertEqual(self._all_paths(first, second), {"big.txt"})
        shown = {**first.by_rel(), **second.by_rel()}
        self.assertEqual(shown["big.txt"]["kind"], "modified")


@unittest.skipUnless(HAS_GIT and os.name == "posix", "needs git and symlinks")
class SymlinkTests(TrackerCase):
    def test_a_python_write_through_a_link_is_filed_under_the_real_file(self):
        os.symlink("a.txt", self.path("link.txt"))
        _git(self.root, "add", "link.txt")
        _git(self.root, "commit", "-qm", "link")
        cell = self.kernel.run("open('link.txt', 'a').write('via link\\n')\nopen('a.txt', 'a').write('direct\\n')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["a.txt"])
        self.assertEqual((files["a.txt"]["added"], files["a.txt"]["removed"]), (2, 0))
        self.assertIn("+via link\n+direct\n", files["a.txt"]["diff"])

    def test_a_new_link_is_a_link_without_its_targets_lines(self):
        cell = self.kernel.run("await bash('ln -s a.txt blink.txt')")
        record = cell.by_rel()["blink.txt"]
        self.assertEqual(record["kind"], "created")
        self.assertTrue(record["symlink"])
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertNotIn("diff", record)
        cell = self.kernel.run("import os\nos.remove('blink.txt')")
        record = cell.by_rel()["blink.txt"]
        self.assertEqual((record["kind"], record["removed"], record["symlink"]), ("deleted", 0, True))
        self.assertTrue(os.path.exists(self.path("a.txt")))

    def test_an_untracked_link_does_not_double_a_change_to_its_target(self):
        os.symlink("a.txt", self.path("blink.txt"))
        cell = self.kernel.run("await bash('echo q >> a.txt')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["a.txt"])
        self.assertEqual(files["a.txt"]["added"], 1)


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class ManyCommandsTests(TrackerCase):
    def test_a_loop_of_commands_keeps_the_final_comparison_intact(self):
        cell = self.kernel.run(
            "for i in range(150):\n    await bash('true')\nawait bash('echo done > last.txt')\n"
        )
        self.assertEqual(cell.status, "ok")
        commands = [record for record in cell.activities().values() if record["kind"] == "command"]
        self.assertEqual(len(commands), 151)
        self.assertTrue(all(record["status"] == "ok" for record in commands))
        # Live mid-cell comparisons are rate-limited and run on the tracker's own budget, so the
        # cell's budget is still there for the final comparison: a real diff, nothing partial.
        self.assertEqual(cell.payloads(STATUS), [])
        record = cell.by_rel()["last.txt"]
        self.assertEqual(record["source"], "shell")
        self.assertIn("+done\n", record["diff"])


# A `git` that sleeps on `status` while a marker file exists and is the real git otherwise.
_SLOW_GIT = """#!/bin/sh
case " $* " in
  *" status "*) if [ -f "$SLOW_GIT_MARKER" ]; then exec sleep 5; fi ;;
esac
exec "{real}" "$@"
"""
# A `git` whose `check-ignore` is slower than a watcher tick, and never answers while the marker exists.
_SLOW_IGNORE_GIT = """#!/bin/sh
case " $* " in
  *" check-ignore "*) if [ -f "$SLOW_GIT_MARKER" ]; then exec sleep 5; fi; sleep 0.15 ;;
esac
exec "{real}" "$@"
"""


def _fake_git_env(tmp: str, script: str) -> dict[str, str]:
    fake_bin = os.path.join(tmp, "fake-bin")
    os.makedirs(fake_bin)
    fake = os.path.join(fake_bin, "git")
    with open(fake, "w") as handle:
        handle.write(script.format(real=shutil.which("git")))
    os.chmod(fake, 0o755)
    # The first run of a freshly written executable can take ~0.4 s on macOS while the system
    # vets it; pay that here, or the fixture itself looks like a slow git to the budget.
    subprocess.run([fake, "--version"], check=True, capture_output=True, timeout=30)
    return {
        "PATH": fake_bin + os.pathsep + os.environ.get("PATH", ""),
        "SLOW_GIT_MARKER": os.path.join(tmp, "slow-git"),
    }


# Past the budget, what a cell may cost on top: kernel round trip and scheduling. A tracker that
# waited for git twice (or for git's own timeout) overshoots it.
_BUDGET_SLACK_S = 0.35


@unittest.skipUnless(HAS_GIT and os.name == "posix", "needs git and a POSIX shell")
class SlowGitTests(TrackerCase):
    """A slow `git status` (a huge repository, a cold disk) may cost a cell at most its budget."""

    def kernel_env(self) -> dict[str, str]:
        env = _fake_git_env(self.tmp, _SLOW_GIT)
        self.marker = env["SLOW_GIT_MARKER"]
        return env

    def slow(self, on: bool) -> None:
        if on:
            open(self.marker, "w").close()
        elif os.path.exists(self.marker):
            os.remove(self.marker)

    def timed(self, code: str) -> tuple[Cell, float, float]:
        sent = time.time()
        cell = self.kernel.run(code)
        return cell, sent, time.time() - sent

    def test_cell_start_never_waits_for_the_snapshot_of_earlier_commands(self):
        self.kernel.run("h = bash('sleep 4')\nh.pid")
        self.slow(True)
        try:
            cell, sent, elapsed = self.timed("import time\nprint(time.time())")
        finally:
            self.slow(False)
        body_started = float(cell.stdout().split()[0])
        self.assertLess(body_started - sent, effects.DEFAULT_CELL_BUDGET_S - 0.05)
        self.assertLess(elapsed, effects.DEFAULT_CELL_BUDGET_S + 0.7)
        self.assertIn("snapshot", cell.payloads(STATUS)[0]["incomplete"])
        self.kernel.run("h.kill()")

    def test_a_background_end_with_a_slow_git_never_holds_up_the_next_cell(self):
        self.kernel.run("h = bash('sleep 0.2; echo late > late.txt')\nh.pid")
        self.slow(True)
        try:
            time.sleep(0.6)  # the command has ended; its comparison is stuck on git
            cell, sent, elapsed = self.timed("import time\nprint(time.time())")
            time.sleep(0.5)
            later = self.kernel.run("x = 1")
        finally:
            self.slow(False)
        body_started = float(cell.stdout().split()[0])
        self.assertLess(body_started - sent, effects.DEFAULT_CELL_BUDGET_S - 0.05)
        self.assertLess(elapsed, effects.DEFAULT_CELL_BUDGET_S + _BUDGET_SLACK_S)
        reasons = [status["incomplete"] for status in cell.payloads(STATUS) + later.payloads(STATUS)]
        self.assertEqual(len(reasons), 1, reasons)
        self.assertIn("background command", reasons[0])

    def test_a_command_waits_at_most_the_budget_for_its_snapshot(self):
        self.slow(True)
        try:
            cell, _, elapsed = self.timed("r = await bash('echo x > y.txt')\nprint(r.exit_code)")
        finally:
            self.slow(False)
        self.assertEqual(cell.stdout().strip(), "0")
        self.assertLess(elapsed, effects.DEFAULT_CELL_BUDGET_S + _BUDGET_SLACK_S)
        self.assertIn("snapshot", cell.payloads(STATUS)[0]["incomplete"])
        # Without a trustworthy before-state the command's edit is not guessed at.
        self.assertNotIn("y.txt", cell.by_rel())
        self.assertTrue(os.path.exists(self.path("y.txt")))

    def test_an_interrupt_while_collecting_changes_interrupts_the_cell(self):
        cell = self.kernel.run(f"await bash('touch {self.marker}')", interrupt_after=0.25)
        self.slow(False)
        self.assertEqual(cell.status, "error")
        self.assertEqual(cell.error()["ename"], "KeyboardInterrupt")
        self.assertIn("interrupted while collecting changes", cell.payloads(STATUS)[0]["incomplete"])

    def test_a_slow_final_comparison_is_given_up_within_the_budget(self):
        cell, _, elapsed = self.timed(
            f"await bash('touch {self.marker} && echo z > z.txt')\nopen('p.txt', 'w').write('p')"
        )
        self.slow(False)
        self.assertEqual(cell.status, "ok")
        self.assertLess(elapsed, effects.DEFAULT_CELL_BUDGET_S + _BUDGET_SLACK_S)
        self.assertIn("comparing", cell.payloads(STATUS)[0]["incomplete"])
        # Python's own writes do not depend on git and are still listed.
        self.assertEqual(cell.by_rel()["p.txt"]["kind"], "created")


@unittest.skipUnless(HAS_GIT and os.name == "posix", "needs git and a POSIX shell")
class SlowIgnoreCheckTests(TrackerCase):
    """`git check-ignore` slower than a watcher tick must not let an ignored file through."""

    def kernel_env(self) -> dict[str, str]:
        env = _fake_git_env(self.tmp, _SLOW_IGNORE_GIT)
        self.marker = env["SLOW_GIT_MARKER"]
        return env

    def test_an_ignored_file_is_never_listed_when_the_ignore_check_is_slow(self):
        cell = self.kernel.run(
            "import time\nopen('ignored.txt', 'w').write('x')\nopen('seen.txt', 'w').write('y')\ntime.sleep(1.0)"
        )
        # Not even for a moment: no live record either.
        self.assertEqual([r for r in cell.payloads(FILE) if r.get("relPath") == "ignored.txt"], [])
        self.assertEqual(sorted(cell.by_rel()), ["seen.txt"])
        self.assertEqual(cell.payloads(STATUS), [])

    def test_an_ignore_check_that_never_answers_lists_the_file_and_says_so(self):
        open(self.marker, "w").close()
        started = time.time()
        cell = self.kernel.run("open('ignored.txt', 'w').write('x')")
        elapsed = time.time() - started
        self.assertEqual(sorted(cell.by_rel()), ["ignored.txt"])
        status = cell.payloads(STATUS)
        self.assertEqual(len(status), 1, status)
        self.assertIn("ignores", status[0]["incomplete"])
        self.assertLess(elapsed, effects.DEFAULT_CELL_BUDGET_S + _BUDGET_SLACK_S)


# Drives the tracker's public API in a fresh interpreter, recording every record it sends and
# whether that record's cell had already ended (the kernel sends `done` right after end_cell).
_DRIVER_PRELUDE = """
import json, os, sys, threading, time
from rlm import effects
sent = []
ended = set()
slow = None
def send(cell_id, data):
    if slow is not None:
        slow(data)
    sent.append({"cell": cell_id, "afterDone": cell_id in ended, "data": data})
"""


def _drive_tracker(test: unittest.TestCase, body: str) -> list[dict]:
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="rlm-driver-"))
    test.addCleanup(shutil.rmtree, tmp, True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(_LEAKED_PREFIXES)}
    env["PYTHONPATH"] = SRC + os.pathsep + os.environ.get("PYTHONPATH", "")
    env["PRIME_AGENT_CODING_AGENT_DIR"] = os.path.join(tmp, "agent")
    script = _DRIVER_PRELUDE + body + "\nprint(json.dumps(sent))\n"
    proc = subprocess.run(
        [sys.executable, "-c", script], cwd=tmp, env=env, capture_output=True, text=True, timeout=60
    )
    test.assertEqual(proc.returncode, 0, proc.stderr)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _activities(sent: list[dict]) -> list[dict]:
    return [{"cell": r["cell"], "afterDone": r["afterDone"], **r["data"][ACTIVITY]} for r in sent if ACTIVITY in r["data"]]


class CommandHandOffTests(unittest.TestCase):
    def test_a_command_ending_as_its_cell_ends_never_reports_after_the_cells_done(self):
        sent = _drive_tracker(
            self,
            """
def slow_final(data):
    record = data.get(effects.ACTIVITY_MIME)
    if record is not None and record["status"] != "running":
        time.sleep(0.3)  # the command's final record is still on its way when the cell ends
slow = slow_final
assert effects.install(send, os.getcwd())
effects.begin_cell("c1")
command = effects.command_started("make")
threading.Thread(target=command.finish, args=(0, "all done\\n")).start()
time.sleep(0.05)
effects.end_cell("c1")
ended.add("c1")
time.sleep(0.5)
effects.begin_cell("c2")
effects.end_cell("c2")
ended.add("c2")
""",
        )
        records = _activities(sent)
        self.assertTrue(records)
        # Whatever cell carries it, the outcome reaches the host before that cell's `done`.
        self.assertEqual([r for r in records if r["afterDone"]], [])
        self.assertEqual([r["status"] for r in records if r["status"] != "running"], ["ok"])

    def test_background_completions_past_the_cap_keep_the_newest_and_say_some_were_lost(self):
        extra = 6
        sent = _drive_tracker(
            self,
            f"""
assert effects.install(send, os.getcwd())
effects.begin_cell("c1")
commands = [effects.command_started(f"job {{i}}") for i in range(effects.MAX_PENDING_COMPLETIONS + {extra})]
effects.end_cell("c1")
ended.add("c1")
for command in commands:
    command.finish(0, "ok\\n")
effects.begin_cell("c2")
effects.end_cell("c2")
ended.add("c2")
""",
        )
        records = _activities(sent)
        started = sorted({r["id"] for r in records if r["cell"] == "c1"}, key=lambda i: int(i.split("-")[1]))
        self.assertEqual(len(started), effects.MAX_PENDING_COMPLETIONS + extra)
        reported = [r["id"] for r in records if r["cell"] == "c2" and r["status"] == "ok"]
        self.assertEqual(reported, started[extra:])
        status = [r["data"][STATUS] for r in sent if r["cell"] == "c2" and STATUS in r["data"]]
        self.assertEqual(len(status), 1, status)
        self.assertIn(f"{extra} background commands", status[0]["incomplete"])


class MemoryPendingTests(TrackerCase):
    """A harness write with no live cell must still reach the host's memory feed.

    Regression: `effects.memory_change` returned early when no cell was running, so a
    write from a detached task or background thread was invisible on every channel.
    """

    def _wait_for_state_entries(self, state_file: str, marker: str, count: int) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with open(state_file) as handle:
                    if handle.read().count(marker) >= count:
                        return
            except OSError:
                pass
            time.sleep(0.05)
        self.fail(f"never saw {count} {marker!r} entries in {state_file}")

    def test_a_harness_write_after_its_cell_ended_reports_at_the_next_cell(self):
        state_file = os.path.join(self.tmp, "harness-local", "harness_state.json")
        cell = self.kernel.run(
            "import threading, time\n"
            "def write_late():\n"
            "    time.sleep(0.5)\n"
            "    rlm.harness.create_memory('Late', 'written after the cell', id='late')\n"
            "threading.Thread(target=write_late).start()\n"
        )
        self.assertEqual(cell.status, "ok")
        # The write itself is immediate; only its report waits for the next cell.
        # Poll the state file so the write provably lands between the two cells.
        self._wait_for_state_entries(state_file, '"id": "late"', 1)

        cell2 = self.kernel.run("pass")
        self.assertEqual(cell2.status, "ok")
        memory = cell2.memory()
        self.assertIn(("memory", "session", "late"), memory)
        record = memory[("memory", "session", "late")]
        self.assertEqual(record["op"], "created")
        self.assertEqual(record["after"], "written after the cell")
        # Nothing was retro-attributed to the finished cell.
        self.assertNotIn(("memory", "session", "late"), cell.memory())

    def test_pending_memory_past_the_cap_reports_how_many_were_lost(self):
        state_file = os.path.join(self.tmp, "harness-local", "harness_state.json")
        extra = 5
        total = effects.MAX_PENDING_MEMORY + extra
        cell = self.kernel.run(
            "import threading, time\n"
            "def write_many():\n"
            "    time.sleep(0.5)\n"
            f"    for i in range({total}):\n"
            "        rlm.harness.create_memory(f'M{i}', 'x', id=f'm{i}')\n"
            "threading.Thread(target=write_many).start()\n"
        )
        self.assertEqual(cell.status, "ok")
        self._wait_for_state_entries(state_file, '"id": "m', total)

        cell2 = self.kernel.run("pass")
        self.assertEqual(cell2.status, "ok")
        self.assertEqual(len(cell2.payloads(MEMORY)), effects.MAX_PENDING_MEMORY)
        status = cell2.payloads(STATUS)
        self.assertEqual(len(status), 1, status)
        self.assertIn(f"{extra} harness memory writes", status[0]["incomplete"])


class BudgetTests(TrackerCase):
    extra_env = {"PRIME_AGENT_CHANGE_TRACKING_BUDGET_MS": "1"}

    def test_a_cell_over_budget_says_its_list_is_partial(self):
        cell = self.kernel.run("for i in range(50):\n    open(f'f{i}.txt', 'w').write('x' * 50000)\n")
        self.assertEqual(cell.status, "ok")
        status = cell.payloads(STATUS)
        self.assertEqual(len(status), 1)
        self.assertIn("budget", status[0]["incomplete"])


class ModelOutputParityTests(unittest.TestCase):
    """Tracking must not change anything a cell returns: stdout, stderr, result and error are identical."""

    CELLS = [
        "print('hello')\nopen('a.txt', 'w').write('changed\\n')\n40 + 2",
        "import sys\nr = await bash('echo from-shell; echo err >&2')\nprint(r.output)\nsys.stderr.write('e\\n')",
        "open('b.txt', 'a').write('x')\nraise KeyError('k')",
        "rlm.harness.create_memory('M', 'm', id='m')\nlen(open('a.txt').read())",
    ]

    def _transcript(self, tracking: str) -> list[list[tuple]]:
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="rlm-parity-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        with open(os.path.join(tmp, "a.txt"), "w") as handle:
            handle.write("a\n")
        if HAS_GIT:
            _git(tmp, "init", "-q")
            _git(tmp, "add", ".")
            _git(tmp, "commit", "-qm", "init")
        kernel = Kernel(
            tmp,
            {
                "PRIME_AGENT_CHANGE_TRACKING": tracking,
                "RLM_HARNESS_STATE_DIR": os.path.join(tmp, ".h"),
                "PRIME_AGENT_CODING_AGENT_DIR": os.path.join(tmp, ".agent"),
            },
        )
        self.addCleanup(kernel.close)
        kernel.run("import rlm\nbash = rlm.bash")
        transcript = []
        for code in self.CELLS:
            cell = kernel.run(code)
            events = []
            for event in cell.events:
                kind = event.get("event")
                if kind in ("stdout", "stderr"):
                    events.append((kind, event["text"]))
                elif kind == "result":
                    events.append((kind, event["text"]))
                elif kind == "error":
                    events.append((kind, event["ename"], event["evalue"], "".join(event["traceback"])))
                elif kind == "done":
                    events.append((kind, event["status"]))
            merged: list[tuple] = []
            for item in events:
                # Frame boundaries carry no meaning; compare concatenated text per stream.
                if merged and item[0] in ("stdout", "stderr") and merged[-1][0] == item[0]:
                    merged[-1] = (item[0], merged[-1][1] + item[1])
                else:
                    merged.append(item)
            transcript.append(merged)
        return transcript

    def test_cell_output_is_identical_with_tracking_on_and_off(self):
        off = self._transcript("0")
        on = self._transcript("1")
        self.assertEqual(len(off), len(self.CELLS))
        self.assertEqual(on, off)


@unittest.skipUnless(HAS_GIT, "git is needed for the work-tree comparison")
class PerformanceTests(unittest.TestCase):
    def test_synthetic_repo_with_thousands_of_files_stays_fast(self):
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="rlm-perf-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for directory in range(40):
            os.makedirs(os.path.join(tmp, f"pkg{directory}"))
            for index in range(75):
                target = os.path.join(tmp, f"pkg{directory}", f"m{index}.py")
                with open(target, "w") as handle:
                    handle.write(f"value = {index}\n" * 20)
                # Older than the index, like any real checkout: files as new as the index are
                # "racily clean" and git re-hashes all of them on every status.
                os.utime(target, (time.time() - 3600, time.time() - 3600))
        _git(tmp, "init", "-q")
        _git(tmp, "add", ".")
        _git(tmp, "commit", "-qm", "init")
        timings: dict[str, dict[str, float]] = {}
        for tracking in ("0", "1"):
            kernel = Kernel(tmp, {"PRIME_AGENT_CHANGE_TRACKING": tracking, "PRIME_AGENT_CODING_AGENT_DIR": tmp + "/.a"})
            try:
                kernel.run("import rlm\nbash = rlm.bash")
                runs: dict[str, list[float]] = {"python": [], "shell": []}
                for round_index in range(5):
                    for label, code in (
                        ("python", f"open('pkg1/m1.py', 'w').write('v = {round_index}\\n')"),
                        ("shell", f"await bash('echo {round_index} >> pkg2/m2.py')"),
                    ):
                        started = time.perf_counter()
                        cell = kernel.run(code)
                        runs[label].append(time.perf_counter() - started)
                        self.assertEqual(cell.status, "ok")
                        if tracking == "1":
                            self.assertEqual(len(cell.files()), 1, cell.payloads(FILE))
                timings[tracking] = {label: sorted(values)[len(values) // 2] for label, values in runs.items()}
            finally:
                kernel.close()
        added = {label: (timings["1"][label] - timings["0"][label]) * 1000 for label in ("python", "shell")}
        print(f"\n[effects] 3000-file repo, added per cell: python write {added['python']:.1f} ms, shell {added['shell']:.1f} ms")
        self.assertLess(added["python"], 50)
        # Two `git status` runs bound the shell case; generous for loaded CI machines.
        self.assertLess(added["shell"], 250)


class UnitTests(unittest.TestCase):
    def test_unified_diff_matches_difflib_hunks(self):
        old = "".join(f"line {i}\n" for i in range(60))
        new = old.replace("line 10\n", "line ten\n").replace("line 50\n", "") + "tail"
        lines, added, removed = effects._unified_diff(old, new, "a/x", "b/x")
        expected = list(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "a/x", "b/x"))
        ours = [line for line in lines if not line.startswith("\\")]
        normalized = [line if line.endswith("\n") else line + "\n" for line in expected]
        self.assertEqual(ours, normalized)
        # line 10 replaced (+1 -1), line 50 removed (-1), "tail" appended without a newline (+1).
        self.assertEqual((added, removed), (2, 2))

    def test_status_v2_parser_reads_every_record_kind(self):
        raw = (
            b"# branch.oid 0123abcd\0# branch.head main\0"
            b"1 .M N... 100644 100644 100644 aaaa bbbb dir/mod.txt\0"
            b"2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt\0old.txt\0"
            b"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt\0"
            b"? untracked file.txt\0"
        )
        oid, entries = effects._parse_status_v2(raw, "/r")
        self.assertEqual(oid, "0123abcd")
        self.assertEqual(
            entries,
            {
                "/r/dir/mod.txt": ".M",
                "/r/new name.txt": "R.",
                "/r/conflict.txt": "UU",
                "/r/untracked file.txt": "??",
            },
        )

    def test_command_summaries(self):
        self.assertEqual(effects._command_summary(0, "a\n===== 54 passed, 2 skipped in 3.20s =====\n"), "54 passed, 2 skipped")
        self.assertEqual(effects._command_summary(1, " Tests  3 failed | 51 passed (54)\n"), "3 failed | 51 passed · exit 1")
        self.assertEqual(effects._command_summary(0, "Ran 7 tests in 0.2s\n\nOK\n"), "7 tests, OK")
        self.assertEqual(effects._command_summary(2, "boom\n"), "exit 2 · boom")
        self.assertEqual(effects._command_summary(0, "\x1b[32mdone\x1b[0m\n"), "done")
        self.assertIsNone(effects._command_summary(0, ""))


    def test_sensitive_file_names(self):
        sensitive = [
            ".env", ".env.production", "prod.env", "server.pem", "tls.key", "cert.p12", "id_rsa", "id_ed25519.pub",
            ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json", "secrets.yaml", "db-credentials.toml",
            "client_secret", "release.keystore", "terraform.tfvars", "/home/u/.ssh/config", "/home/u/.aws/config",
        ]
        ordinary = ["secret_manager.py", "secrets_test.go", "token.ts", "keyboard.py", "README.md", "env.py", "a/b/c.txt"]
        self.assertGreater(len(sensitive), 0)
        for name in sensitive:
            self.assertTrue(effects._sensitive_path(name), name)
        for name in ordinary:
            self.assertFalse(effects._sensitive_path(name), name)

    def test_secret_scan_shapes_and_assignments(self):
        secrets = [
            "+" + "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
            "+key = sk-" + "ant-" + "a" * 30,
            "+AWS=" + "ASIA" + "B" * 16,
            "+t = 'ghp_" + "c" * 36 + "'",
            "+github_pat_" + "d" * 30,
            "+slack: xoxb-" + "1" * 12,
            "+glpat-" + "e" * 20,
            "+maps AIza" + "f" * 35,
            "+jwt eyJ" + "a" * 12 + ".eyJ" + "b" * 12 + "." + "c" * 12,
            '+  "password": "hunter22"',
            "+DB_PASSWORD=s3cr3t-value",
            "+client_secret: 'Zq8-long-value'",
            "+url = postgres://admin:pa55word@db/prod",
            "+Authorization: Bearer " + "g" * 24,
        ]
        ordinary = [
            "+password = request.form['password']",
            "+token = tokenizer(text)",
            "+max_tokens = 4096",
            "+api_key = os.environ['API_KEY']",
            "+secret = None",
            "+PASSWORD=changeme",
            "+API_KEY=${API_KEY}",
            "+token_type = 'access_token'",
            "+if password == 'hunter22':",
            "+task-abcdefghijklmnopqrstuvwxyz",
        ]
        self.assertGreater(len(secrets), 0)
        for text in secrets:
            self.assertTrue(effects._looks_secret(text), text)
        for text in ordinary:
            self.assertFalse(effects._looks_secret(text), text)

if __name__ == "__main__":
    unittest.main()
