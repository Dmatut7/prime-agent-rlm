import type { Usage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { isDirectAgentChild } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import {
	countDirectSubagentStatuses,
	countRosterSubagentStatuses,
	type SubagentSpendSummary,
	SubagentSummaryLine,
	summarizeSubagentSpend,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

describe("SubagentSummaryLine", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders nothing without children and a bordered agents tile with counts otherwise", () => {
		const line = new SubagentSummaryLine();
		expect(line.render(120)).toEqual([]);

		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		let rendered = line.render(120).map(stripAnsi);
		expect(rendered).toHaveLength(3);
		expect(rendered[0]).toContain("╭─ subagents ─");
		expect(rendered[1]).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		rendered = line.render(120).map(stripAnsi);
		expect(rendered[1]).toContain("● 1 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("hints ↓ select when unfocused and Enter/→ open when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);

		expect(stripAnsi(line.render(120)[1])).toContain("↓ select");

		line.focused = true;
		const focused = stripAnsi(line.render(120)[1]);
		expect(focused).toContain("open");
		expect(focused).not.toContain("↓ select");
	});

	it("keeps the selection background across truncation resets when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		line.focused = true;
		// Narrow enough that the colored counts truncate and inject a full reset.
		const content = line.render(20)[1];
		expect(content).toContain("\x1b[0m");
		for (const segment of content.split("\x1b[0m").slice(1, -1)) {
			expect(segment.startsWith("\x1b[4") || segment.startsWith("\x1b[10")).toBe(true);
		}
	});

	it("never emits lines wider than the allocated width", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		for (const width of [120, 40, 24, 12, 6, 3, 2, 1]) {
			for (const rendered of line.render(width).map(stripAnsi)) {
				expect(rendered.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("counts only direct children using running, idle, and inactive status projections", () => {
		const children = [
			child("running", "running"),
			child("queued", "queued"),
			child("active", "done", { activity: { kind: "writing" } }),
			child("heartbeat", "done", { activeSessionId: "heartbeat-session" }),
			child("idle-done", "done", { activeSessionId: "idle-done-session" }),
			child("idle-error", "error", { activeSessionId: "idle-error-session" }),
			child("inactive-done", "done"),
			child("inactive-error", "error"),
			child("cancelled", "cancelled"),
			child("grandchild", "running", { parentId: "running" }),
		];

		expect(countDirectSubagentStatuses(children, undefined)).toEqual({
			total: 8,
			running: 3,
			idle: 3,
			inactive: 2,
		});
	});

	it("opens on Enter or Right only when the daemon-backed line is selectable", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 2, running: 0, idle: 2, inactive: 0 });
		line.setOpenable(true);

		line.handleInput("\r");
		line.handleInput("\x1b[C");

		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("stays visible but non-selectable for an in-process connection", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setOpenable(false);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
		expect(line.isSelectable()).toBe(false);
		line.handleInput("\r");
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("updates the rendered counts from consecutive child-status events", () => {
		const line = new SubagentSummaryLine();
		line.setOpenable(true);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running"));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "active-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("counts a retained completed child as running while a follow-up turn is active", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker", activity: { kind: "waiting" } }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("refreshes counts when startup seeding follows an early live child update", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const worker = child("worker", "done", { parentId: "me" });
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
			this: typeof mode,
			children: readonly AgentConnectionRlmChildAgentSnapshot[],
		) => void;

		update.call(mode, worker);
		expect(line.render(100)).toEqual([]);
		Reflect.set(mode, "rlmNodeId", "me");
		seed.call(mode, [worker]);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("╭─ subagents ─");
	});

	it("clears a resident session id when a terminal update reports an evicted child", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		// Active partial updates retain the last known resident id.
		update.call(mode, child("worker", "running"));
		update.call(mode, child("worker", "done"));

		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
	});

	it("removes a run on the producer's cancelled signal and keeps transcript-backed rows through repeated dones", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const snapshots = Reflect.get(mode, "subagentSnapshots") as Map<string, AgentConnectionRlmChildAgentSnapshot>;

		// A pre-bind failure arrives as cancelled: the queued row goes, never an inactive phantom.
		update.call(mode, child("never-bound", "queued"));
		update.call(mode, child("never-bound", "cancelled", { error: "boom" }));
		expect(snapshots.has("never-bound")).toBe(false);

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		update.call(mode, child("worker", "done"));
		update.call(mode, child("worker", "done"));
		expect(snapshots.has("worker")).toBe(true);
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
	});

	it("counts parentSessionId-only roster children exactly like the agents view", () => {
		const rosterChild = {
			id: "c1",
			sessionId: "c1",
			lifecycle: "live",
			runtimeKind: "subagent",
			rlmChildId: "c1",
			parentSessionId: "root-session",
			rosterStatus: "idle",
		} as SessionSummary;
		expect(isDirectAgentChild(rosterChild, { sessionId: "root-session" })).toBe(true);
		expect(countRosterSubagentStatuses([rosterChild], { sessionId: "root-session" })).toEqual({
			total: 1,
			running: 0,
			idle: 1,
			inactive: 0,
		});
	});

	it("keeps chat alive with the snapshot-fed bar when the roster subscribe fails", async () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			agentConnection: {
				subscribeAgentRoster: vi.fn(async () => {
					throw new Error("Daemon is stale");
				}),
			},
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			connectionState: undefined,
			scheduleHeartbeatManagerRefresh: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToRosterBar") as (
			this: typeof mode,
		) => Promise<void>;

		await expect(subscribe.call(mode)).resolves.toBeUndefined();
		expect(Reflect.get(mode, "rosterBar")).toBeUndefined();
	});

	it("turns a selection into the scoped agents-view run result", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			editor: { getText: () => "" },
			options: { returnToAgentsView: true },
			returnToAgentsView,
		});
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);
		line.onOpen = () => void open.call(mode);

		line.handleInput("\r");
		await vi.waitFor(() => expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view"));
	});
});

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function tree(
	root: Usage,
	children: ContextTreeNode[],
	model: { provider: string; id: string } | undefined = { provider: "bailian", id: "deepseek-v4.1-flash" },
): ContextTreeNode {
	return { id: "root", label: "main agent", status: "active", model, ownUsage: root, totalUsage: root, children };
}

function agent(id: string, own: Usage, model: { provider: string; id: string } | undefined): ContextTreeNode {
	return { id, label: id, status: "done", model, ownUsage: own, totalUsage: own, children: [] };
}

function spend(summary: Partial<SubagentSpendSummary>): SubagentSpendSummary {
	return {
		cost: 0,
		tokens: 0,
		parentCost: 0,
		unpriced: [],
		partial: false,
		...summary,
	};
}

describe("subagent spend cell", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const pricedEverywhere = () => true;

	it("sums own usage over the whole tree except the root, so attributions are not double-counted", () => {
		// The root's ownUsage excludes child attributions; each descendant counts
		// once at its own node, so the fold equals /usage's "Total" minus the root.
		const summary = summarizeSubagentSpend(
			tree(usage(1_000, 500, 0.5), [
				agent("sub-1", usage(2_000, 1_000, 1.2), { provider: "bailian", id: "qwen3.8-flash" }),
				agent("sub-2", usage(1_500, 750, 0.45), { provider: "bailian", id: "qwen3.8-flash" }),
			]),
			pricedEverywhere,
		);
		expect(summary.cost).toBe(1.65);
		expect(summary.tokens).toBe(5_250);
		expect(summary.parentCost).toBe(0.5);
		expect(summary.unpriced).toEqual([]);
		expect(summary.partial).toBe(false);
	});

	it("counts descendants, not just direct children", () => {
		const grandchild = agent("sub-sub", usage(500, 250, 0.3), { provider: "bailian", id: "qwen3.8-flash" });
		const child = {
			...agent("sub-1", usage(2_000, 1_000, 1.2), { provider: "bailian", id: "qwen3.8-flash" }),
			children: [grandchild],
		};
		const summary = summarizeSubagentSpend(tree(usage(1_000, 500, 0.5), [child]), pricedEverywhere);
		expect(summary.cost).toBe(1.5);
		expect(summary.tokens).toBe(3_750);
	});

	it("flags unpriced models with their tokens instead of silently summing them as free", () => {
		const summary = summarizeSubagentSpend(
			tree(usage(100, 50, 0.05), [
				agent("sub-kimi", usage(8_100_000, 100_000, 0), { provider: "bailian", id: "kimi-k3" }),
				agent("sub-qwen", usage(1_000_000, 230_000, 0.34), { provider: "bailian", id: "qwen3.8-flash" }),
			]),
			(model) => model.id !== "kimi-k3",
		);
		expect(summary.cost).toBe(0.34);
		expect(summary.tokens).toBe(9_430_000);
		expect(summary.unpriced).toEqual([{ model: "kimi-k3", tokens: 8_200_000 }]);
	});

	it("treats a node that already earned cost as priced, whatever its recorded model says", () => {
		const summary = summarizeSubagentSpend(
			tree(usage(100, 50, 0.05), [agent("sub-legacy", usage(2_000, 1_000, 1.2), undefined)]),
			() => false,
		);
		expect(summary.cost).toBe(1.2);
		expect(summary.unpriced).toEqual([]);
	});

	it("marks a budget-truncated tree as a lower bound", () => {
		const truncated = {
			...tree(usage(100, 50, 0.05), []),
			scan: {
				scannedChildren: 256,
				bytesRead: 64 * 1024 * 1024,
				bytesPlanned: 64 * 1024 * 1024,
				skippedByBudget: 42,
				depthLimitReached: false,
				truncated: true,
				truncatedReason: "children" as const,
			},
		};
		const summary = summarizeSubagentSpend(truncated, pricedEverywhere);
		expect(summary.partial).toBe(true);
	});

	it("renders the spend total in the counts row with money first and the mother total second", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));

		const body = stripAnsi(line.render(120)[1]);
		expect(body).toContain("Σ 子代理 ¥4.56 · 12M tok · 总 ¥5.10");
		expect(body).toContain("● 1 running   ◐ 1 idle");
	});

	it("keeps the cell blank for an all-zero summary and never shows ¥0.00", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 0, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({}));
		expect(stripAnsi(line.render(120)[1])).not.toContain("¥");

		// An all-unpriced family: tokens plus the warning, no ¥0.00 figure.
		line.setSubagentSpend(spend({ tokens: 8_100_000, unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] }));
		const body = stripAnsi(line.render(120)[1]);
		expect(body).toContain("Σ 子代理 8.1M tok (kimi-k3 8.1M tok 未定价)");
		expect(body).not.toContain("¥");
	});

	it("marks partial-tree figures as lower bounds and warns in the theme warning color", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setSubagentSpend(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				partial: true,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		);
		const body = stripAnsi(line.render(120)[1]);
		expect(body).toContain("Σ 子代理 ≈¥4.56 · ≈12M tok · 总 ≈¥5.10");
		const raw = line.render(120)[1];
		expect(raw).toContain(theme.fg("warning", "(kimi-k3 8.1M tok 未定价)"));
		expect(raw).toContain(theme.fg("accent", "¥4.56"));
	});

	it("degrades in a fixed order at narrow widths and never pushes the select hint out", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setSubagentSpend(
			spend({
				cost: 4.56,
				tokens: 12_300_000,
				parentCost: 0.54,
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
			}),
		);
		line.setOpenable(true);

		// 120: everything fits.
		const wide = stripAnsi(line.render(120)[1]);
		expect(wide).toContain("Σ 子代理 ¥4.56 · 12M tok · 总 ¥5.10 (kimi-k3 8.1M tok 未定价)");
		// 100: "总" is the first cut, then the annotation's token counts.
		const medium = stripAnsi(line.render(100)[1]);
		expect(medium).toContain("Σ 子代理 ¥4.56 · 12M tok");
		expect(medium).not.toContain("总 ¥");
		expect(medium).toContain("(kimi-k3 未定价)");
		expect(medium).not.toContain("8.1M");
		// 80: annotation gone, primary survives.
		const narrow = stripAnsi(line.render(80)[1]);
		expect(narrow).toContain("Σ 子代理 ¥4.56 · 12M tok");
		expect(narrow).not.toContain("未定价");
		// 60: with three count groups there is no room; the cell is dropped, never half-truncated.
		const tight = stripAnsi(line.render(60)[1]);
		expect(tight).not.toContain("Σ");
		expect(tight).toContain("↓ select");
		for (const width of [120, 100, 80, 60]) {
			const body = stripAnsi(line.render(width)[1]);
			expect(body).toContain("↓ select");
			expect(visibleWidth(line.render(width)[1])).toBeLessThanOrEqual(width);
		}
	});

	it("does not move the open hint or change the line width when figures grow", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 999_000, parentCost: 0.2 }));
		line.setOpenable(true);
		const before = stripAnsi(line.render(120)[1]);
		const beforeRaw = line.render(120)[1];

		line.setSubagentSpend(spend({ cost: 12.34, tokens: 1_020_000, parentCost: 1.2 }));
		const after = stripAnsi(line.render(120)[1]);
		const afterRaw = line.render(120)[1];

		expect(before).toContain("¥4.56");
		expect(after).toContain("¥12.34");
		// Line length is padded to the inner width and the hint is right-anchored:
		// growth only eats the blank gap between them.
		expect(before.length).toBe(after.length);
		expect(before.indexOf("↓ select")).toBe(after.indexOf("↓ select"));
		expect(visibleWidth(beforeRaw)).toBe(visibleWidth(afterRaw));
	});

	it("keeps the spend colors readable over the selection background when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		line.setSubagentSpend(spend({ cost: 4.56, tokens: 12_300_000, parentCost: 0.54 }));
		line.setOpenable(true);
		line.focused = true;

		const content = line.render(100)[1];
		expect(content).toContain(theme.fg("accent", "¥4.56"));
		expect(content).toContain(theme.fg("dim", "总 ¥5.10"));
		// The selection background wraps the whole row (also across the fg resets
		// the spend segment emits, which never clear the background).
		const selectedBg = theme.bg("selectedBg", "");
		expect(content).toContain(selectedBg.slice(0, selectedBg.indexOf("\x1b[49m")));
		expect(stripAnsi(content)).toContain("Σ 子代理 ¥4.56 · 12M tok · 总 ¥5.10");
	});

	it("refreshes the cell from the context tree when child updates arrive, and blanks it when they are gone", async () => {
		const line = new SubagentSummaryLine();
		const setSpend = vi.spyOn(line, "setSubagentSpend");
		const contextTree = tree(usage(1_000, 500, 0.5), [
			agent("sub-1", usage(2_000, 1_000, 0), { provider: "bailian", id: "kimi-k3" }),
		]);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			uiServices: {
				modelRegistry: { find: vi.fn(() => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) },
			},
			agentConnection: { getContextTree: vi.fn(async () => contextTree) },
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running"));
		await vi.waitFor(
			() => {
				expect(setSpend).toHaveBeenCalled();
			},
			{ timeout: 5_000 },
		);
		// kimi-k3 has no rates, so its tokens are flagged instead of priced.
		expect(setSpend.mock.calls.at(-1)?.[0]).toEqual({
			cost: 0,
			tokens: 3_000,
			parentCost: 0.5,
			unpriced: [{ model: "kimi-k3", tokens: 3_000 }],
			partial: false,
		});

		// A family that goes away blanks the cell rather than freezing a stale figure.
		setSpend.mockClear();
		const schedule = Reflect.get(InteractiveMode.prototype, "scheduleSubagentSpendRefresh") as (
			this: typeof mode,
			force?: boolean,
		) => void;
		Reflect.set(mode, "subagentCounts", { total: 0, running: 0, idle: 0, inactive: 0 });
		schedule.call(mode);
		expect(setSpend).toHaveBeenCalledWith(undefined);
	});
});
