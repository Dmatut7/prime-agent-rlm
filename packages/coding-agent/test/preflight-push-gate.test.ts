import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/preflight-push.sh` is the certificate a commit gets before it is pushed, so it is tested
 * from the outside: the gate is copied into a throwaway repository together with every script it
 * invokes, and `gh` and `npm` are replaced by fixtures on `PATH`. A gate that cannot be made to
 * refuse is not a gate, and a gate that cannot be made to pass is not usable either.
 *
 * The fixtures own every input the gate reads from the environment. An inherited
 * `PREFLIGHT_RED_REVISION_REASON` overrides the revision verdict, and an inherited `GH_BIN` points
 * the verdict query at a real, authenticated `gh` - so a case that reads the host environment
 * decides its own outcome on the machine that exported them and flips on a CI runner.
 */
const SCRIPTS_DIR = fileURLToPath(new URL("../../../scripts/", import.meta.url));

/**
 * The gate plus the helper it runs twice: step 0 asks `latest-ci-run.sh --print-repo` which
 * repository the questions are about, and step 4 asks it for the revision's verdict. Staging only
 * the gate made the passing case unpassable - `preflight-push.sh` starts with
 * `cd "$(dirname "$0")/.."` and then runs `bash scripts/latest-ci-run.sh`, so a fixture repository
 * without that file cannot reach the success line on any machine. The helper is part of what the
 * gate invokes, so it is part of what a fixture repository has to carry.
 */
const GATED_SCRIPTS = ["preflight-push.sh", "latest-ci-run.sh"];

/**
 * The remote the fixture repository pushes to. Step 0 resolves it and every gh question is pinned
 * to it: this checkout carries four remotes and bare `gh` resolved its default repository to
 * `upstream`, which made "no run in flight" and "never pushed" the answers for a branch CI runs on
 * every day. A fixture without an origin cannot exercise the pinned path at all.
 */
const FIXTURE_ORIGIN = "https://github.com/fixture/example.git";
const FIXTURE_REPO = "fixture/example";

/**
 * Host state that changes what "a healthy gh" or "a clean tree" means, stripped from every gate
 * run: the two overrides above, `gh` and `gh api` credentials and host pins, the git hook
 * environment (`GIT_DIR` and friends are set for a pre-push hook and would point the fixture's git
 * queries at the invoking repository), and this agent family's session variables.
 */
const HOST_STATE =
	/^(PREFLIGHT_|GH_|GITHUB_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_COMMON_DIR$|GIT_PREFIX$|GIT_CONFIG|RLM_|PRIME_AGENT_|PI_)/;

interface Fixture {
	root: string;
	bin: string;
}

/** Fixtures a case created, removed after it: a gate test must not litter the temp directory. */
const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `process.env` without the host state the gate reads; a fixture repo is built in it too. */
function hostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || HOST_STATE.test(name)) continue;
		env[name] = value;
	}
	return env;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "preflight-gate-repo-"));
	// The fixture's own git calls go through the same filter: an inherited `GIT_DIR` points them at
	// the repository that started the test run, and `git add` then dies outside a work tree.
	const git = { env: hostEnv() };
	execFileSync("git", ["init", "-q", root], git);
	execFileSync("git", ["-C", root, "remote", "add", "origin", FIXTURE_ORIGIN], git);
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	execFileSync("git", ["-C", root, "add", "tracked.txt"], git);
	execFileSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.email=preflight@example.test",
			"-c",
			"user.name=preflight",
			"commit",
			"-q",
			"-m",
			"init",
		],
		git,
	);
	mkdirSync(join(root, "scripts"));
	for (const name of GATED_SCRIPTS) copyFileSync(join(SCRIPTS_DIR, name), join(root, "scripts", name));
	const bin = mkdtempSync(join(tmpdir(), "preflight-gate-bin-"));
	createdDirs.push(root, bin);
	return { root, bin };
}

/** Writes an executable fixture. The caller owns the shebang line. */
function writeFixtureTool(bin: string, name: string, contents: string): void {
	const path = join(bin, name);
	writeFileSync(path, `${contents}\n`);
	chmodSync(path, 0o755);
}

/**
 * A `gh` that answers both queries the gate makes, one answer per query so a refusal can be
 * attributed: `--jq` marks the in-flight count query (step 2), anything else is the verdict query
 * the step-4 helper makes. The verdict echoes back the `--commit` it was asked about, because the
 * fixture revision is not known when the stub is written.
 */
function ghStub(inFlight: string, verdict: string): string {
	return `#!/bin/sh
if [ -n "\${GH_ARGS_LOG:-}" ]; then
  printf '#ARGS\n' >> "$GH_ARGS_LOG"
  printf '%s\n' "$@" >> "$GH_ARGS_LOG"
fi
for arg in "$@"; do
  if [ "$arg" = "--jq" ]; then
${inFlight}
  fi
done
commit=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--commit" ]; then
    commit="$arg"
  fi
  previous="$arg"
done
${verdict}
`;
}

const IN_FLIGHT_NONE = "echo 0\nexit 0";

/** A completed run of the given conclusion, in the shape `gh run list --json` answers with. */
function runVerdict(databaseId: number, conclusion: string): string {
	return (
		`printf '%s' '[{"databaseId":${databaseId},"headSha":"'"$commit"'","status":"completed",` +
		`"conclusion":"${conclusion}","workflowName":"CI","createdAt":"2026-09-15T12:00:00Z",` +
		`"url":"https://example.invalid/runs/${databaseId}"}]'\nexit 0`
	);
}

const VERDICT_GREEN = runVerdict(41, "success");

/** `gh` that answers "nothing in flight" and a green revision the way a healthy client does. */
function healthyGh(bin: string): void {
	writeFixtureTool(bin, "gh", ghStub(IN_FLIGHT_NONE, VERDICT_GREEN));
}

/** `gh` whose in-flight query fails: logged out, offline, or rate limited. */
function failingGh(bin: string): void {
	const inFlight = 'echo "gh: could not authenticate to GitHub" >&2\nexit 1';
	writeFixtureTool(bin, "gh", ghStub(inFlight, VERDICT_GREEN));
}

/** `gh` that "succeeds" with an answer that is not a run count, e.g. a message on stdout. */
function unreadableGh(bin: string): void {
	const inFlight = 'echo "error: not logged in"\nexit 0';
	writeFixtureTool(bin, "gh", ghStub(inFlight, VERDICT_GREEN));
}

/** A `gh` that answers step 2 and cannot answer step 4: the verdict query exits non-zero. */
function unverdictableGh(bin: string): void {
	const verdict = 'echo "gh: HTTP 502 from the API" >&2\nexit 4';
	writeFixtureTool(bin, "gh", ghStub(IN_FLIGHT_NONE, verdict));
}

/** A `gh` that answers step 2 and answers step 4 with something that is not JSON. */
function garbagedGh(bin: string): void {
	writeFixtureTool(bin, "gh", ghStub(IN_FLIGHT_NONE, "printf '%s' 'not json at all'\nexit 0"));
}

/** A `gh` that reports a finished run for this revision that CI did not conclude green. */
function redRevisionGh(bin: string): void {
	writeFixtureTool(bin, "gh", ghStub(IN_FLIGHT_NONE, runVerdict(42, "cancelled")));
}

/** `npm run check` replaced by a fixture: this test is about the gate, not about the checks. */
function passingNpm(bin: string): void {
	writeFixtureTool(bin, "npm", "#!/bin/sh\nexit 0");
}

/** The environment a developer pushing from this repository would have, minus host gate state. */
function gateEnv(fixture: Fixture, planted: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...hostEnv(),
		PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
		PREFLIGHT_BRANCH: "main",
		...planted,
	};
}

function runPreflight(
	fixture: Fixture,
	options: { timeoutMs?: number; planted?: Record<string, string> } = {},
): { status: number | null; signal: string | null; output: string } {
	const result = spawnSync("bash", [join(fixture.root, "scripts", "preflight-push.sh"), "--skip-tests"], {
		cwd: fixture.root,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 20_000,
		env: gateEnv(fixture, options.planted ?? {}),
	});
	return { status: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("preflight-push gate", () => {
	it("stages every script the gate invokes by name", () => {
		// The gate grew a step 4/4 that shells out to a second script and the fixture kept staging
		// one file, which made the passing case unpassable on every machine. A helper invoked in the
		// shape the gate uses today has to be staged, or this case says so before the shard does.
		const gate = readFileSync(join(SCRIPTS_DIR, "preflight-push.sh"), "utf8");
		const invoked = [...gate.matchAll(/\bbash\s+(?:\S+\/)*?scripts\/([\w.-]+\.sh)/g)].map((match) => match[1]);
		expect(invoked.length).toBeGreaterThan(0);
		for (const name of invoked) expect(GATED_SCRIPTS).toContain(name);
	});

	it("refuses to push when the gh query fails, instead of reporting a clean preflight", () => {
		const fixture = makeFixture();
		failingGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		// Refused, and refused by itself: a killed or timed-out run proves nothing about the gate.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/gh/i);
	});

	it("refuses to push when gh cannot be run at all", () => {
		const fixture = makeFixture();
		// An executable that cannot start: the same shape as a broken install or a wrapper whose
		// interpreter is gone, and the one case a `|| echo 0` fallback reads as "no run in flight".
		writeFixtureTool(fixture.bin, "gh", "#!/nonexistent/interpreter");
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		// Refused, and refused by itself: a killed or timed-out run proves nothing about the gate.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/gh/i);
	});

	it("refuses to push when gh answers with something that is not a run count", () => {
		const fixture = makeFixture();
		unreadableGh(fixture.bin);
		passingNpm(fixture.bin);
		// A short timeout: an answer the gate cannot read must end the run, not start the wait loop.
		const result = runPreflight(fixture, { timeoutMs: 8_000 });
		expect(result.output).not.toContain("safe to push");
		// Refused, and refused by itself: a killed or timed-out run proves nothing about the gate.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/gh/i);
	});

	it("refuses to push when the verdict query cannot be answered", () => {
		const fixture = makeFixture();
		// Nothing in flight and green checks: the only thing left to fail on is step 4's question.
		unverdictableGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/cannot query GitHub/i);
	});

	it("refuses to push when gh answers the verdict query with something that is not JSON", () => {
		const fixture = makeFixture();
		garbagedGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/not JSON/i);
	});

	it("refuses to push a revision whose latest CI run did not succeed", () => {
		const fixture = makeFixture();
		redRevisionGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		// The refusal names the run, which is the whole point of step 4: a green claim has a witness.
		expect(result.output).toMatch(/#42 completed\/cancelled/);
	});

	it("pushes a red revision only when the operator writes a reason for it", () => {
		const fixture = makeFixture();
		redRevisionGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture, {
			planted: { PREFLIGHT_RED_REVISION_REASON: "the cancelled run predates this revision" },
		});
		expect(result.signal).toBe(null);
		expect(result.status).toBe(0);
		expect(result.output).toContain("overridden by PREFLIGHT_RED_REVISION_REASON");
		expect(result.output).toContain("safe to push");
	});

	it("does not let a reason inherited from the host launder a red revision", () => {
		const fixture = makeFixture();
		redRevisionGh(fixture.bin);
		passingNpm(fixture.bin);
		// The gate reads this variable from its own environment, so the case plants it there: an
		// ambient one (a shell that exported it for the last push) must not reach the gate.
		process.env.PREFLIGHT_RED_REVISION_REASON = "inherited from whoever ran the tests";
		let result: { status: number | null; signal: string | null; output: string };
		try {
			result = runPreflight(fixture);
		} finally {
			delete process.env.PREFLIGHT_RED_REVISION_REASON;
		}
		expect(result.output).not.toContain("safe to push");
		expect(result.output).not.toContain("overridden by");
		expect(result.status).toBe(1);
	});

	it("does not let a GH_BIN inherited from the host send the verdict query to a real gh", () => {
		const fixture = makeFixture();
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		// `latest-ci-run.sh` resolves the binary as ${GH_BIN:-gh}: an ambient value bypasses the
		// fixture, the PATH and the fail-closed answers below, and asks GitHub for real.
		process.env.GH_BIN = "/nonexistent/gh";
		let result: { status: number | null; signal: string | null; output: string };
		try {
			result = runPreflight(fixture);
		} finally {
			delete process.env.GH_BIN;
		}
		expect(result.output).toMatch(/#41 completed\/success/);
		expect(result.status).toBe(0);
	});

	it("refuses to push when the worktree is not the commit being pushed", () => {
		const fixture = makeFixture();
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		// `npm run check` runs `biome check --write`, so a gate run on a dirty tree certifies
		// bytes that are not the ones the push sends.
		writeFileSync(join(fixture.root, "tracked.txt"), "edited after the commit\n");
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		// The refusal has to come from the tree check, not from a killed run.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/worktree|HEAD/i);
	});

	/** A `gh` that knows nothing about any run: the answer shape of asking the wrong repository. */
	function emptyRepoGh(bin: string): void {
		writeFixtureTool(bin, "gh", ghStub(IN_FLIGHT_NONE, "printf '%s' '[]'\nexit 0"));
	}

	it("refuses to push when the repository its questions are about cannot be resolved", () => {
		const fixture = makeFixture();
		// Step 0 resolves `origin`; a checkout without one must not fall back to whatever repository
		// bare `gh` would pick out of the other remotes.
		execFileSync("git", ["-C", fixture.root, "remote", "remove", "origin"], { env: hostEnv() });
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/cannot resolve the repository/i);
	});

	it("pins every gh question to origin instead of letting gh choose a repository", () => {
		const fixture = makeFixture();
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		const argsLog = join(fixture.root, "gh-args.log");
		const result = runPreflight(fixture, { planted: { GH_ARGS_LOG: argsLog } });
		// The pass is the gate's own: the fixture's gh answered the pinned question.
		expect(result.status).toBe(0);
		expect(result.output).toContain(`gh questions are pinned to: ${FIXTURE_REPO}`);
		// Every recorded call, not just the first one: a single unpinned query is how the verdict
		// was once asked about `upstream` while the branch lived on the fork.
		const calls = readFileSync(argsLog, "utf8")
			.split("#ARGS\n")
			.slice(1)
			.map((call) => call.trim().split("\n"));
		const runQueries = calls.filter((args) => args[0] === "run" && args[1] === "list");
		expect(runQueries.length).toBeGreaterThanOrEqual(2);
		for (const args of runQueries) {
			expect(args).toContain("-R");
			expect(args).toContain(FIXTURE_REPO);
		}
		// The one call that is deliberately unpinned is the diagnostic that reports which repository
		// *bare* gh would pick; it answers no verdict.
		for (const args of calls.filter((entry) => !entry.includes("-R"))) {
			expect(args.slice(0, 2)).toEqual(["repo", "view"]);
		}
	});

	it("refuses to push when the pinned repository reports no CI runs at all", () => {
		const fixture = makeFixture();
		emptyRepoGh(fixture.bin);
		passingNpm(fixture.bin);
		// An empty run list used to read as "never pushed - push away". Here the repository cannot
		// answer about any run, which is the shape of the wrong repository, so it is a refusal.
		const result = runPreflight(fixture);
		expect(result.output).not.toContain("safe to push");
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/reports no CI runs at all/i);
	});

	it("passes on a clean tree with a healthy gh and green checks", () => {
		const fixture = makeFixture();
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		// The run id is the fixture's, so the verdict was asked of the injected gh and answered:
		// the pass is earned by the gate, not inherited from an override sitting in the host.
		expect(result.output).toMatch(/#41 completed\/success/);
		expect(result.output).not.toContain("overridden by PREFLIGHT_RED_REVISION_REASON");
		expect(result.output).toContain("safe to push");
		expect(result.status).toBe(0);
	});
});
