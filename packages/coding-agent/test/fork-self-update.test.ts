import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	detectForkInstall,
	FORK_GATE_ENV_VAR,
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

	it("opts out of detection while the in-repo update suites run, and says so", () => {
		// The marker walk always fires inside this checkout, so suites that exercise the
		// official update path (package-command-paths.test.ts) switch the gate off for
		// their own duration instead of asserting against the refusal.
		const entries: LogEntry[] = [];
		setLogSink((entry) => entries.push(entry));
		process.env[FORK_GATE_ENV_VAR] = "off";
		try {
			// Positive control for the diagnostic below: the same call warns only because
			// the variable is set, not because it got here at all.
			expect(detectForkInstall(forkRoot)).toBeUndefined();
			expect(detectForkInstall()).toBeUndefined();
			expect(entries).toHaveLength(2);
			for (const entry of entries) {
				expect(entry.level).toBe("warn");
				expect(entry.msg).toContain(FORK_GATE_ENV_VAR);
			}
			// The warn names the checkout whose gate was skipped, so a leaked seam is
			// traceable from the log alone.
			expect(entries[0]?.repoRoot).toBe(resolve(forkRoot));
		} finally {
			delete process.env[FORK_GATE_ENV_VAR];
			setLogSink(undefined);
		}

		// The opt-out is scoped to the variable and not sticky.
		expect(detectForkInstall(forkRoot)).toEqual({ repoRoot: resolve(forkRoot) });
	});

	it("keeps the bypass quiet when the variable is not set", () => {
		const entries: LogEntry[] = [];
		setLogSink((entry) => entries.push(entry));
		try {
			expect(detectForkInstall(forkRoot)).toEqual({ repoRoot: resolve(forkRoot) });
			expect(detectForkInstall(plainRoot)).toBeUndefined();
			expect(entries).toEqual([]);
		} finally {
			setLogSink(undefined);
		}
	});

	it("says the gate is off even when no fork marker was found", () => {
		// Unconditional by contract: setting the variable is the event being reported, so an
		// operator grepping the log sees the skipped gate on any install, not only in-repo.
		const entries: LogEntry[] = [];
		setLogSink((entry) => entries.push(entry));
		process.env[FORK_GATE_ENV_VAR] = "off";
		try {
			expect(detectForkInstall(plainRoot)).toBeUndefined();
			expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
			expect(entries[0]?.msg).toContain(FORK_GATE_ENV_VAR);
		} finally {
			delete process.env[FORK_GATE_ENV_VAR];
			setLogSink(undefined);
		}
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
