import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type FileChangeSummary,
	formatTotalChangeSummary,
	getToolFileChanges,
	mergeTurnFileChanges,
} from "../src/modes/interactive/components/edit-summary.js";
import { TurnActivityState } from "../src/modes/interactive/components/turn-activity.js";
import { recordStepFileChanges } from "../src/modes/interactive/live-turn-flow.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * review2-6: an edit whose diff the edit skill withheld (`omitted: "sensitive"`, it looks
 * like a secret) showed as "内容没存：看起来是密钥" on the change strip and on the cell's
 * summary row, but the turn's own file list skipped it: the file vanished from the process
 * line and the recap, and "改动 N 个文件" left it out. It is now listed like the strip
 * lists it: the path and the same words, no "+0 −0", counted as a file.
 */

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, toolName: string, details: unknown): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [], details, isError: false, timestamp: 0 };
}

const withheld = (path: string) => ({ path, omitted: "sensitive" });
const plainDiff = (path: string) => ({ path, oldStr: "old", newStr: "new" });

describe("a withheld edit in the turn's file list (review2-6)", () => {
	beforeAll(() => initTheme("dark"));

	it("getToolFileChanges lists the withheld file with no counts and marks it", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{ details: { diffs: [withheld("config/.env")] }, isError: false },
			"/tmp/work",
		);
		expect(changes).toStrictEqual([{ path: "config/.env", added: 0, removed: 0, omitted: true }]);
	});

	it("leaves an ordinary edit exactly as before, with no marker", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{ details: { diffs: [plainDiff("src/a.ts")] }, isError: false },
			"/tmp/work",
		);
		expect(changes).toStrictEqual([{ path: "src/a.ts", added: 1, removed: 1 }]);
	});

	it("keeps the marker when the same file also has an ordinary edit in the cell", () => {
		const details = { diffs: [plainDiff("app.env"), withheld("app.env")] };
		expect(getToolFileChanges("ipython", {}, { details, isError: false }, "/tmp/work")).toStrictEqual([
			{ path: "app.env", added: 1, removed: 1, omitted: true },
		]);
		const reversed = { diffs: [withheld("app.env"), plainDiff("app.env")] };
		expect(getToolFileChanges("ipython", {}, { details: reversed, isError: false }, "/tmp/work")).toStrictEqual([
			{ path: "app.env", added: 1, removed: 1, omitted: true },
		]);
	});

	it("counts the withheld file in the turn's changed files and keeps its marker across steps", () => {
		const message = assistant([
			{ type: "toolCall", id: "one", name: "edit", arguments: { path: "src/a.ts" } },
			{ type: "toolCall", id: "two", name: "ipython", arguments: {} },
			{ type: "toolCall", id: "three", name: "ipython", arguments: {} },
		]);
		const changes = new Map<string, FileChangeSummary>();
		mergeTurnFileChanges(
			changes,
			message,
			[
				toolResult("one", "edit", { diff: "-1 old\n+1 new" }),
				toolResult("two", "ipython", { diffs: [plainDiff("keys.env")] }),
				toolResult("three", "ipython", { diffs: [withheld("keys.env"), withheld("id.pem")] }),
			],
			"/tmp/work",
		);
		expect([...changes.values()].map((change) => change.path).sort()).toEqual(["id.pem", "keys.env", "src/a.ts"]);
		expect(changes.get("/tmp/work/keys.env")).toMatchObject({ added: 1, removed: 1, omitted: true });
		expect(changes.get("/tmp/work/id.pem")).toMatchObject({ added: 0, removed: 0, omitted: true });
		expect(changes.get("/tmp/work/src/a.ts")?.omitted).toBeUndefined();
		expect(stripAnsi(formatTotalChangeSummary([...changes.values()]))).toBe("改动 3 个文件 · +2 −2");
	});

	it("says a run that only withheld edits changed files, without a +0 −0 total", () => {
		const line = stripAnsi(formatTotalChangeSummary([{ path: "id.pem", added: 0, removed: 0, omitted: true }]));
		expect(line).toBe("改动 1 个文件");
		expect(line).not.toContain("+0");
	});

	it("keeps the plain total for ordinary edits", () => {
		expect(stripAnsi(formatTotalChangeSummary([{ path: "a.ts", added: 2, removed: 1 }]))).toBe(
			"改动 1 个文件 · +2 −1",
		);
	});

	it("lands on the turn's process line data, merged with a later ordinary edit of the same file", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "s1", toolName: "ipython", args: {}, status: "done" });
		state.addStep({ toolCallId: "s2", toolName: "ipython", args: {}, status: "done" });
		recordStepFileChanges(
			state,
			"s1",
			{ details: { diffs: [withheld("secrets/.env")] }, isError: false },
			"/tmp/work",
		);
		expect(state.fileChanges).toStrictEqual([{ path: "secrets/.env", added: 0, removed: 0, omitted: true }]);
		recordStepFileChanges(
			state,
			"s2",
			{ details: { diffs: [plainDiff("secrets/.env")] }, isError: false },
			"/tmp/work",
		);
		expect(state.fileChanges).toStrictEqual([{ path: "secrets/.env", added: 1, removed: 1, omitted: true }]);
	});

	it("still drops a change with no lines that was not withheld", () => {
		const state = new TurnActivityState(1_000);
		state.addFileChanges([{ path: "src/b.ts", added: 0, removed: 0 }]);
		expect(state.fileChanges).toEqual([]);
	});
});
