import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	computeFileLists,
	createFileOps,
	estimateTokens,
	estimateTokensByContent,
	extractFileOpsFromMessage,
} from "../src/core/compaction/index.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	ACTIVITY_DISPLAY_MIME,
	CHANGE_TRACKING_STATUS_DISPLAY_MIME,
	type ExecuteOptions,
	type ExecuteResult,
	FILE_CHANGE_DISPLAY_MIME,
	type KernelActivity,
	type KernelCellEffects,
	type KernelClient,
	KernelEffectsAccumulator,
	type KernelFileChange,
	type KernelMemoryChange,
	MAX_ACTIVITIES_PER_CELL,
	MEMORY_CHANGE_DISPLAY_MIME,
	parseActivityDisplay,
	parseFileChangeDisplay,
	parseMemoryChangeDisplay,
} from "../src/core/kernel/index.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	assembleIpythonToolResult,
	createIpythonToolDefinition,
	type IpythonKernelProvisioner,
	type IpythonToolDetails,
	LIVE_ACTIVITIES_FULL_EVERY_MS,
	LIVE_EFFECTS_UPDATE_INTERVAL_MS,
	LiveEffectsPartials,
} from "../src/core/tools/ipython.js";

const fileChange: KernelFileChange = {
	path: "/repo/src/a.ts",
	relPath: "src/a.ts",
	kind: "modified",
	scope: "project",
	added: 2,
	removed: 1,
	diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-x\n+y\n+z\n",
	source: "python",
	at: 1_700_000_000_000,
};

const memoryChange: KernelMemoryChange = {
	op: "updated",
	kind: "memory",
	scope: "session",
	id: "deploy",
	title: "Deploy steps v2",
	previousTitle: "Deploy steps",
	before: "use make deploy",
	after: "use make ship",
	at: 1_700_000_000_001,
};

const command: KernelActivity = {
	id: "command-1",
	kind: "command",
	label: "npm test",
	status: "running",
	detail: "compiling",
	startedAt: 1_700_000_000_002,
};

function cellResult(overrides?: Partial<ExecuteResult>): ExecuteResult {
	return { stdout: "done\n", stderr: "", result: "42", status: "ok", durationMs: 5, ...overrides };
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`)).join("\n");
}

describe("change-tracking display payloads", () => {
	it("parses the kernel's file, memory and activity records and their retractions", () => {
		expect(parseFileChangeDisplay(fileChange)).toEqual(fileChange);
		expect(
			parseFileChangeDisplay({ ...fileChange, diff: undefined, diffOmitted: "no_baseline", binary: false }),
		).toEqual({ ...fileChange, diff: undefined, diffOmitted: "no_baseline" });
		const link: KernelFileChange = {
			...fileChange,
			kind: "created",
			added: 0,
			removed: 0,
			diff: undefined,
			symlink: true,
		};
		expect(parseFileChangeDisplay(link)).toEqual(link);
		expect(parseFileChangeDisplay({ ...link, symlink: "yes" })).toEqual({ ...link, symlink: undefined });
		expect(parseFileChangeDisplay({ path: "/repo/x", retracted: true })).toEqual({
			retracted: true,
			key: "/repo/x",
		});
		expect(parseMemoryChangeDisplay(memoryChange)).toEqual(memoryChange);
		expect(parseMemoryChangeDisplay({ kind: "memory", scope: "session", id: "tmp", retracted: true })).toEqual({
			retracted: true,
			key: "memory\u0000session\u0000tmp",
		});
		expect(parseActivityDisplay(command)).toEqual(command);
		const background: KernelActivity = {
			...command,
			status: "ok",
			endedAt: 1_700_000_009_000,
			background: true,
			commit: "1a2b3c4",
		};
		expect(parseActivityDisplay(background)).toEqual(background);
		// Only a real flag and a real commit id survive.
		expect(parseActivityDisplay({ ...command, background: "yes", commit: "not-a-sha" })).toEqual(command);
	});

	it("keeps the withheld-secret markers through to a cell's result fields, and never a withheld text", () => {
		const envChange: KernelFileChange = {
			path: "/repo/.env",
			relPath: ".env",
			kind: "modified",
			scope: "project",
			added: 1,
			removed: 1,
			diffOmitted: "sensitive",
			source: "shell",
			at: 1_700_000_000_003,
		};
		const withheldMemory: KernelMemoryChange = {
			op: "created",
			kind: "memory",
			scope: "session",
			id: "creds",
			title: "creds",
			textOmitted: "sensitive",
			at: 1_700_000_000_004,
		};
		expect(parseFileChangeDisplay(envChange)).toEqual(envChange);
		expect(parseMemoryChangeDisplay(withheldMemory)).toEqual(withheldMemory);
		// A record that claims to be withheld keeps no text, whatever else it carries.
		expect(parseFileChangeDisplay({ ...envChange, diff: "+KEY=sk-leak" })).toEqual(envChange);
		expect(parseMemoryChangeDisplay({ ...withheldMemory, after: "token=sk-leak" })).toEqual(withheldMemory);
		const effects = new KernelEffectsAccumulator();
		effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: envChange });
		effects.apply({ [MEMORY_CHANGE_DISPLAY_MIME]: withheldMemory });
		const fields = effects.resultFields();
		expect(fields.fileChanges?.map((change) => change.diffOmitted)).toEqual(["sensitive"]);
		expect(fields.memoryChanges?.map((change) => change.textOmitted)).toEqual(["sensitive"]);
	});

	it("ignores malformed records instead of throwing", () => {
		for (const bad of [
			null,
			"text",
			{ ...fileChange, kind: "exploded" },
			{ ...fileChange, added: -1 },
			{ ...fileChange, path: "" },
			{ ...fileChange, scope: undefined },
		]) {
			expect(parseFileChangeDisplay(bad)).toBeUndefined();
		}
		expect(parseMemoryChangeDisplay({ ...memoryChange, op: "renamed" })).toBeUndefined();
		expect(parseMemoryChangeDisplay({ kind: "memory", scope: "session", retracted: true })).toBeUndefined();
		expect(parseActivityDisplay({ ...command, status: "paused" })).toBeUndefined();
		expect(parseActivityDisplay({ ...command, startedAt: "now" })).toBeUndefined();
	});

	it("keeps the latest record per file, memory entry and step, and applies retractions", () => {
		const effects = new KernelEffectsAccumulator();
		expect(effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: fileChange })).toBe(true);
		expect(
			effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { ...fileChange, path: "/repo/b.txt", kind: "created" } }),
		).toBe(true);
		expect(effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { ...fileChange, added: 5 } })).toBe(true);
		expect(effects.apply({ [ACTIVITY_DISPLAY_MIME]: command })).toBe(true);
		expect(effects.apply({ [ACTIVITY_DISPLAY_MIME]: { ...command, status: "ok", detail: "54 passed" } })).toBe(true);
		expect(effects.apply({ [MEMORY_CHANGE_DISPLAY_MIME]: memoryChange })).toBe(true);
		expect(effects.apply({ [MEMORY_CHANGE_DISPLAY_MIME]: { ...memoryChange, id: "tmp", op: "created" } })).toBe(true);
		expect(
			effects.apply({
				[MEMORY_CHANGE_DISPLAY_MIME]: { kind: "memory", scope: "session", id: "tmp", retracted: true },
			}),
		).toBe(true);
		expect(effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { path: "/repo/b.txt", retracted: true } })).toBe(true);
		// A retraction of something never reported, and an unrelated payload, change nothing.
		expect(effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { path: "/repo/none", retracted: true } })).toBe(false);
		expect(effects.apply({ "text/plain": "hello" })).toBe(false);
		expect(effects.apply({ [CHANGE_TRACKING_STATUS_DISPLAY_MIME]: { incomplete: "time budget used up" } })).toBe(
			true,
		);

		const snapshot = effects.snapshot();
		expect(snapshot.fileChanges).toEqual([{ ...fileChange, added: 5 }]);
		expect(snapshot.activities).toEqual([{ ...command, status: "ok", detail: "54 passed" }]);
		expect(snapshot.memoryChanges).toEqual([memoryChange]);
		expect(snapshot.changeTrackingIncomplete).toBe("time budget used up");
		// Snapshots are copies: a callback that keeps one never sees later records.
		effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { ...fileChange, path: "/repo/c.txt" } });
		expect(snapshot.fileChanges).toHaveLength(1);
		expect(new KernelEffectsAccumulator().resultFields()).toEqual({});
	});

	it("sends a list emptied by retractions explicitly, and leaves out a list that never held anything", () => {
		const effects = new KernelEffectsAccumulator();
		expect(effects.resultFields()).toEqual({});
		effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: fileChange });
		effects.apply({ [MEMORY_CHANGE_DISPLAY_MIME]: { ...memoryChange, op: "created" } });
		effects.apply({ [FILE_CHANGE_DISPLAY_MIME]: { path: fileChange.path, retracted: true } });
		effects.apply({
			[MEMORY_CHANGE_DISPLAY_MIME]: { kind: "memory", scope: "session", id: memoryChange.id, retracted: true },
		});
		expect(effects.resultFields()).toEqual({ fileChanges: [], memoryChanges: [] });
		const details = assembleIpythonToolResult(cellResult({ ...effects.resultFields() }), {
			kernelRestarted: false,
		}).details;
		expect(details.fileChanges).toEqual([]);
		expect(details.memoryChanges).toEqual([]);
	});

	it("keeps at most the most recent steps, dropping finished ones first and counting them", () => {
		const effects = new KernelEffectsAccumulator();
		const step = (index: number, status: KernelActivity["status"]): KernelActivity => ({
			id: `command-${index}`,
			kind: "command",
			label: `step ${index}`,
			status,
			startedAt: 1_700_000_000_000 + index,
		});
		// Two long-running steps first: a running step outlives finished ones.
		for (const index of [0, 1]) effects.apply({ [ACTIVITY_DISPLAY_MIME]: step(index, "running") });
		const total = 250;
		for (let index = 2; index < total; index++) {
			effects.apply({ [ACTIVITY_DISPLAY_MIME]: step(index, "running") });
			effects.apply({ [ACTIVITY_DISPLAY_MIME]: step(index, "ok") });
		}
		const snapshot = effects.snapshot();
		expect(snapshot.activities).toHaveLength(MAX_ACTIVITIES_PER_CELL);
		expect(snapshot.activitiesDropped).toBe(total - MAX_ACTIVITIES_PER_CELL);
		expect(snapshot.activities.slice(0, 2).map((activity) => activity.id)).toEqual(["command-0", "command-1"]);
		expect(snapshot.activities.at(-1)?.id).toBe(`command-${total - 1}`);
		// A late update of a dropped step does not come back as a new step.
		expect(effects.apply({ [ACTIVITY_DISPLAY_MIME]: { ...step(5, "error"), detail: "exit 1" } })).toBe(false);
		expect(effects.snapshot().activities).toHaveLength(MAX_ACTIVITIES_PER_CELL);
		// The long-running steps still finish in place.
		expect(effects.apply({ [ACTIVITY_DISPLAY_MIME]: step(0, "ok") })).toBe(true);
		expect(effects.snapshot().activities[0]).toMatchObject({ id: "command-0", status: "ok" });
		expect(effects.resultFields().activitiesDropped).toBe(total - MAX_ACTIVITIES_PER_CELL);
	});
});

describe("live change partials", () => {
	const snapshotOf = (overrides: Partial<KernelCellEffects>): KernelCellEffects => ({
		fileChanges: [],
		memoryChanges: [],
		activities: [],
		...overrides,
	});

	it("trims file and memory lists and sends them only when they changed", () => {
		let now = 0;
		const partials = new LiveEffectsPartials(() => now);
		expect(partials.details(snapshotOf({}))).toEqual({});
		const files = [fileChange];
		const memory = [memoryChange];
		const first = partials.details(snapshotOf({ fileChanges: files, memoryChanges: memory }));
		const { diff: _diff, ...withoutDiff } = fileChange;
		expect(first.fileChanges).toEqual([withoutDiff]);
		expect(first.memoryChanges?.[0]).not.toHaveProperty("before");
		expect(first.memoryChanges?.[0]).not.toHaveProperty("after");
		expect(first.memoryChanges?.[0]?.previousTitle).toBe("Deploy steps");
		now += 200;
		// The same records again: nothing to resend.
		expect(partials.details(snapshotOf({ fileChanges: [...files], memoryChanges: [...memory] }))).toEqual({});
		now += 200;
		const retracted = partials.details(snapshotOf({ fileChanges: [], memoryChanges: [...memory] }));
		expect(retracted).toEqual({ fileChanges: [] });
		expect(partials.details(undefined)).toEqual({});
	});

	it("sends only new or changed steps, every kept step periodically, and the dropped count", () => {
		let now = 0;
		const partials = new LiveEffectsPartials(() => now);
		const a = { ...command, id: "a" };
		const b = { ...command, id: "b" };
		expect(partials.details(snapshotOf({ activities: [a, b] })).activities).toEqual([a, b]);
		now += 200;
		expect(partials.details(snapshotOf({ activities: [a, b] }))).toEqual({});
		now += 200;
		const bDone: KernelActivity = { ...b, status: "ok", detail: "done" };
		const c = { ...command, id: "c" };
		expect(partials.details(snapshotOf({ activities: [a, bDone, c], activitiesDropped: 3 }))).toEqual({
			activities: [bDone, c],
			activitiesDropped: 3,
		});
		now += LIVE_ACTIVITIES_FULL_EVERY_MS;
		expect(partials.details(snapshotOf({ activities: [a, bDone, c], activitiesDropped: 3 })).activities).toEqual([
			a,
			bDone,
			c,
		]);
	});
});

describe("change tracking never reaches the model", () => {
	const withEffects = cellResult({
		fileChanges: [fileChange],
		memoryChanges: [memoryChange],
		activities: [{ ...command, status: "ok", endedAt: 1_700_000_000_500 }],
		changeTrackingIncomplete: "time budget used up",
	});

	it("assembles byte-identical model content with and without change records", () => {
		for (const status of ["ok", "error", "aborted"] as const) {
			const base = cellResult({
				status,
				...(status === "error" ? { error: { ename: "ValueError", evalue: "x", traceback: ["tb"] } } : {}),
			});
			const tracked = { ...withEffects, status, error: base.error };
			const plain = assembleIpythonToolResult(base, { kernelRestarted: false });
			const rich = assembleIpythonToolResult(tracked, { kernelRestarted: false });
			expect(textOf(plain.content).length).toBeGreaterThan(0);
			expect(JSON.stringify(rich.content)).toBe(JSON.stringify(plain.content));
			expect(rich.isError).toBe(plain.isError);
		}
		const rich = assembleIpythonToolResult(withEffects, { kernelRestarted: false });
		expect(rich.details.fileChanges).toEqual([fileChange]);
		expect(rich.details.memoryChanges).toEqual([memoryChange]);
		expect(rich.details.activities?.[0]?.status).toBe("ok");
		expect(rich.details.changeTrackingIncomplete).toBe("time budget used up");
		const plain = assembleIpythonToolResult(cellResult(), { kernelRestarted: false });
		expect(plain.details).not.toHaveProperty("fileChanges");
		expect(plain.details).not.toHaveProperty("activities");
	});

	it("compaction's file lists and token estimates ignore the new fields", () => {
		const details = assembleIpythonToolResult(withEffects, { kernelRestarted: false }).details;
		const message = (withDetails: IpythonToolDetails): AgentMessage =>
			({
				role: "toolResult",
				toolCallId: "t1",
				toolName: "ipython",
				content: [{ type: "text", text: "done\n42" }],
				details: withDetails,
				isError: false,
				timestamp: 1,
			}) as ToolResultMessage as AgentMessage;
		const ops = createFileOps();
		extractFileOpsFromMessage(message(details), ops);
		expect(computeFileLists(ops)).toEqual({ readFiles: [], modifiedFiles: [] });
		const bare = message({ status: "ok", stdout: "done\n", result: "42" });
		expect(estimateTokens(message(details))).toBe(estimateTokens(bare));
		expect(estimateTokensByContent(message(details))).toBe(estimateTokensByContent(bare));
	});
});

function fakeProvisioner(execute: KernelClient["execute"]): IpythonKernelProvisioner {
	const manager = { execute } as unknown as KernelClient;
	return { ensure: vi.fn(async () => manager), kill: vi.fn(async () => {}) } as unknown as IpythonKernelProvisioner;
}

function effectsAt(step: number): KernelCellEffects {
	return {
		fileChanges: step >= 1 ? [{ ...fileChange, added: step }] : [],
		memoryChanges: step >= 2 ? [memoryChange] : [],
		activities: [{ ...command, detail: `line ${step}` }],
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ipython tool live change updates", () => {
	it("streams cumulative, trimmed, throttled partials and puts the full records in the final details", async () => {
		const final = cellResult({
			fileChanges: [{ ...fileChange, added: 3 }],
			memoryChanges: [memoryChange],
			activities: [{ ...command, status: "ok", detail: "54 passed", endedAt: 1_700_000_001_000 }],
		});
		const execute = vi.fn(async (_code: string, opts?: ExecuteOptions) => {
			opts?.onEffects?.(effectsAt(0));
			opts?.onEffects?.(effectsAt(1));
			opts?.onStream?.("halfway\n", "stdout");
			opts?.onEffects?.(effectsAt(2));
			await sleep(LIVE_EFFECTS_UPDATE_INTERVAL_MS + 100);
			opts?.onEffects?.(effectsAt(3));
			await sleep(LIVE_EFFECTS_UPDATE_INTERVAL_MS + 100);
			return final;
		});
		const updates: { content: unknown[]; details: IpythonToolDetails }[] = [];
		const tool = createIpythonToolDefinition("/tmp", { provisioner: fakeProvisioner(execute) });
		const result = await tool.execute(
			"call-1",
			{ code: "work()" },
			undefined,
			(partial) => updates.push(partial as { content: unknown[]; details: IpythonToolDetails }),
			{} as ExtensionContext,
		);

		expect(updates.length).toBeGreaterThan(0);
		// The first record goes out at once; the burst after it is coalesced, never dropped.
		expect(updates[0]?.details.activities?.[0]?.detail).toBe("line 0");
		const effectUpdates = updates.filter((update) => update.details.activities !== undefined);
		expect(effectUpdates.length).toBeLessThan(5);
		const last = updates[updates.length - 1];
		expect(last?.details.activities?.[0]?.detail).toBe("line 3");
		expect(last?.details.fileChanges?.[0]?.added).toBe(3);
		for (const update of updates) {
			for (const change of update.details.fileChanges ?? []) expect(change).not.toHaveProperty("diff");
			for (const change of update.details.memoryChanges ?? []) {
				expect(change).not.toHaveProperty("before");
				expect(change).not.toHaveProperty("after");
			}
		}
		// A stream chunk keeps the change lists, and a later change update keeps the chunk.
		const chunkUpdate = updates.find((update) => textOf(update.content as { type: string }[]) === "halfway\n");
		expect(chunkUpdate?.details.fileChanges).toHaveLength(1);
		expect(textOf(last?.content as { type: string }[])).toBe("halfway\n");

		expect(result.details.fileChanges).toEqual([{ ...fileChange, added: 3 }]);
		expect(result.details.memoryChanges).toEqual([memoryChange]);
		expect(result.details.activities?.[0]?.detail).toBe("54 passed");

		// The model-facing content matches a run that produced no change records at all.
		const plainTool = createIpythonToolDefinition("/tmp", {
			provisioner: fakeProvisioner(vi.fn(async () => cellResult())),
		});
		const plain = await plainTool.execute("call-2", { code: "work()" }, undefined, undefined, {} as ExtensionContext);
		expect(JSON.stringify(result.content)).toBe(JSON.stringify(plain.content));
	});

	it("coalesces a burst of ten records into at most two updates", async () => {
		const execute = vi.fn(async (_code: string, opts?: ExecuteOptions) => {
			for (let step = 0; step < 10; step++) opts?.onEffects?.(effectsAt(step));
			await sleep(LIVE_EFFECTS_UPDATE_INTERVAL_MS + 100);
			return cellResult();
		});
		const updates: IpythonToolDetails[] = [];
		const tool = createIpythonToolDefinition("/tmp", { provisioner: fakeProvisioner(execute) });
		await tool.execute(
			"call-burst",
			{ code: "x" },
			undefined,
			(partial) => updates.push((partial as { details: IpythonToolDetails }).details),
			{} as ExtensionContext,
		);
		// Without the throttle this would be ten updates; with it, the first record and one trailing one.
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates.length).toBeLessThanOrEqual(2);
		expect(updates.at(-1)?.activities?.[0]?.detail).toBe("line 9");
	});

	it("sends no change update after the tool has returned", async () => {
		const execute = vi.fn(async (_code: string, opts?: ExecuteOptions) => {
			opts?.onEffects?.(effectsAt(0));
			opts?.onEffects?.(effectsAt(1));
			return cellResult();
		});
		const updates: unknown[] = [];
		const tool = createIpythonToolDefinition("/tmp", { provisioner: fakeProvisioner(execute) });
		await tool.execute(
			"call-3",
			{ code: "x" },
			undefined,
			(partial) => updates.push(partial),
			{} as ExtensionContext,
		);
		const seen = updates.length;
		await sleep(LIVE_EFFECTS_UPDATE_INTERVAL_MS + 100);
		expect(updates.length).toBe(seen);
	});
});

describe("changeTracking setting", () => {
	it("is on by default and can be turned off from settings.json without an unknown-key warning", () => {
		expect(SettingsManager.inMemory().getChangeTrackingEnabled()).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-change-tracking-settings-"));
		try {
			const agentDir = join(dir, "agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ changeTracking: { enabled: false } }));
			const manager = SettingsManager.create(join(dir, "project"), agentDir);
			expect(manager.getChangeTrackingEnabled()).toBe(false);
			expect(manager.drainWarnings().filter((warning) => warning.message.includes("changeTracking"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
