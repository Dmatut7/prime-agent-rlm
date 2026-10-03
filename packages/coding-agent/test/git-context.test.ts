import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureGitContext, gitContextsEqual } from "../src/utils/git.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

let reftableSupport: boolean | undefined;
/** Whether the git on this machine can init a reftable repo (git >= 2.45). */
function supportsReftable(): boolean {
	if (reftableSupport === undefined) {
		const probe = mkdtempSync(join(tmpdir(), "git-reftable-probe-"));
		try {
			execFileSync("git", ["init", "-q", "--ref-format=reftable", "repo"], { cwd: probe, stdio: "ignore" });
			reftableSupport = true;
		} catch {
			reftableSupport = false;
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
	}
	return reftableSupport;
}

describe("captureGitContext", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "git-context-"));
		// The developer's global git config (e.g. a url.insteadOf rewrite) must not
		// change what these repos report; point git at an empty global config.
		const emptyConfig = join(dir, ".gitconfig-empty");
		writeFileSync(emptyConfig, "");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads branch, commit, and normalized repo url", () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		const sha = commit(dir, "init");

		expect(captureGitContext(dir)).toEqual({
			branch: "main",
			commit: sha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("reports a detached HEAD as a commit with no branch", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		git(dir, "checkout", "-q", sha);

		const ctx = captureGitContext(dir);
		expect(ctx?.commit).toBe(sha);
		expect(ctx?.branch).toBeUndefined();
	});

	it("omits repo url when there is no origin remote", () => {
		initRepo(dir);
		const sha = commit(dir, "init");

		const ctx = captureGitContext(dir);
		expect(ctx?.repoUrl).toBeUndefined();
		expect(ctx?.commit).toBe(sha);
	});

	it("keeps an ssh remote url verbatim when it cannot be normalized", () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "git@github.com:acme/widgets.git");
		commit(dir, "init");

		expect(captureGitContext(dir)?.repoUrl).toBe("git@github.com:acme/widgets.git");
	});

	it("returns null outside a git repo", () => {
		expect(captureGitContext(dir)).toBeNull();
	});

	it("reads a packed branch ref after pack-refs", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		git(dir, "pack-refs", "--all");

		expect(captureGitContext(dir)).toEqual({ branch: "main", commit: sha });
	});

	it("reports an unborn branch with no commit", () => {
		initRepo(dir);

		expect(captureGitContext(dir)).toEqual({ branch: "main" });
	});

	it("reads the repo context from a nested subdirectory", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		const nested = join(dir, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(captureGitContext(nested)).toEqual({ branch: "main", commit: sha });
	});

	it("reads the worktree branch through a .git file", () => {
		initRepo(dir);
		commit(dir, "init");
		const worktreeDir = join(dir, "wt");
		git(dir, "worktree", "add", "-q", "-b", "wt-branch", worktreeDir);

		expect(captureGitContext(worktreeDir)?.branch).toBe("wt-branch");
	});

	it("defers to the git CLI when GIT_DIR overrides discovery", () => {
		initRepo(dir);
		commit(dir, "init");
		vi.stubEnv("GIT_DIR", join(dir, "does-not-exist"));

		expect(captureGitContext(dir)).toBeNull();
	});

	it("walks past an embedded empty .git directory like git discovery does", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		const sub = join(dir, "sub");
		mkdirSync(join(sub, ".git"), { recursive: true });

		expect(captureGitContext(sub)).toEqual({ branch: "main", commit: sha });
	});

	it("walks past a .git directory that has HEAD but no object store", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		const sub = join(dir, "sub");
		mkdirSync(join(sub, ".git"), { recursive: true });
		writeFileSync(join(sub, ".git", "HEAD"), "ref: refs/heads/main\n");

		expect(captureGitContext(sub)).toEqual({ branch: "main", commit: sha });
	});

	it.skipIf(!supportsReftable())("reads a reftable repository through the git CLI fallback", () => {
		const repo = join(dir, "reftable-repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "--ref-format=reftable", "-b", "main");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		const sha = commit(repo, "init");

		// The HEAD file in a reftable repo is a placeholder ("refs/heads/.invalid");
		// only the git CLI reads the real symref out of the reftable.
		expect(captureGitContext(repo)).toEqual({ branch: "main", commit: sha });
	});
});

describe("gitContextsEqual", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";
	const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

	it("compares all fields", () => {
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA, branch: "main" })).toBe(true);
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA2, branch: "main" })).toBe(false);
		expect(gitContextsEqual({ commit: SHA }, { commit: SHA, branch: "main" })).toBe(false);
	});
});
