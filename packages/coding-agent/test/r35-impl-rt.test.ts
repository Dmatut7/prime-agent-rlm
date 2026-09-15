import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { readSnapshotManifest, snapshotFailureNoticeLines } from "../src/core/kernel/state-snapshot.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import { formatHarnessStateForPrompt } from "../src/core/refinement/index.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

describe("RT-4: formatHarnessStateForPrompt survives null refinement fields", () => {
	it("does not throw on a refinement event written with trigger null", () => {
		const state = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [
				{
					id: "refine_0001",
					// A Python-side record_refinement used to be able to write these.
					trigger: null as unknown as string,
					changes: null as unknown as string[],
					evidence: null as unknown as string,
					outcome: null as unknown as string,
					created_at: "",
				},
			],
		} satisfies HarnessState;
		const rendered = formatHarnessStateForPrompt(state);
		expect(rendered).toContain("recent refinements: 1");
		expect(rendered).toContain("refine_0001");
	});

	it("keeps rendering valid events around a malformed one", () => {
		const state = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [
				{ id: "bad", trigger: undefined, changes: "not-a-list", outcome: 5 },
				{ id: "good", trigger: "repeated failure", changes: ["updated memory"], outcome: "next pass" },
			],
		} as unknown as HarnessState;
		const rendered = formatHarnessStateForPrompt(state);
		expect(rendered).toContain("good");
		expect(rendered).toContain("updated memory");
		expect(rendered).toContain("next pass");
	});

	it("does not throw on an entry with null content or arguments", () => {
		const state = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {
					broken: {
						id: "broken",
						kind: "skill",
						title: null,
						content: null,
						path: null,
						reference: null,
						arguments: null,
						version: null,
					},
				},
				subagent: {},
			},
			refinements: [],
		} as unknown as HarnessState;
		const rendered = formatHarnessStateForPrompt(state);
		expect(rendered).toContain("skill: 1");
		expect(rendered).toContain("broken");
	});
});

describe("RT-2: model-visible snapshot failure receipt", () => {
	it("snapshotFailureNoticeLines names the failure and the persistence consequence", () => {
		const lines = snapshotFailureNoticeLines("unsafe snapshot directory");
		const text = lines.join(" ");
		expect(lines.length).toBeGreaterThan(0);
		expect(text).toContain("could not be written");
		expect(text).toContain("unsafe snapshot directory");
		expect(text).toContain("not saved to disk");
	});
});

describeIfKernel("RT-2: ordinary snapshot failure reaches the model-visible channel", () => {
	let dir = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-r35-snapfail-"));
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("fires onSnapshotFailure when the snapshot write fails", async () => {
		// A regular file where the snapshot directory should be makes the runtime's
		// write refuse ("unsafe snapshot directory"), deterministically.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const failures: string[] = [];
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: join(blocker, "session.dill"), manifestPath: join(blocker, "session.json") },
			onSnapshotFailure: (detail) => failures.push(detail),
		});
		try {
			await manager.start();
			await manager.execute("x = 1");
			const result = await manager.snapshotState();
			expect(result).toBeNull();
			expect(failures.length).toBe(1);
			expect(failures[0]).toContain("unsafe snapshot directory");
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true }).catch(() => undefined);
		}
	}, 60_000);

	it("does not fire onSnapshotFailure again after a successful write re-arms it", async () => {
		const goodDir = join(dir, "good");
		mkdirSync(goodDir, { recursive: true });
		const failures: string[] = [];
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: goodDir,
			snapshot: { path: join(goodDir, "session.dill"), manifestPath: join(goodDir, "session.json") },
			onSnapshotFailure: (detail) => failures.push(detail),
		});
		try {
			await manager.start();
			await manager.execute("x = 1");
			const result = await manager.snapshotState();
			expect(result).not.toBeNull();
			expect(failures).toEqual([]);
		} finally {
			await manager.shutdown({ snapshot: false, drainHostRequests: true }).catch(() => undefined);
		}
	}, 60_000);
});

describe("RT-3: readSnapshotManifest surfaces the payload's pythonVersion", () => {
	it("reads pythonVersion from the manifest", () => {
		const manifestDir = mkdtempSync(join(tmpdir(), "prime-agent-r35-manifest-"));
		try {
			const manifestPath = join(manifestDir, "kernel-state.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({
					version: 1,
					savedNames: ["x"],
					skipped: [],
					pythonVersion: "3.11.13",
					timestamp: "2026-09-15T23:05:40Z",
				}),
			);
			const facts = readSnapshotManifest(manifestPath);
			expect(facts?.pythonVersion).toBe("3.11.13");
		} finally {
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});
});
