import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectForkInstall, FORK_GATE_ENV_VAR, FORK_MARKER_FILE } from "../src/fork-self-update.js";

/**
 * `scripts/release.mjs` is the one command in this repository that can put a fork build into the
 * upstream public npm scope and push the `v*` tag that runs `build-binaries.yml`, so its fork gate
 * is tested from the outside: the script is copied into a throwaway repository together with the
 * module it imports, `git` and `npm` are replaced by recording fixtures on `PATH`, and the gate has
 * to be seen both refusing and passing. A gate that cannot be made to refuse is not a gate, and a
 * gate that cannot be made to pass is not usable either.
 *
 * The fixtures own every input the gate reads. Nothing here may reach the real `git` or `npm`:
 * `release.mjs` runs `git commit`, `git tag`, `npm run publish` and `git push origin` in that
 * order, and the whole point of the case that opens the gate is that those commands are reached -
 * against stubs, in a temp directory, never against this checkout or the registry.
 *
 * The second half of the file pins the `.mjs` gate to the TypeScript one it mirrors:
 * `release.mjs` cannot import `fork-self-update.ts` (a release script must run in a checkout with
 * nothing built and no TypeScript loader), so it carries a copy of the marker walk. Copying is only
 * safe while both sides are nailed to the same marker file name, the same verdict on the same
 * directories, and different override variables - the self-update gate's `=off` test seam must
 * never open a release.
 */
const REPO_SCRIPTS_DIR = fileURLToPath(new URL("../../../scripts/", import.meta.url));
const RELEASE_SCRIPT = join(REPO_SCRIPTS_DIR, "release.mjs");

/**
 * The gate plus every module it imports by relative path. Staging only `release.mjs` would make the
 * passing cases unpassable on any machine: it starts with
 * `import { buildReleaseSection } from "./lib/changelog-fragments.mjs"`, which a fixture without
 * that file cannot load. A case below re-derives this list from the script's own imports.
 */
const GATED_SCRIPTS = ["release.mjs", "lib/changelog-fragments.mjs"];

/**
 * The override the gate accepts, spelled out here rather than imported: it is the operator-facing
 * contract (documented in the script header and in the fork's release notes), so a rename on either
 * side has to break something. It is deliberately NOT {@link FORK_GATE_ENV_VAR}.
 */
const ALLOW_RELEASE_ENV_VAR = "PRIME_AGENT_ALLOW_RELEASE";

/**
 * Host state that changes what the gate or its stubs see, stripped from every run: this agent
 * family's own `PRIME_AGENT_*` (which includes the override under test and the self-update seam),
 * the git hook environment (`GIT_DIR` and friends would point the fixture's git at the repository
 * that started the test run), npm's inherited configuration, and `NODE_OPTIONS`.
 */
const HOST_STATE = /^(PRIME_AGENT_|RLM_|PI_|GIT_|GITHUB_|GH_|npm_config_|NODE_OPTIONS$)/;

interface Fixture {
	/** Fixture repository root, realpath'd: `release.mjs` reports the resolved marker directory. */
	root: string;
	bin: string;
	calls: string;
}

/** Fixtures a case created, removed after it: a gate test must not litter the temp directory. */
const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `process.env` without the host state the gate reads; fixture repositories are built in it too. */
function hostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || HOST_STATE.test(name)) continue;
		env[name] = value;
	}
	return env;
}

function makeTempDir(prefix: string): string {
	// realpath'd because node resolves the main module's path before `import.meta.url` sees it: on
	// macOS `tmpdir()` sits behind `/private`, and a case comparing the refusal's reported checkout
	// against the path it built would otherwise compare two spellings of one directory.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	createdDirs.push(dir);
	return dir;
}

/** A `git`/`npm` that records the call and succeeds, so an opened gate runs to the end harmlessly. */
function writeRecordingTool(bin: string, name: string, calls: string): void {
	const quoted = calls.replace(/'/g, "'\\''");
	writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${quoted}'\nexit 0\n`);
	chmodSync(join(bin, name), 0o755);
}

/**
 * A repository the release script can actually run in: the gated script and its import, the version
 * it reads (`packages/ai/package.json`), one changelog and one fragment so the changelog pass has
 * something to fold, and recording `git`/`npm` fixtures. `fork` decides whether the marker file
 * this whole gate keys on is present at the root.
 */
function makeFixture(options: { fork: boolean }): Fixture {
	const root = makeTempDir(options.fork ? "release-gate-fork-" : "release-gate-plain-");
	const bin = makeTempDir("release-gate-bin-");
	if (options.fork) {
		// Written from the imported constant, so the fixture follows the TypeScript side if the
		// marker is ever renamed - which is what makes the drift case below meaningful.
		writeFileSync(join(root, FORK_MARKER_FILE), "# fork notes\n");
	}
	mkdirSync(join(root, "scripts", "lib"), { recursive: true });
	for (const name of GATED_SCRIPTS) copyFileSync(join(REPO_SCRIPTS_DIR, name), join(root, "scripts", name));
	mkdirSync(join(root, "packages", "ai", ".changes"), { recursive: true });
	writeFileSync(
		join(root, "packages", "ai", "package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.10.0" }, undefined, "\t")}\n`,
	);
	writeFileSync(
		join(root, "packages", "ai", "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n## [0.10.0] - 2026-09-17\n\n- previous release\n",
	);
	writeFileSync(join(root, "packages", "ai", ".changes", "gate-fixture.md"), "- fixture fragment\n");
	const calls = join(bin, "calls.log");
	writeRecordingTool(bin, "git", calls);
	writeRecordingTool(bin, "npm", calls);
	return { root, bin, calls };
}

/** Every `git`/`npm` the script actually invoked, in order; empty means nothing was spawned. */
function recordedCalls(fixture: Fixture): string[] {
	if (!existsSync(fixture.calls)) return [];
	return readFileSync(fixture.calls, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Path + content of everything under the fixture root, so "changed nothing" is a real comparison. */
function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const walk = (dir: string): void => {
		const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			const full = join(dir, child.name);
			const relative = full.slice(root.length + 1);
			if (child.isDirectory()) {
				entries.push(`dir ${relative}`);
				walk(full);
				continue;
			}
			entries.push(`file ${relative} ${readFileSync(full, "utf8")}`);
		}
	};
	walk(root);
	return entries;
}

function runRelease(
	fixture: Fixture,
	args: string[],
	planted: Record<string, string> = {},
): { status: number | null; signal: string | null; output: string } {
	const result = spawnSync(process.execPath, [join(fixture.root, "scripts", "release.mjs"), ...args], {
		cwd: fixture.root,
		encoding: "utf8",
		timeout: 20_000,
		env: {
			...hostEnv(),
			PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
			...planted,
		},
	});
	return { status: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The refusal's own words, asserted together so a reworded gate still says all of it. */
function expectRefusal(result: { status: number | null; signal: string | null; output: string }, root: string): void {
	// Refused, and refused by itself: a killed or timed-out run proves nothing about the gate.
	expect(result.signal).toBe(null);
	expect(result.status).toBe(1);
	expect(result.output).toContain("refusing to release from a fork checkout");
	// Names the marker it found, by the shared constant, and the checkout it found it in.
	expect(result.output).toContain(FORK_MARKER_FILE);
	expect(result.output).toContain(root);
	// Names the escape hatch, the public scope at stake and the workflow the tag would run.
	expect(result.output).toContain(ALLOW_RELEASE_ENV_VAR);
	expect(result.output).toContain("@earendil-works/pi-");
	expect(result.output).toContain("build-binaries.yml");
	expect(result.output).toContain("git tag");
	expect(result.output).toContain("git push origin");
}

/** Runs `body` with the self-update gate's test seam unset, restoring whatever was there. */
function withForkSeamCleared<T>(body: () => T): T {
	const saved = process.env[FORK_GATE_ENV_VAR];
	delete process.env[FORK_GATE_ENV_VAR];
	try {
		return body();
	} finally {
		if (saved === undefined) delete process.env[FORK_GATE_ENV_VAR];
		else process.env[FORK_GATE_ENV_VAR] = saved;
	}
}

describe("release.mjs fork gate", () => {
	it("stages every module the gated script imports by relative path", () => {
		// A new relative import in release.mjs that the fixture does not carry makes every passing
		// case here fail with a module-not-found that looks nothing like its cause. Say so first.
		const source = readFileSync(RELEASE_SCRIPT, "utf8");
		const imported = [...source.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((match) => match[1].slice(2));
		expect(imported.length).toBeGreaterThan(0);
		for (const specifier of imported) expect(GATED_SCRIPTS).toContain(specifier);
	});

	it("refuses a fork checkout before spawning anything or touching the tree", () => {
		const fixture = makeFixture({ fork: true });
		const before = snapshotTree(fixture.root);
		const result = runRelease(fixture, ["patch"]);
		expectRefusal(result, fixture.root);
		// No git, no npm: not `git status`, not the version bump, not the commit, tag, publish, push.
		expect(recordedCalls(fixture)).toEqual([]);
		// And nothing on disk moved either - the refusal happens before the first write.
		expect(snapshotTree(fixture.root)).toEqual(before);
	});

	it("refuses an explicit version target the same way", () => {
		const fixture = makeFixture({ fork: true });
		const result = runRelease(fixture, ["9.9.9"]);
		expectRefusal(result, fixture.root);
		expect(recordedCalls(fixture)).toEqual([]);
	});

	it("refuses before it parses arguments, so no invocation shape reaches the release steps", () => {
		const fixture = makeFixture({ fork: true });
		const result = runRelease(fixture, []);
		expectRefusal(result, fixture.root);
		// The usage text is the other thing an argument-less run prints; the gate wins that race.
		expect(result.output).not.toContain("Usage: node scripts/release.mjs");
		expect(recordedCalls(fixture)).toEqual([]);
	});

	it("refuses --dry-run too, and says that the flag is not a way around the gate", () => {
		const fixture = makeFixture({ fork: true });
		const before = snapshotTree(fixture.root);
		const result = runRelease(fixture, ["patch", "--dry-run"]);
		expectRefusal(result, fixture.root);
		// A dry run performs no irreversible step (it prints the changelog preview and exits before
		// the first write), so it is gated on purpose, not by accident: the refusal says so, and the
		// preview never starts. Asserting the reason keeps the choice visible to the next reader.
		expect(result.output).toContain("--dry-run");
		expect(result.output).not.toContain("Dry run complete");
		expect(recordedCalls(fixture)).toEqual([]);
		expect(snapshotTree(fixture.root)).toEqual(before);
	});

	it("keeps refusing when the override holds anything other than exactly 1", () => {
		// No fuzzy acceptance: this repository's "explicitly provided" rule means a wrong value
		// aborts loudly instead of falling back to a default or to a near-miss spelling.
		for (const value of ["0", "2", "true", "yes", "on", "", "1 ", " 1", "01"]) {
			const fixture = makeFixture({ fork: true });
			const result = runRelease(fixture, ["patch", "--dry-run"], { [ALLOW_RELEASE_ENV_VAR]: value });
			expect(result.status, `override value ${JSON.stringify(value)} must not release`).toBe(1);
			expect(result.output).toContain("refusing to release from a fork checkout");
			expect(recordedCalls(fixture)).toEqual([]);
		}
	});

	it("reports a rejected override value without echoing it", () => {
		// A mis-set variable's content does not belong in a terminal or a CI log, so the refusal says
		// that the value was wrong and stops there. Probed with canaries rather than with plausible
		// words: "on" or "0" occur inside the refusal's own text ("undone", "permissions", the step
		// numbers, `package.json`), so only a string that appears nowhere else can prove non-echoing.
		for (const value of ["SENTINEL_DO_NOT_ECHO", "release-please-SENTINEL"]) {
			const fixture = makeFixture({ fork: true });
			const result = runRelease(fixture, ["patch", "--dry-run"], { [ALLOW_RELEASE_ENV_VAR]: value });
			expect(result.status).toBe(1);
			expect(result.output).toContain('is set, but to something other than exactly "1"');
			expect(result.output, `override value ${JSON.stringify(value)} must not be echoed`).not.toContain(value);
			expect(recordedCalls(fixture)).toEqual([]);
		}
	});

	it("is not opened by the self-update gate's off switch", () => {
		// PRIME_AGENT_FORK_GATE=off exists so suites can exercise the official update path. If the
		// release gate ever read the same variable, one exported test seam would silently authorise
		// publishing this fork to the upstream public scope.
		const fixture = makeFixture({ fork: true });
		const result = runRelease(fixture, ["patch", "--dry-run"], { [FORK_GATE_ENV_VAR]: "off" });
		expectRefusal(result, fixture.root);
		expect(recordedCalls(fixture)).toEqual([]);
	});

	it("releases when the override is given explicitly, warning about every irreversible step", () => {
		const fixture = makeFixture({ fork: true });
		const before = snapshotTree(fixture.root);
		const result = runRelease(fixture, ["patch", "--dry-run"], { [ALLOW_RELEASE_ENV_VAR]: "1" });
		expect(result.signal).toBe(null);
		expect(result.status).toBe(0);
		expect(result.output).toContain("warning:");
		expect(result.output).toContain(ALLOW_RELEASE_ENV_VAR);
		expect(result.output).toContain(fixture.root);
		// The warning is the only thing standing between the operator and the four steps, so it
		// names all of them: commit, tag, the public scope, the push and the workflow it triggers.
		expect(result.output).toContain("git commit");
		expect(result.output).toContain("git tag");
		expect(result.output).toContain("@earendil-works/pi-");
		expect(result.output).toContain("git push origin main");
		expect(result.output).toContain("build-binaries.yml");
		expect(result.output).toContain("contents: write");
		// It really did go on to the dry run: the gate opened instead of the script dying on it.
		expect(result.output).toContain("Dry run complete (no changes made)");
		// A dry run spawns only the read-only `git log` the fragment sort order needs.
		const calls = recordedCalls(fixture);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call).toMatch(/^git log --diff-filter=A /);
		expect(snapshotTree(fixture.root)).toEqual(before);
	});

	it("lets an explicitly allowed real release reach commit, tag, publish and push", () => {
		// Positive control for the whole gate: with the override set, the non-dry path runs to the
		// end against the recording stubs. If this case ever fails, the refusals above could be
		// passing because the script is broken for everyone rather than because the gate works.
		const fixture = makeFixture({ fork: true });
		const result = runRelease(fixture, ["patch"], { [ALLOW_RELEASE_ENV_VAR]: "1" });
		expect(result.signal).toBe(null);
		expect(result.status).toBe(0);
		expect(result.output).toContain("warning:");
		expect(result.output).toContain("=== Released v0.10.0 ===");
		const calls = recordedCalls(fixture);
		for (const expected of [
			"npm run version:patch",
			"git commit -m Release v0.10.0",
			"git tag v0.10.0",
			"npm run publish",
			"git push origin main",
			"git push origin v0.10.0",
		]) {
			expect(calls, `the opened gate must still reach: ${expected}`).toContain(expected);
		}
	});

	it("does not fire on a checkout with no fork marker above it", () => {
		const fixture = makeFixture({ fork: false });
		// Precondition, and the reason a red here is about the machine and not the gate: the walk
		// goes up to the filesystem root, so a stray marker above the temp directory would turn
		// every "not a fork" fixture into a fork one. Read with the self-update seam cleared, since
		// an inherited `off` would make the TypeScript detector answer "no fork" everywhere.
		expect(withForkSeamCleared(() => detectForkInstall(join(fixture.root, "scripts")))).toBeUndefined();
		const result = runRelease(fixture, ["patch", "--dry-run"]);
		expect(result.signal).toBe(null);
		expect(result.status).toBe(0);
		expect(result.output).not.toContain("refusing to release");
		expect(result.output).not.toContain("warning:");
		expect(result.output).toContain("Dry run complete (no changes made)");
	});

	it("agrees with detectForkInstall() on the same directories", () => {
		// The anti-drift pin, behavioural rather than textual: both implementations are walked over
		// one marker fixture and one plain fixture, and their verdicts have to match. A .mjs side
		// that started looking for a different file, or stopped walking up, fails here even if the
		// constant it declares still reads FORK_NOTES.md.
		const fork = makeFixture({ fork: true });
		const plain = makeFixture({ fork: false });
		const forkScripts = join(fork.root, "scripts");
		const plainScripts = join(plain.root, "scripts");
		const nested = join(fork.root, "packages", "coding-agent", "dist", "bundle");
		mkdirSync(nested, { recursive: true });
		// A marker above the running module counts for both sides, which is what makes the gate work
		// from a bundled or nested build directory as well as from scripts/.
		withForkSeamCleared(() => {
			expect(detectForkInstall(forkScripts)).toEqual({ repoRoot: fork.root });
			expect(detectForkInstall(nested)).toEqual({ repoRoot: fork.root });
			expect(detectForkInstall(plainScripts)).toBeUndefined();
		});
		expect(runRelease(fork, ["patch"]).status).toBe(1);
		expect(runRelease(plain, ["patch", "--dry-run"]).status).toBe(0);
	});

	it("keys on the same marker file name and a different override than the TypeScript gate", () => {
		const source = readFileSync(RELEASE_SCRIPT, "utf8");
		const marker = /const FORK_MARKER_FILE = "([^"]*)";/.exec(source);
		expect(marker, "release.mjs must declare its marker constant under the shared name").not.toBeNull();
		expect(marker?.[1]).toBe(FORK_MARKER_FILE);
		const override = /const RELEASE_OVERRIDE_ENV_VAR = "([^"]*)";/.exec(source);
		expect(override, "release.mjs must declare its override constant").not.toBeNull();
		expect(override?.[1]).toBe(ALLOW_RELEASE_ENV_VAR);
		// The two gates must not share a switch: `off` on the self-update gate is a test seam, and
		// `1` on the release gate is an operator's deliberate act.
		expect(override?.[1]).not.toBe(FORK_GATE_ENV_VAR);
		// And the refusal has to be an exit, not a logged complaint the release steps continue
		// past. Scoped to the gate's own body: `process.exit(1)` occurs four more times in the
		// script, so a file-wide search still passes when the gate's exit is the one removed.
		const gateBody = /function forkReleaseGate\(\) \{[\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
		expect(gateBody, "release.mjs must keep a forkReleaseGate() whose refusal exits").not.toBe("");
		expect(gateBody).toContain("process.exit(1)");
	});
});
