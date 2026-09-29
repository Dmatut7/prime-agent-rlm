import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "../src/core/compaction/index.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { parseDiffDisplay } from "../src/core/kernel/shared.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { assembleIpythonToolResult } from "../src/core/tools/ipython.js";
import { formatFileChangeSummaryLine, getToolFileChanges } from "../src/modes/interactive/components/edit-summary.js";
import { aggregateChanges, emptyStepFeedData, mergeStepResult } from "../src/modes/interactive/components/feed-data.js";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { changeDetail, omittedDiffText } from "../src/modes/interactive/components/timeline-rows.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { resolveKernelPython } from "./kernel-python.js";

const SENSITIVE_TEXT = "内容没存：看起来是密钥";
const OLD_KEY = `${"sk-"}${"OLDFAKE"}${"0".repeat(24)}`;
const NEW_KEY = `${"sk-"}${"NEWFAKE"}${"0".repeat(24)}`;

const withheld = { path: "/work/app/.env", omitted: "sensitive" } as const;

function toolResult(details: unknown, toolName = "ipython"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName,
		content: [{ type: "text", text: "Edited /work/app/.env" }],
		details,
		isError: false,
		timestamp: 0,
	} as ToolResultMessage as AgentMessage;
}

describe("parseDiffDisplay", () => {
	it("keeps the path of an edit whose texts the skill withheld, and no texts", () => {
		expect(parseDiffDisplay({ path: "/work/app/.env", omitted: "sensitive" })).toEqual({
			path: "/work/app/.env",
			omitted: "sensitive",
		});
	});

	it("drops any text that rides next to the withheld marker", () => {
		const parsed = parseDiffDisplay({
			path: "/work/app/.env",
			omitted: "sensitive",
			old_str: `API_KEY=${OLD_KEY}`,
			new_str: `API_KEY=${NEW_KEY}`,
			start_line: 3,
		});
		expect(parsed).toEqual({ path: "/work/app/.env", omitted: "sensitive" });
		expect(JSON.stringify(parsed)).not.toContain(OLD_KEY);
		expect(JSON.stringify(parsed)).not.toContain(NEW_KEY);
	});

	it("still parses an ordinary edit as it always did and still rejects a payload with neither texts nor the marker", () => {
		expect(parseDiffDisplay({ path: "/tmp/f.py", old_str: "a", new_str: "b", start_line: 3 })).toEqual({
			path: "/tmp/f.py",
			oldStr: "a",
			newStr: "b",
			startLine: 3,
		});
		expect(parseDiffDisplay({ path: "/tmp/f.py" })).toBeUndefined();
		expect(parseDiffDisplay({ path: "/tmp/f.py", omitted: "unknown-reason" })).toBeUndefined();
		expect(parseDiffDisplay({ omitted: "sensitive" })).toBeUndefined();
		expect(parseDiffDisplay("not a record")).toBeUndefined();
	});
});

describe("compaction still lists a file the edit skill withheld", () => {
	it("puts the path in <modified-files>, with no text of the edit anywhere", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(toolResult({ diffs: [withheld] }), ops);
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		expect(modifiedFiles).toEqual(["/work/app/.env"]);
		const block = formatFileOperations(readFiles, modifiedFiles);
		expect(block).toContain("<modified-files>\n/work/app/.env\n</modified-files>");
	});

	it("lists a withheld edit next to an ordinary one", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			toolResult({ diffs: [withheld, { path: "/work/app/a.ts", oldStr: "x", newStr: "y" }] }),
			ops,
		);
		expect(computeFileLists(ops).modifiedFiles).toEqual(["/work/app/.env", "/work/app/a.ts"]);
	});
});

describe("renderers show a withheld edit as the reason, not as a diff", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const cell = (details: unknown): string[] =>
		new IPythonCellComponent({
			code: 'await edit(path=".env", old_str=old, new_str=new)',
			details,
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			editDiffsExpanded: true,
			cwd: "/work/app",
		})
			.render(80)
			.map((line) => stripAnsi(line));

	it("the cell view says the content was not kept, in place of the line counts", () => {
		const lines = cell({ status: "ok", result: "'Edited /work/app/.env'", diffs: [withheld] });
		expect(lines.find((line) => line.includes("╰─ .env"))).toBe(`    ╰─ .env ${SENSITIVE_TEXT}`);
		expect(lines.join("\n")).not.toMatch(/\+0|−0/);
		// The edit skill's own confirmation stays hidden, as for any edit.
		expect(lines.some((line) => line.trim() === "'Edited /work/app/.env'")).toBe(false);
	});

	it("the cell view keeps the counts of an ordinary edit of the same cell", () => {
		const lines = cell({
			status: "ok",
			diffs: [withheld, { path: "/work/app/a.ts", oldStr: "x", newStr: "y", startLine: 1 }],
		});
		expect(lines.find((line) => line.includes("╰─ .env"))).toBe(`    ╰─ .env ${SENSITIVE_TEXT}`);
		expect(lines.find((line) => line.includes("╰─ a.ts"))).toBe("    ╰─ a.ts +1 −1");
	});

	it("the summary line shows the reason next to known counts too", () => {
		const line = stripAnsi(
			formatFileChangeSummaryLine("a.ts", undefined, { added: 2, removed: 1, omitted: "R" }, 60),
		);
		expect(line).toBe("    ╰─ a.ts +2 −1 · R");
		const only = stripAnsi(
			formatFileChangeSummaryLine("a.ts", undefined, { added: 0, removed: 0, omitted: "R" }, 60),
		);
		expect(only).toBe("    ╰─ a.ts R");
		const plain = stripAnsi(formatFileChangeSummaryLine("a.ts", undefined, { added: 2, removed: 1 }, 60));
		expect(plain).toBe("    ╰─ a.ts +2 −1");
	});

	it("the turn's change list has the file, with the reason and no rows", () => {
		const data = mergeStepResult(emptyStepFeedData(), "ipython", {}, { details: { diffs: [withheld] } }, false);
		expect(data.legacyDiffs).toEqual([withheld]);
		const entries = aggregateChanges([{ data, toolName: "ipython", order: 1 }], "/work/app");
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry).toMatchObject({ path: ".env", kind: "modified", added: 0, removed: 0, omitted: "sensitive" });
		expect(entry.rows).toEqual([]);
		expect(omittedDiffText(entry.omitted)).toBe(SENSITIVE_TEXT);
		expect(changeDetail(entry)(80).map((line) => stripAnsi(line))).toEqual([SENSITIVE_TEXT]);
	});

	it("the count summaries list a withheld edit, marked and without counts, instead of failing on its missing texts", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{ details: { diffs: [withheld, { path: "b.ts", oldStr: "old", newStr: "new" }] }, isError: false },
			"/work/app",
		);
		expect(changes).toEqual([
			{ path: withheld.path, added: 0, removed: 0, omitted: true },
			{ path: "b.ts", added: 1, removed: 1 },
		]);
		expect(
			getToolFileChanges("ipython", {}, { details: { diffs: [withheld] }, isError: false }, "/work/app"),
		).toEqual([{ path: withheld.path, added: 0, removed: 0, omitted: true }]);
	});
});

describe("the timeline lists a withheld edit when tracking is off", () => {
	const host = (): TimelineHost => ({
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
	});

	beforeAll(() => {
		initTheme("prime");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("lists ✎ .env as a step of its event, with the reason where the counts would be", () => {
		const state = new TurnActivityState(Date.now() - 5_000);
		state.live = true;
		state.modelId = "glm-5.3-prime";
		const summary = new TurnSummaryComponent(state);
		summary.setTimelineHost(host());
		summary.setQuiet(true);
		const timestamp = Date.now() - 4_000;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "d1", name: "ipython", arguments: { code: 'edit(".env", "a", "b")' } }],
			api: "test-api",
			provider: "test-provider",
			model: "glm-5.3-prime",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
		};
		state.timeline.noteMessage(message, true);
		state.addStep({
			toolCallId: "d1",
			toolName: "ipython",
			args: { code: 'edit(".env", "a", "b")' },
			status: "queued",
		});
		state.setStepStatus("d1", "running", timestamp);
		state.setStepStatus("d1", "done", timestamp + 500);
		state.timeline.mergeStep("d1", "ipython", {}, { details: { diffs: [withheld] } }, false);
		summary.render(120);
		const eventKey = summary.getFocusOrder().find((key) => key.startsWith("ev:"));
		expect(eventKey).toBeDefined();
		// The event line says what the step did; the step behind `N 步 ▸` carries the reason.
		expect(stripAnsi(summary.render(120)[0] ?? "")).toContain("改了 1 个文件");
		summary.activate(eventKey ?? "");
		const lines = summary.render(120).map((line) => stripAnsi(line));
		const step = lines.find((line) => line.includes("✎"));
		expect(step).toMatch(new RegExp(`✎  \\.env\\s+${SENSITIVE_TEXT}\\s*$`));
		expect(step).not.toMatch(/\+0|−0/);
		// Opened, the step says the same reason instead of a diff.
		const stepKey = summary.getFocusOrder().find((key) => key.startsWith("file:"));
		expect(stepKey).toBeDefined();
		summary.activate(stepKey ?? "");
		const opened = summary.render(120).map((line) => stripAnsi(line));
		const at = opened.findIndex((line) => line.includes("✎"));
		expect(opened[at + 1]?.trim().replace(/^│\s*/, "")).toBe(SENSITIVE_TEXT);
	});
});

const python = await resolveKernelPython("import rlm.repl, dill");
const describeIf = python ? describe : describe.skip;
const RUNTIME_SRC = fileURLToPath(new URL("../../../prime-agent-runtime/src", import.meta.url));
const EDIT_SKILL_SRC = fileURLToPath(new URL("../skills/edit/src", import.meta.url));

describeIf("the edit skill through a real kernel (runtime and host together)", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-edit-secret-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: false, drainHostRequests: true });
		manager = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function edit(file: string, before: string, after: string) {
		manager = new ReplKernelManager({ python: python as string, cwd: dir, env: { PYTHONPATH: RUNTIME_SRC } });
		const code = [
			"import sys",
			`sys.path.insert(0, ${JSON.stringify(EDIT_SKILL_SRC)})`,
			"import edit",
			`await edit.run(${JSON.stringify(file)}, ${JSON.stringify(before)}, ${JSON.stringify(after)})`,
		].join("\n");
		const result = await manager.execute(code);
		expect(result.status).toBe("ok");
		return result;
	}

	it("hands the host only the path of an edit to a credential file, and compaction still lists it", async () => {
		const file = join(dir, ".env");
		writeFileSync(file, `API_KEY=OLD-${OLD_KEY}\nDEBUG=1\n`);
		const result = await edit(file, `API_KEY=OLD-${OLD_KEY}`, `API_KEY=NEW-${NEW_KEY}`);

		expect(result.diffs).toHaveLength(1);
		expect(result.diffs?.[0]).toMatchObject({ omitted: "sensitive" });
		expect(result.diffs?.[0]?.path.endsWith("/.env")).toBe(true);
		const everything = JSON.stringify(result);
		expect(everything).not.toContain(OLD_KEY);
		expect(everything).not.toContain(NEW_KEY);
		// The same write's file record stays withheld too.
		expect(result.fileChanges?.find((change) => change.path.endsWith("/.env"))?.diffOmitted).toBe("sensitive");

		const assembled = assembleIpythonToolResult(result, { kernelRestarted: false });
		const ops = createFileOps();
		extractFileOpsFromMessage(
			{ ...assembled, role: "toolResult", toolCallId: "t", toolName: "ipython", timestamp: 0 } as AgentMessage,
			ops,
		);
		expect(computeFileLists(ops).modifiedFiles).toEqual([result.diffs?.[0]?.path]);
	}, 30_000);

	it("still hands the host the whole edit of an ordinary file", async () => {
		const file = join(dir, "notes.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		const result = await edit(file, "beta", "BETA");
		expect(result.diffs).toEqual([
			{ path: expect.stringMatching(/\/notes\.txt$/), oldStr: "beta", newStr: "BETA", startLine: 2 },
		]);
	}, 30_000);
});
