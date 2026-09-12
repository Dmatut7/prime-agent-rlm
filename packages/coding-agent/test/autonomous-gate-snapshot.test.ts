import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type TextContent, type UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutonomousRuntimeState, nextAutonomousContinuation } from "../src/core/autonomous.js";

// A gate snapshot fingerprints the worktree with two `git` child processes plus a hash of every
// untracked file, so the spawns are recorded to show the capture only happens where the gate
// reads it: once after a failure, and once before a rerun decision.
const spawned = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...spawnArgs: Parameters<typeof actual.spawn>) => {
			spawned.calls.push([spawnArgs[0], ...(spawnArgs[1] ?? [])]);
			return actual.spawn(...spawnArgs);
		},
	};
});

const SNAPSHOT_SPAWNS = ["status", "diff"];

function gitSubcommands(): string[] {
	return spawned.calls
		.filter((call) => call[0] === "git")
		.map((call) => call.slice(1).find((arg) => !arg.startsWith("-")) ?? "");
}

function gateRuns(command: string): number {
	return spawned.calls.filter((call) => call[0] === command).length;
}

function continuationText(message: UserMessage | undefined): string {
	if (!message) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("autonomous gate worktree snapshots", () => {
	const repoDirs: string[] = [];

	beforeEach(() => {
		spawned.calls.length = 0;
	});

	afterEach(() => {
		while (repoDirs.length > 0) {
			rmSync(repoDirs.pop() as string, { recursive: true, force: true });
		}
	});

	function createRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "autonomous-gate-snapshot-"));
		repoDirs.push(dir);
		execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
		writeFileSync(join(dir, "src.rs"), "initial\n");
		execFileSync("git", ["add", "src.rs"], { cwd: dir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: dir,
			stdio: "ignore",
		});
		// Untracked on purpose: the snapshot hashes untracked contents, so this file is the
		// change the rerun decision has to notice.
		writeFileSync(join(dir, "candidate.txt"), "bad\n");
		spawned.calls.length = 0;
		return dir;
	}

	it("does no git work when a gate passes and no failure is on record", async () => {
		const dir = createRepo();
		const gate = `${process.execPath} -e "process.exit(0)"`;
		const state = createAutonomousRuntimeState(
			{ enabled: true, maxContinuations: 5, gates: { commands: [gate], maxRetries: 5 } },
			{ cwd: dir },
		);

		const continuation = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: dir });

		expect(continuation).toBeUndefined();
		expect(gateRuns(gate)).toBe(1);
		expect(gitSubcommands()).toEqual([]);
		expect(state.lastGateFailure).toBeUndefined();
		expect(state.lastGateFailureSnapshot).toBeUndefined();
	});

	it("captures a snapshot only where the gate reads it across fail, suppress, rerun and pass turns", async () => {
		const dir = createRepo();
		const candidate = join(dir, "candidate.txt");
		const gate = `${process.execPath} -e "process.exit(require('fs').readFileSync('candidate.txt','utf8').trim()==='good'?0:1)"`;
		const state = createAutonomousRuntimeState(
			{ enabled: true, maxContinuations: 5, gates: { commands: [gate], maxRetries: 5 } },
			{ cwd: dir },
		);

		// Turn 1: the gate fails, so the post-run snapshot is captured for the next comparison.
		// Nothing is captured before the run: there is no prior failure to compare against.
		const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: dir });
		expect(gateRuns(gate)).toBe(1);
		expect(gitSubcommands()).toEqual(SNAPSHOT_SPAWNS);
		expect(continuationText(first)).toContain("Autonomous quality gate failed");
		expect(state.lastGateFailureSnapshot).toBeDefined();

		// Turn 2: unchanged workspace, so the pre-run snapshot suppresses the rerun and no
		// post-run snapshot is taken.
		const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: dir });
		expect(gateRuns(gate)).toBe(1);
		expect(gitSubcommands()).toEqual([...SNAPSHOT_SPAWNS, ...SNAPSHOT_SPAWNS]);
		expect(continuationText(second)).toContain("workspace has not changed");
		expect(state.gateAttempts[gate]).toBe(2);

		// Turn 3: changed untracked content, so the gate reruns and fails again, which costs the
		// pre-run comparison plus a fresh post-run snapshot.
		writeFileSync(candidate, "still bad\n");
		const third = await nextAutonomousContinuation(state, fauxAssistantMessage("Trying again."), { cwd: dir });
		expect(gateRuns(gate)).toBe(2);
		expect(gitSubcommands()).toEqual([
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
		]);
		expect(continuationText(third)).toContain("Autonomous quality gate failed");
		expect(state.gateAttempts[gate]).toBe(3);

		// Turn 4: the gate passes, so only the pre-run comparison is captured and the recorded
		// failure is cleared.
		writeFileSync(candidate, "good\n");
		const fourth = await nextAutonomousContinuation(state, fauxAssistantMessage("Fixed."), { cwd: dir });
		expect(fourth).toBeUndefined();
		expect(gateRuns(gate)).toBe(3);
		expect(gitSubcommands()).toEqual([
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
			...SNAPSHOT_SPAWNS,
		]);
		expect(state.lastGateFailure).toBeUndefined();
		expect(state.lastGateFailureSnapshot).toBeUndefined();
		expect(state.gateAttempts[gate]).toBe(0);
	});
});
