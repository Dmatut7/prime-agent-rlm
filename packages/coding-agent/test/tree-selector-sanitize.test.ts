import type { ServiceTier, StopReason, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { BashExecutionMessage } from "../src/core/messages.js";
import type {
	AgentConnectionSessionEntry,
	AgentConnectionSessionMessageEntry,
	AgentConnectionSessionTreeNode,
} from "../src/modes/agent-connection/index.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The /tree selector paints every row itself: `TreeList.render` concatenates the
 * cursor, gutters, label and entry text into one `theme.fg` string and clamps it
 * with `truncateToWidth`, so no `Text` render (the central wash) ever sees it.
 * Every text source below is written by a model, by a page a model read, or by a
 * session file an older writer left behind: a clipboard write, a screen clear, a
 * bell, a carriage return that rewinds the row, a newline that turns one row into
 * two, and a hyperlink that invents a click target.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J\u001b[H";
const HYPERLINK = "\u001b]8;;http://evil.example\u0007";

/**
 * Byte-level verdict for a rendered face: the theme's own SGR codes are
 * legitimate, so the escape check runs on the stripped text, while the injected
 * sequences and the clipboard payload must be gone from the raw bytes too.
 */
function expectRenderClean(lines: readonly string[]): string {
	const joined = lines.join("\n");
	expect(joined).not.toContain("\u001b]52");
	expect(joined).not.toContain("\u001b[2J");
	expect(joined).not.toContain("cGFzdGU=");
	expect(joined).not.toContain("evil.example");
	expect(joined).not.toContain("\u0007");
	const plain = stripAnsi(joined);
	expect(plain).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	return plain;
}

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function entryBase(id: string, parentId: string | null) {
	return { id, parentId, timestamp: new Date().toISOString() };
}

function messageEntry(
	id: string,
	parentId: string | null,
	message: AgentConnectionSessionMessageEntry["message"],
): AgentConnectionSessionMessageEntry {
	return { type: "message", ...entryBase(id, parentId), message };
}

function userMessage(id: string, parentId: string | null, content: string): AgentConnectionSessionMessageEntry {
	return messageEntry(id, parentId, { role: "user", content, timestamp: Date.now() });
}

function assistantMessage(
	id: string,
	parentId: string | null,
	content: (TextContent | ToolCall)[],
	overrides: { stopReason?: StopReason; errorMessage?: string } = {},
): AgentConnectionSessionMessageEntry {
	return messageEntry(id, parentId, {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		...(overrides.errorMessage !== undefined ? { errorMessage: overrides.errorMessage } : {}),
		timestamp: Date.now(),
	});
}

function toolResult(
	id: string,
	parentId: string | null,
	toolCallId: string,
	toolName: string,
): AgentConnectionSessionMessageEntry {
	return messageEntry(id, parentId, {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	});
}

function bashExecution(id: string, parentId: string | null, command: string): AgentConnectionSessionMessageEntry {
	const message: BashExecutionMessage = {
		role: "bashExecution",
		command,
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	};
	return messageEntry(id, parentId, message);
}

/** Chain the entries so the tree renders one row per entry, top to bottom. */
function buildChain(entries: AgentConnectionSessionEntry[]): AgentConnectionSessionTreeNode[] {
	const nodes = entries.map((entry) => ({ entry, children: [] as AgentConnectionSessionTreeNode[] }));
	for (let index = 1; index < nodes.length; index++) {
		nodes[index - 1]!.children.push(nodes[index]!);
	}
	return nodes.length > 0 ? [nodes[0]!] : [];
}

function dirtyTree(): { tree: AgentConnectionSessionTreeNode[]; leafId: string; visibleRows: number } {
	const entries: AgentConnectionSessionEntry[] = [
		userMessage("user-1", null, `你好${OSC52} worker`),
		assistantMessage("asst-1", "user-1", [{ type: "text", text: `done${CLEAR}\u0007 report` }]),
		assistantMessage("asst-err", "asst-1", [], { stopReason: "error", errorMessage: `rate limited${OSC52}` }),
		// Tool-call-only assistant rows are hidden, but they feed the tool-call map
		// the tool-result rows render their header from.
		assistantMessage("asst-tc-bash", "asst-err", [
			{ type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: `git status${OSC52} && ls\r` } },
		]),
		toolResult("tr-bash", "asst-tc-bash", "tc-bash", `bash${OSC52}`),
		assistantMessage("asst-tc-custom", "tr-bash", [
			{ type: "toolCall", id: "tc-custom", name: `my${OSC52}tool`, arguments: { q: "x" } },
		]),
		toolResult("tr-custom", "asst-tc-custom", "tc-custom", "my-tool"),
		toolResult("tr-orphan", "tr-custom", "missing-call", `weird${CLEAR}name`),
		bashExecution("bash-1", "tr-orphan", `echo hi${CLEAR}\u0007`),
		{
			type: "custom_message",
			...entryBase("cm-1", "bash-1"),
			customType: `agent${OSC52}message`,
			content: `报告${HYPERLINK}完成\r`,
			display: true,
		},
		{ type: "custom", ...entryBase("custom-1", "cm-1"), customType: `duty${CLEAR}event` },
		{
			type: "model_change",
			...entryBase("model-1", "custom-1"),
			provider: "bailian",
			modelId: `glm-5.3${OSC52}`,
		},
		{
			type: "thinking_level_change",
			...entryBase("thinking-1", "model-1"),
			thinkingLevel: `high${CLEAR}\u0007`,
		},
		{
			type: "service_tier_change",
			...entryBase("tier-1", "thinking-1"),
			// The field is a closed union in today's schema; a session file an older
			// or hostile writer left behind carries whatever bytes it likes.
			serviceTier: `priority${OSC52}` as ServiceTier,
		},
		{ type: "label", ...entryBase("label-1", "tier-1"), targetId: "user-1", label: `交回${CLEAR}` },
		{ type: "session_info", ...entryBase("info-1", "label-1"), name: `lane C${OSC52}: 交回\r` },
		{
			type: "branch_summary",
			...entryBase("branch-1", "info-1"),
			fromId: "user-1",
			summary: `from branch${CLEAR}`,
		},
	];
	return { tree: buildChain(entries), leafId: "branch-1", visibleRows: entries.length - 2 };
}

describe("tree selector sanitization", () => {
	test("renders every dirty entry as one clean row", () => {
		const { tree, leafId, visibleRows } = dirtyTree();
		const selector = new TreeSelectorComponent(
			tree,
			leafId,
			100,
			() => {},
			() => {},
			undefined,
			undefined,
			"all",
		);
		const list = selector.getTreeList();

		const narrow = list.render(80);
		expectRenderClean(narrow);
		// One physical row per visible entry, plus the counter footer.
		expect(narrow).toHaveLength(visibleRows + 1);

		const plain = expectRenderClean(list.render(200));
		for (const fragment of [
			"你：你好 worker",
			"AI：done report",
			"AI：rate limited",
			"[bash: git status && ls]",
			"[mytool:",
			"[weirdname]",
			"[bash]: echo hi",
			"[agentmessage]: 报告完成",
			"[custom: dutyevent]",
			"[model: glm-5.3]",
			"[thinking: high]",
			"[service tier: priority]",
			"[label: 交回]",
			"[title: lane C: 交回]",
			"[branch summary]: from branch",
		]) {
			expect(plain).toContain(fragment);
		}
	});

	test("renders a dirty node label without its escape sequences", () => {
		const { tree, leafId } = dirtyTree();
		const selector = new TreeSelectorComponent(
			tree,
			leafId,
			100,
			() => {},
			() => {},
			undefined,
			undefined,
			"all",
		);
		const list = selector.getTreeList();
		list.updateNodeLabel("user-1", `审查${OSC52}通过\r`);

		const plain = expectRenderClean(list.render(200));
		expect(plain).toContain("[审查通过]");
		expectRenderClean(list.render(80));
	});
});
