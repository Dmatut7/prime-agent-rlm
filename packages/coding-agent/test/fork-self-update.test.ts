import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	detectForkInstall,
	FORK_MARKER_FILE,
	forkSelfUpdateOverrideLine,
	forkSelfUpdateRefusalLines,
} from "../src/fork-self-update.js";

describe("fork self-update gate", () => {
	let forkRoot = "";
	let plainRoot = "";

	beforeAll(() => {
		forkRoot = mkdtempSync(join(tmpdir(), "fork-gate-marker-"));
		plainRoot = mkdtempSync(join(tmpdir(), "fork-gate-plain-"));
		writeFileSync(join(forkRoot, FORK_MARKER_FILE), "# fork notes\n");
	});

	afterAll(() => {
		rmSync(forkRoot, { recursive: true, force: true });
		rmSync(plainRoot, { recursive: true, force: true });
	});

	it("resolves the fork root from a nested build directory", () => {
		const bundled = join(forkRoot, "packages", "coding-agent", "dist", "bundle");
		mkdirSync(bundled, { recursive: true });
		expect(detectForkInstall(bundled)).toEqual({ repoRoot: resolve(forkRoot) });
		// The marker's own directory is the root, not a build directory below it.
		expect(detectForkInstall(forkRoot)).toEqual({ repoRoot: resolve(forkRoot) });
	});

	it("reports no fork for a tree without the marker", () => {
		const installed = join(plainRoot, "lib", "node_modules", "prime-agent", "dist", "bundle");
		mkdirSync(installed, { recursive: true });
		expect(detectForkInstall(installed)).toBeUndefined();
	});

	it("detects the checkout this test run itself comes from", () => {
		// Positive control: the argument-less call reads the running module's own
		// location, which in this repository is a fork checkout. If this ever fails,
		// the two cases above are testing a detector the install path never uses.
		const detected = detectForkInstall();
		expect(detected).toBeDefined();
		expect(dirname(resolve(detected?.repoRoot ?? ""))).not.toBe("");
		expect(detectForkInstall(resolve(detected?.repoRoot ?? "."))).toEqual(detected);
	});

	it("opts out of detection while the in-repo update suites run", () => {
		// The marker walk always fires inside this checkout, so suites that exercise the
		// official update path (package-command-paths.test.ts) switch the gate off for
		// their own duration instead of asserting against the refusal.
		process.env.PRIME_AGENT_FORK_GATE = "off";
		try {
			expect(detectForkInstall(forkRoot)).toBeUndefined();
			expect(detectForkInstall()).toBeUndefined();
		} finally {
			delete process.env.PRIME_AGENT_FORK_GATE;
		}

		// The opt-out is scoped to the variable and not sticky.
		expect(detectForkInstall(forkRoot)).toEqual({ repoRoot: resolve(forkRoot) });
	});

	it("names the fork's own update path and never the official installer", () => {
		const fork = { repoRoot: forkRoot };
		const lines = forkSelfUpdateRefusalLines(fork);
		const message = lines.join("\n");

		expect(message).toContain("refusing to self-update a fork build");
		expect(message).toContain(FORK_MARKER_FILE);
		expect(message).toContain(forkRoot);
		expect(message).toContain(`cd ${forkRoot} && git pull --rebase && npm run build`);
		expect(message).toContain("prime-agent shutdown && prime-agent");
		expect(message).toContain(join(forkRoot, "prime-agent.sh"));
		expect(message).toContain("prime-agent update --allow-official");
		expect(message).not.toContain("install -g");
		expect(message).not.toContain("curl");
		expect(lines.every((line) => !line.includes("\t"))).toBe(true);
	});

	it("says so when only the self half of a combined update was refused", () => {
		const fork = { repoRoot: forkRoot };
		expect(forkSelfUpdateRefusalLines(fork).join("\n")).not.toContain("Extensions were updated");
		expect(forkSelfUpdateRefusalLines(fork, { extensionsUpdated: true }).join("\n")).toContain(
			"Extensions were updated; only the self-update half was refused.",
		);
	});

	it("names the checkout it is about to overwrite when the gate is overridden", () => {
		expect(forkSelfUpdateOverrideLine({ repoRoot: forkRoot })).toContain(forkRoot);
		expect(forkSelfUpdateOverrideLine({ repoRoot: forkRoot })).toContain("--allow-official");
	});
});
