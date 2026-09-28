import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHANGE_TRACKING_ENV_VAR,
	type ExecuteResult,
	type KernelCellEffects,
	ReplKernelManager,
} from "../src/core/kernel/index.js";
import { assembleIpythonToolResult } from "../src/core/tools/ipython.js";
import { resolveKernelPython } from "./kernel-python.js";

// Resolved the way the product resolves a kernel interpreter (see kernel-python.ts).
const python = await resolveKernelPython("import rlm.repl, rlm.effects, dill");

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Both are real capabilities of the machine: a kernel runtime with change tracking, and git for the
// work-tree comparison that attributes `bash()` edits.
const canRunKernel = python !== null && hasGit();

const managers: ReplKernelManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.shutdown({ snapshot: false, drainHostRequests: true });
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { root: string; state: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "prime-agent-change-tracking-")));
	dirs.push(base);
	const root = join(base, "project");
	mkdirSync(root);
	writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(root, "b.txt"), "keep\n");
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
			cwd: root,
			stdio: "ignore",
		});
	git("init", "-q");
	git("add", ".");
	git("commit", "-qm", "init");
	return { root, state: join(base, "state") };
}

function kernel(root: string, state: string, tracking: "0" | "1"): ReplKernelManager {
	const manager = new ReplKernelManager({
		python: python as string,
		cwd: root,
		env: {
			[CHANGE_TRACKING_ENV_VAR]: tracking,
			PRIME_AGENT_CODING_AGENT_DIR: join(state, "agent"),
			RLM_HARNESS_STATE_DIR: join(state, "harness-local"),
			RLM_GLOBAL_HARNESS_STATE_DIR: join(state, "harness-global"),
		},
	});
	managers.push(manager);
	return manager;
}

const E2E_CELL = [
	"import rlm",
	"bash = rlm.bash",
	"with open('a.txt', 'w') as f:",
	"    f.write('one\\nTWO\\nthree\\n')",
	"from pathlib import Path",
	"Path('notes.md').write_text('# notes\\n')",
	"r = await bash(\"sed -i.bak 's/keep/KEPT/' b.txt && rm b.txt.bak && echo sed-done\")",
	"rlm.harness.create_memory('Deploy steps', 'use make deploy', id='deploy')",
	"print(r.exit_code)",
].join("\n");

describe.skipIf(!canRunKernel)("change tracking through the real kernel", () => {
	it("reports Python writes, shell edits, memory changes and steps in the execute result", async () => {
		const { root, state } = project();
		const manager = kernel(root, state, "1");
		const result = await manager.execute(E2E_CELL);
		expect(result.status).toBe("ok");
		expect(result.stdout).toBe("0\n");

		const files = new Map((result.fileChanges ?? []).map((change) => [change.relPath ?? change.path, change]));
		expect([...files.keys()].sort()).toEqual(["a.txt", "b.txt", "notes.md"]);
		expect(files.get("a.txt")).toMatchObject({ kind: "modified", scope: "project", source: "python", added: 1 });
		expect(files.get("a.txt")?.diff).toContain("-two\n+TWO\n");
		expect(files.get("notes.md")).toMatchObject({ kind: "created", added: 1 });
		expect(files.get("b.txt")).toMatchObject({ kind: "modified", source: "shell" });
		expect(files.get("b.txt")?.diff).toContain("-keep\n+KEPT\n");

		expect(result.memoryChanges).toEqual([
			expect.objectContaining({
				op: "created",
				kind: "memory",
				scope: "session",
				id: "deploy",
				title: "Deploy steps",
				after: "use make deploy",
			}),
		]);
		const command = result.activities?.find((activity) => activity.kind === "command");
		expect(command).toMatchObject({ status: "ok", detail: "sed-done" });
		expect(command?.label).toContain("sed -i.bak");
		console.log(
			JSON.stringify(
				{ fileChanges: result.fileChanges, memoryChanges: result.memoryChanges, activities: result.activities },
				null,
				2,
			),
		);
	}, 60_000);

	it("delivers records live, before the cell finishes", async () => {
		const { root, state } = project();
		const manager = kernel(root, state, "1");
		const seen: { at: number; effects: KernelCellEffects }[] = [];
		const result = await manager.execute(
			"import time\nopen('live.txt', 'w').write('hi\\n')\ntime.sleep(1.0)\nprint('end')",
			{ onEffects: (effects) => seen.push({ at: Date.now(), effects }) },
		);
		const finishedAt = Date.now();
		expect(result.status).toBe("ok");
		const firstLive = seen.find((entry) => entry.effects.fileChanges.some((change) => change.relPath === "live.txt"));
		expect(firstLive).toBeDefined();
		expect(finishedAt - (firstLive?.at ?? finishedAt)).toBeGreaterThan(500);
	}, 60_000);

	it("gives the model byte-identical content with tracking on and off", async () => {
		const cells = [
			E2E_CELL,
			"import sys\nsys.stderr.write('warn\\n')\nopen('a.txt').read()",
			"open('c.txt', 'w').write('c')\nraise ValueError('boom')",
		];
		const run = async (tracking: "0" | "1"): Promise<ExecuteResult[]> => {
			const { root, state } = project();
			const manager = kernel(root, state, tracking);
			const results: ExecuteResult[] = [];
			for (const code of cells) results.push(await manager.execute(code));
			return results;
		};
		const off = await run("0");
		const on = await run("1");
		expect(off).toHaveLength(cells.length);
		for (const [index, offResult] of off.entries()) {
			const onResult = on[index] as ExecuteResult;
			expect(offResult.fileChanges).toBeUndefined();
			expect(offResult.activities).toBeUndefined();
			const plain = assembleIpythonToolResult(offResult, { kernelRestarted: false });
			const tracked = assembleIpythonToolResult(onResult, { kernelRestarted: false });
			expect(JSON.stringify(tracked.content)).toBe(JSON.stringify(plain.content));
			expect(tracked.isError).toBe(plain.isError);
		}
		expect(on[0]?.fileChanges?.length).toBeGreaterThan(0);
		expect(on[2]?.fileChanges?.map((change) => change.relPath)).toEqual(["c.txt"]);
	}, 90_000);
});
