import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	CHANGE_TRACKING_ENV_VAR,
	type ExecuteResult,
	type KernelActivity,
	type KernelCellEffects,
	type KernelClient,
	MAX_ACTIVITIES_PER_CELL,
	ReplKernelManager,
} from "../src/core/kernel/index.js";
import {
	assembleIpythonToolResult,
	createIpythonToolDefinition,
	type IpythonKernelProvisioner,
	type IpythonToolDetails,
	LIVE_ACTIVITIES_FULL_EVERY_MS,
} from "../src/core/tools/ipython.js";
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

	function toolOver(manager: ReplKernelManager, root: string) {
		const provisioner = {
			ensure: vi.fn(async () => manager as KernelClient),
			kill: vi.fn(async () => {}),
		} as unknown as IpythonKernelProvisioner;
		return createIpythonToolDefinition(root, { provisioner });
	}

	it("clears a change that was undone within the cell, live and in the final details", async () => {
		const { root, state } = project();
		const manager = kernel(root, state, "1");
		const tool = toolOver(manager, root);
		const partials: IpythonToolDetails[] = [];
		const result = await tool.execute(
			"call-undo",
			{
				code: [
					"import rlm, time",
					"open('a.txt', 'w').write('changed\\n')",
					"rlm.harness.create_memory('Scratch', 'temporary', id='scratch')",
					"time.sleep(0.8)",
					"open('a.txt', 'w').write('one\\ntwo\\nthree\\n')",
					"rlm.harness.delete_memory('scratch')",
					"time.sleep(0.5)",
				].join("\n"),
			},
			undefined,
			(partial) => partials.push((partial as { details: IpythonToolDetails }).details),
			{} as ExtensionContext,
		);
		expect(result.details.status).toBe("ok");
		// The viewer saw the change live, then an explicit empty list replacing it.
		const shown = partials.findIndex((details) => (details.fileChanges?.length ?? 0) === 1);
		expect(shown).toBeGreaterThanOrEqual(0);
		const cleared = partials.findIndex((details, index) => index > shown && details.fileChanges?.length === 0);
		expect(cleared).toBeGreaterThan(shown);
		expect(partials.some((details) => (details.memoryChanges?.length ?? 0) === 1)).toBe(true);
		expect(partials.some((details) => details.memoryChanges?.length === 0)).toBe(true);
		expect(result.details.fileChanges).toEqual([]);
		expect(result.details.memoryChanges).toEqual([]);
	}, 60_000);

	it("reports a command its cell left running as moved to the background, and its end in a later cell", async () => {
		const { root, state } = project();
		const manager = kernel(root, state, "1");
		const first = await manager.execute("import rlm\nh = rlm.bash('sleep 0.6; echo finished')\nh.pid");
		const left = first.activities?.find((activity) => activity.kind === "command");
		expect(left).toMatchObject({ status: "running", background: true });
		expect(left?.endedAt).toBeGreaterThanOrEqual(left?.startedAt ?? Number.POSITIVE_INFINITY);
		const second = await manager.execute("import time\ntime.sleep(1.2)");
		const ended = second.activities?.find((activity) => activity.id === left?.id);
		expect(ended).toMatchObject({ status: "ok", background: true, detail: "finished" });
	}, 60_000);

	it("keeps a cell of many commands bounded, in its result and in its live updates", async () => {
		const { root, state } = project();
		const manager = kernel(root, state, "1");
		const provisioner = {
			ensure: vi.fn(async () => manager as KernelClient),
			kill: vi.fn(async () => {}),
		} as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(root, { provisioner });
		const commands = 150;
		const partials: IpythonToolDetails[] = [];
		const started = Date.now();
		const result = await tool.execute(
			"call-many",
			{ code: `import rlm\nbash = rlm.bash\nfor i in range(${commands}):\n    await bash('true')\nprint('done')` },
			undefined,
			(partial) => partials.push((partial as { details: IpythonToolDetails }).details),
			{} as ExtensionContext,
		);
		const elapsed = Date.now() - started;
		expect(result.details.status).toBe("ok");
		const final = result.details.activities ?? [];
		expect(final).toHaveLength(MAX_ACTIVITIES_PER_CELL);
		expect(result.details.activitiesDropped).toBe(commands - MAX_ACTIVITIES_PER_CELL);
		expect(final.every((activity) => activity.kind === "command" && activity.status === "ok")).toBe(true);

		expect(partials.length).toBeGreaterThan(0);
		// A viewer merging the partials by id ends up with every step the final result kept.
		const merged = new Map<string, KernelActivity>();
		let sentEntries = 0;
		for (const details of partials) {
			expect(details.activities?.length ?? 0).toBeLessThanOrEqual(MAX_ACTIVITIES_PER_CELL);
			for (const activity of details.activities ?? []) merged.set(activity.id, activity);
			sentEntries += details.activities?.length ?? 0;
		}
		for (const activity of final) expect(merged.has(activity.id)).toBe(true);
		// Each step is resent only when it changes (start, output, end), plus a full list every few seconds;
		// resending the whole list on every 200 ms update would cost far more than this.
		const fullRefreshes = 1 + Math.floor(elapsed / LIVE_ACTIVITIES_FULL_EVERY_MS);
		expect(sentEntries).toBeLessThanOrEqual(3 * commands + MAX_ACTIVITIES_PER_CELL * fullRefreshes);
	}, 90_000);

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
			expect(plain.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
			expect(JSON.stringify(tracked.content)).toBe(JSON.stringify(plain.content));
			expect(tracked.isError).toBe(plain.isError);
		}
		expect(on[0]?.fileChanges?.length).toBeGreaterThan(0);
		expect(on[2]?.fileChanges?.map((change) => change.relPath)).toEqual(["c.txt"]);
	}, 90_000);
});
