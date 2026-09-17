from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock

from rlm import bash

# The package re-exports bash(); reach the module for internals, matching
# test_bash.py's precedent.
bash_module = sys.modules["rlm.bash"]

BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_GIT"


def run_git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def init_dirty_git_repo(root: str) -> None:
    """One committed file plus two uncommitted changes (dirty porcelain: 2)."""
    run_git(root, "init", "-q")
    run_git(root, "config", "user.email", "test@example.com")
    run_git(root, "config", "user.name", "Test")
    run_git(root, "config", "commit.gpgsign", "false")
    with open(os.path.join(root, "tracked.txt"), "w") as f:
        f.write("committed\n")
    run_git(root, "add", "tracked.txt")
    run_git(root, "commit", "-q", "-m", "init")
    with open(os.path.join(root, "tracked.txt"), "w") as f:
        f.write("modified\n")
    with open(os.path.join(root, "untracked.txt"), "w") as f:
        f.write("uncommitted\n")


def commit_all(root: str) -> None:
    run_git(root, "add", "-A")
    run_git(root, "commit", "-q", "-m", "second")


def read_tracked(root: str) -> str:
    with open(os.path.join(root, "tracked.txt")) as f:
        return f.read()


@contextmanager
def chdir(path: str):
    old = os.getcwd()
    os.chdir(path)
    try:
        yield path
    finally:
        os.chdir(old)


def write_stub_git(directory: str, body: str) -> str:
    """A PATH-shadowing `git` stub; returns the directory to put on PATH."""
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "git")
    with open(path, "w") as f:
        f.write(f"#!/bin/sh\n{body}\n")
    os.chmod(path, 0o755)
    return directory


# Matcher vectors mirror the TS face (b0aeef69a,
# packages/coding-agent/test/bash-destructive-git-guard.test.ts) so the two
# faces stay pattern-compatible. `git add -A` / `git add .` / `git stash` are
# deliberately absent from the matches: the sweep family is TS-face only.
MATCHES = [
    "git checkout -- .",
    "git checkout .",
    "git checkout HEAD -- .",
    "git restore .",
    "git restore --source=HEAD~1 .",
    "git clean -f",
    "git clean -fd",
    "git clean -fdx",
    "git clean --force",
    "git reset --hard",
    "git reset --hard HEAD~1",
    "git checkout -b tmp 2>/dev/null; git checkout -- .",
    "git checkout main && git reset --hard",
    "echo start\ngit clean -fd",
    "npm test & git clean -fd &",
    "git checkout :/",
    "git checkout -- :/",
    "git checkout HEAD -- :/",
    "git restore :/",
    "git restore -s@ .",
    "git restore -s@ :/",
    "git restore --source=HEAD :/",
    "git restore -s HEAD~1 :/",
    "git restore -- .",
    "git checkout -- ./",
    "git checkout ./",
    "git restore ./",
    "git -C sub reset --hard",
    "git --git-dir=sub/.git reset --hard",
    "git reset -q --hard",
    "git reset --no-refresh --hard",
    "git -C repo -C nested reset --hard",
    "GIT_DIR=sub/.git git reset --hard",
    "GIT_DIR=sub/.git GIT_WORK_TREE=sub git reset --hard",
    "git checkout -f -- .",
    "git checkout --theirs -- .",
    "git checkout -m .",
    "git checkout --conflict=diff3 .",
    "git checkout HEAD .",
    "git checkout HEAD~1 -- .",
    "git checkout origin/main .",
    "git checkout -f main",
    "git checkout --force main",
    "git clean -f -- -n",
    "cd sub && git reset --hard",
]

DOES_NOT_MATCH = [
    "git status",
    "git log --oneline",
    "git checkout -b new-branch",
    "git checkout main",
    "git checkout -m main",
    "git checkout -b newbranch .",
    "git checkout -- single-file.txt",
    "echo 'git reset --hard'",
    "git commit -m 'git reset --hard'",
    'echo "git clean -fd"',
    "echo preparing # git reset --hard",
    "git checkout ./nested",
    "git restore --staged .",
    "git restore --staged :/",
    "git restore single-file.txt",
    "git clean -n",
    "git clean -n -f .",
    "git clean --dry-run",
    "git clean -d",
    "git reset",
    "git reset --soft HEAD~1",
    # Sweep family: TS face only (second mode group); this face guards discards.
    "git stash",
    "git stash push",
    "git add -A",
    "git add .",
    "git add --all",
    "echo hello world",
    "npm run check",
]


class MatcherVectorTest(unittest.TestCase):
    """1:1 pattern parity with the TS face."""

    def test_matches(self):
        find = getattr(bash_module, "_find_destructive_git_discard_commands", None)
        self.assertIsNotNone(find, "guard matcher missing")
        for command in MATCHES:
            with self.subTest(command=command):
                self.assertTrue(bool(find(command)), command)

    def test_does_not_match(self):
        find = getattr(bash_module, "_find_destructive_git_discard_commands", None)
        self.assertIsNotNone(find, "guard matcher missing")
        for command in DOES_NOT_MATCH:
            with self.subTest(command=command):
                self.assertFalse(bool(find(command)), command)


class GuardSymbolTest(unittest.TestCase):
    def test_refusal_exception_and_bypass_env_name(self):
        refusal = getattr(bash_module, "DestructiveGitRefusalError", None)
        self.assertIsNotNone(refusal, "DestructiveGitRefusalError missing")
        self.assertTrue(issubclass(refusal, RuntimeError))
        self.assertEqual(bash_module.BASH_DESTRUCTIVE_GIT_BYPASS_ENV, BYPASS_ENV)


class GuardBehaviorTest(unittest.IsolatedAsyncioTestCase):
    """bash() refuses destructive git discards on a dirty tree, fails open
    outside a repository or beyond its covered probe scope, and bypasses only
    through the kernel env var."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="py-git-guard-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Never inherit a bypass from the runner environment.
        self.addCleanup(os.environ.pop, BYPASS_ENV, None)
        os.environ.pop(BYPASS_ENV, None)

    def dirty_repo(self, name: str = "repo") -> str:
        root = os.path.join(self.tmp, name)
        os.makedirs(root, exist_ok=True)
        init_dirty_git_repo(root)
        return root

    def clean_repo(self, name: str) -> str:
        root = self.dirty_repo(name)
        commit_all(root)
        return root

    async def assert_refused(self, command: str, workdir: str) -> str:
        # RuntimeError fallback keeps the red run behavior-based: before the
        # guard exists, the discard executes and nothing raises at all.
        refusal = getattr(bash_module, "DestructiveGitRefusalError", RuntimeError)
        with chdir(workdir):
            with self.assertRaises(refusal) as ctx:
                await bash(command)
        return str(ctx.exception)

    async def test_refuses_discards_on_dirty_tree_and_preserves_work(self):
        for command in [
            "git checkout -- .",
            "git checkout .",
            "git checkout ./",
            "git checkout HEAD -- .",
            "git checkout -f -- .",
            "git clean -fd",
            "git reset --hard",
            "git reset -q --hard",
            "git restore .",
        ]:
            with self.subTest(command=command):
                repo = self.dirty_repo(f"repo-{abs(hash(command)) % 100000}")
                message = await self.assert_refused(command, repo)
                self.assertIn("Refusing to run this destructive git command", message)
                self.assertEqual(read_tracked(repo), "modified\n")
                self.assertTrue(os.path.exists(os.path.join(repo, "untracked.txt")))

    async def test_refusal_lists_dirty_paths_and_the_env_bypass(self):
        repo = self.dirty_repo()
        message = await self.assert_refused("git checkout -- .", repo)
        self.assertIn("2 uncommitted change(s)", message)
        self.assertIn("tracked.txt", message)
        self.assertIn("untracked.txt", message)
        self.assertIn(BYPASS_ENV, message)
        self.assertIn("kernel environment", message)

    async def test_refusal_elides_long_dirty_path_lists(self):
        repo = self.dirty_repo()
        for i in range(12):
            with open(os.path.join(repo, f"extra-{i}.txt"), "w") as f:
                f.write("x\n")
        message = await self.assert_refused("git checkout -- .", repo)
        self.assertIn("... and 4 more", message)

    async def test_runs_the_discard_when_the_tree_is_clean(self):
        repo = self.clean_repo("repo")
        with chdir(repo):
            result = await bash("git checkout -- .")
        self.assertEqual(result.exit_code, 0)

    async def test_env_bypass_discards_intentionally(self):
        repo = self.dirty_repo()
        with mock.patch.dict(os.environ, {BYPASS_ENV: "1"}):
            with chdir(repo):
                result = await bash("git reset --hard")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(repo), "committed\n")

    async def test_falsy_env_values_do_not_bypass(self):
        for value, tag in (("0", "zero"), ("", "empty")):
            with self.subTest(value=value):
                repo = self.dirty_repo(f"repo-{tag}")
                with mock.patch.dict(os.environ, {BYPASS_ENV: value}):
                    await self.assert_refused("git reset --hard", repo)

    async def test_inline_child_env_prefix_does_not_bypass(self):
        # Only the kernel process env bypasses; an inline assignment reaches
        # just the child shell, so the discard is still refused.
        repo = self.dirty_repo()
        await self.assert_refused(f"{BYPASS_ENV}=1 git reset --hard", repo)
        self.assertEqual(read_tracked(repo), "modified\n")

    async def test_fails_open_outside_a_git_repository(self):
        with chdir(self.tmp):
            result = await bash("git checkout -- .")
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("not a git repository", result.output)

    async def test_fails_open_when_the_probe_fails(self):
        # The stub fails only for the probe (git status); the discard itself
        # runs and exits 0 through the same stub.
        stub = write_stub_git(
            os.path.join(self.tmp, "stubbin"), 'if [ "$1" = "status" ]; then exit 1; fi\nexit 0'
        )
        repo = self.dirty_repo()
        with mock.patch.dict(os.environ, {"PATH": stub}):
            with chdir(repo):
                result = await bash("git checkout -- .")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(repo), "modified\n")

    async def test_probe_timeout_fails_open(self):
        stub = write_stub_git(
            os.path.join(self.tmp, "slowbin"),
            'if [ "$1" = "status" ]; then sleep 5; exit 1; fi\nexit 0',
        )
        repo = self.dirty_repo()
        with mock.patch.object(bash_module, "_PROBE_TIMEOUT_SECONDS", 0.5), mock.patch.dict(
            os.environ, {"PATH": stub}
        ):
            with chdir(repo):
                result = await bash("git checkout -- .")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(repo), "modified\n")

    async def test_executes_commands_that_quote_a_discard(self):
        repo = self.dirty_repo()
        with chdir(repo):
            result = await bash("echo 'git reset --hard'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("git reset --hard", result.output)
        self.assertEqual(read_tracked(repo), "modified\n")

    async def test_non_discard_commands_run(self):
        repo = self.dirty_repo()
        with chdir(repo):
            for command in ["git status", "git log --oneline", "git add tracked.txt"]:
                with self.subTest(command=command):
                    result = await bash(command)
                    self.assertEqual(result.exit_code, 0)

    async def test_git_dash_c_refuses_a_dirty_nested_repository(self):
        sub = self.dirty_repo("sub")
        message = await self.assert_refused("git -C sub reset --hard", self.tmp)
        self.assertIn("tracked.txt", message)
        self.assertEqual(read_tracked(sub), "modified\n")

    async def test_git_dash_c_runs_when_the_target_is_clean(self):
        self.clean_repo("sub")
        with chdir(self.tmp):
            result = await bash("git -C sub reset --hard")
        self.assertEqual(result.exit_code, 0)

    async def test_repeated_git_dash_c_targets_the_chained_repository(self):
        nested = self.dirty_repo(os.path.join("repo", "nested"))
        message = await self.assert_refused("git -C repo -C nested reset --hard", self.tmp)
        self.assertIn("tracked.txt", message)
        self.assertEqual(read_tracked(nested), "modified\n")

    async def test_cd_chains_fail_open_documented_boundary(self):
        # Out of the Python face's covered scope (direct forms + git -C): the
        # discard runs unchecked. Pins the boundary so widening it is a
        # deliberate change.
        sub = self.dirty_repo("sub")
        with chdir(self.tmp):
            result = await bash("cd sub && git reset --hard")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(sub), "committed\n")

    async def test_quoted_git_dash_c_fails_open_documented_boundary(self):
        sub = self.dirty_repo("sub")
        with chdir(self.tmp):
            result = await bash('git -C "sub" reset --hard')
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(sub), "committed\n")

    async def test_relocating_env_assignment_fails_open_documented_boundary(self):
        self.clean_repo("sub")
        with chdir(self.tmp):
            result = await bash("GIT_DIR=sub/.git git reset --hard")
        self.assertEqual(result.exit_code, 0)

    async def test_git_dir_global_option_fails_open_documented_boundary(self):
        self.clean_repo("sub")
        with chdir(self.tmp):
            result = await bash("git --git-dir=sub/.git reset --hard")
        self.assertEqual(result.exit_code, 0)

    async def test_command_prefix_disables_the_guard_documented_boundary(self):
        # A configured prefix runs before every command and may relocate the
        # discard; this face does not replay it, so it skips the guard.
        repo = self.dirty_repo()
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "echo prefixed"}):
            with chdir(repo):
                result = await bash("git reset --hard")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(read_tracked(repo), "committed\n")

    async def test_multi_discard_commands_are_refused(self):
        repo = self.dirty_repo()
        await self.assert_refused("git checkout -- . && git reset --hard", repo)

    async def test_clean_dry_run_is_not_refused(self):
        repo = self.dirty_repo()
        with chdir(repo):
            result = await bash("git clean -n")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(os.path.exists(os.path.join(repo, "untracked.txt")))

    async def test_clean_force_with_pathspec_n_is_refused(self):
        repo = self.dirty_repo()
        await self.assert_refused("git clean -f -- -n", repo)

    async def test_branch_creation_is_not_refused(self):
        repo = self.dirty_repo()
        with chdir(repo):
            result = await bash("git checkout -b fresh")
        self.assertEqual(result.exit_code, 0)

    async def test_clean_dash_x_lists_ignored_files(self):
        repo = self.clean_repo("repo")
        with open(os.path.join(repo, ".gitignore"), "w") as f:
            f.write("ignored.txt\n")
        run_git(repo, "add", ".gitignore")
        run_git(repo, "commit", "-q", "-m", "gitignore")
        with open(os.path.join(repo, "ignored.txt"), "w") as f:
            f.write("generated\n")
        message = await self.assert_refused("git clean -fx", repo)
        self.assertIn("uncommitted or ignored file(s)", message)
        self.assertIn("ignored.txt", message)
        self.assertTrue(os.path.exists(os.path.join(repo, "ignored.txt")))

    async def test_clean_dash_f_runs_when_only_ignored_files_exist(self):
        repo = self.clean_repo("repo")
        with open(os.path.join(repo, ".gitignore"), "w") as f:
            f.write("ignored.txt\n")
        run_git(repo, "add", ".gitignore")
        run_git(repo, "commit", "-q", "-m", "gitignore")
        with open(os.path.join(repo, "ignored.txt"), "w") as f:
            f.write("generated\n")
        with chdir(repo):
            result = await bash("git clean -f")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(os.path.exists(os.path.join(repo, "ignored.txt")))

    async def test_detects_untracked_files_despite_status_config(self):
        repo = self.clean_repo("repo")
        with open(os.path.join(repo, "fresh-untracked.txt"), "w") as f:
            f.write("new\n")
        run_git(repo, "config", "status.showUntrackedFiles", "no")
        message = await self.assert_refused("git clean -fd", repo)
        self.assertIn("fresh-untracked.txt", message)
        self.assertTrue(os.path.exists(os.path.join(repo, "fresh-untracked.txt")))

    async def test_wrapper_prefixed_discards_are_refused(self):
        for command in ["sudo git reset --hard", "/usr/bin/git reset --hard"]:
            with self.subTest(command=command):
                repo = self.dirty_repo(f"wrap-{abs(hash(command)) % 100000}")
                await self.assert_refused(command, repo)
                self.assertEqual(read_tracked(repo), "modified\n")


if __name__ == "__main__":
    unittest.main()
