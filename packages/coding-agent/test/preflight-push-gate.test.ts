import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/preflight-push.sh` is the certificate a commit gets before it is pushed, so its two
 * failure modes are tested from the outside: the script is copied into a throwaway repository
 * and run there, with `gh` and `npm` replaced by fixtures on `PATH`. A gate that cannot be made
 * to refuse is not a gate, and a gate that cannot be made to pass is not usable either.
 */
const SCRIPT = fileURLToPath(new URL("../../../scripts/preflight-push.sh", import.meta.url));

interface Fixture {
	root: string;
	bin: string;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "preflight-gate-repo-"));
	execFileSync("git", ["init", "-q", root]);
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	execFileSync("git", ["-C", root, "add", "tracked.txt"]);
	execFileSync("git", [
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
	]);
	mkdirSync(join(root, "scripts"));
	copyFileSync(SCRIPT, join(root, "scripts", "preflight-push.sh"));
	const bin = mkdtempSync(join(tmpdir(), "preflight-gate-bin-"));
	return { root, bin };
}

/** Writes an executable fixture. The caller owns the shebang line. */
function writeFixtureTool(bin: string, name: string, contents: string): void {
	const path = join(bin, name);
	writeFileSync(path, `${contents}\n`);
	chmodSync(path, 0o755);
}

/** `gh` that answers "nothing in flight" the way a healthy, logged-in client does. */
function healthyGh(bin: string): void {
	writeFixtureTool(bin, "gh", '#!/bin/sh\necho "0"');
}

/** `gh` that exists but fails: logged out, offline, or rate limited. */
function failingGh(bin: string): void {
	writeFixtureTool(bin, "gh", "#!/bin/sh\nexit 1");
}

/** `gh` that "succeeds" with an answer that is not a run count, e.g. a message on stdout. */
function unreadableGh(bin: string): void {
	writeFixtureTool(bin, "gh", '#!/bin/sh\necho "error: not logged in"');
}

/** `npm run check` replaced by a fixture: this test is about the gate, not about the checks. */
function passingNpm(bin: string): void {
	writeFixtureTool(bin, "npm", "#!/bin/sh\nexit 0");
}

function runPreflight(
	fixture: Fixture,
	timeoutMs = 20_000,
): { status: number | null; signal: string | null; output: string } {
	const result = spawnSync("bash", [join(fixture.root, "scripts", "preflight-push.sh"), "--skip-tests"], {
		cwd: fixture.root,
		encoding: "utf8",
		timeout: timeoutMs,
		env: {
			...process.env,
			PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
			PREFLIGHT_BRANCH: "main",
		},
	});
	return { status: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("preflight-push gate", () => {
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
		const result = runPreflight(fixture, 8_000);
		expect(result.output).not.toContain("safe to push");
		// Refused, and refused by itself: a killed or timed-out run proves nothing about the gate.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/gh/i);
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

	it("passes on a clean tree with a healthy gh and green checks", () => {
		const fixture = makeFixture();
		healthyGh(fixture.bin);
		passingNpm(fixture.bin);
		const result = runPreflight(fixture);
		expect(result.output).toContain("safe to push");
		expect(result.status).toBe(0);
	});
});
