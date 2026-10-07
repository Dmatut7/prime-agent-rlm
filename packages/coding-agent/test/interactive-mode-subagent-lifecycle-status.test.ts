import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The spawn/delete explanation lines: a live `rlm_child_update` names what a new
 * child is for and why one disappeared, so a row that comes and goes is never a
 * mystery. Seeding and resync paths stay silent - they replay history, not news.
 */

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

const spendCellOffUiServices = { settingsManager: { getSubagentSpendCellEnabled: () => false } };

function chatText(mode: Record<string, unknown>): string {
	const chatContainer = mode.chatContainer as Container;
	return stripAnsi(chatContainer.children.flatMap((component) => component.render(120)).join("\n"));
}

function createLifecycleMode() {
	const chatContainer = new Container();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
		rlmNodeId: "me",
		heartbeatCatalog: [],
		subagentSummaryLine: new SubagentSummaryLine(),
		chatContainer,
		uiServices: spendCellOffUiServices,
		updateWorkingPulse: vi.fn(),
		syncWorkingLoader: vi.fn(),
		updateWorkingLoaderMessage: vi.fn(),
		ui: { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } },
	});
	const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
		this: typeof mode,
		value: AgentConnectionRlmChildAgentSnapshot,
	) => void;
	const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
		this: typeof mode,
		children: readonly AgentConnectionRlmChildAgentSnapshot[],
	) => void;
	return { mode, update, seed };
}

describe("subagent lifecycle status lines", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("explains a spawn: who was dispatched and what for", () => {
		const { mode, update } = createLifecycleMode();

		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff 的正确性" }));

		const text = chatText(mode);
		expect(text).toContain("派出子代理 worker");
		expect(text).toContain("检查 diff 的正确性");
	});

	it("announces a first sight only once - later updates of the same child stay quiet", () => {
		const { mode, update } = createLifecycleMode();

		update.call(mode, child("sub-1", "queued", { sessionName: "worker", label: "检查 diff" }));
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));

		const text = chatText(mode);
		expect(text.split("派出子代理").length - 1).toBe(1);
	});

	it("does not announce a child first seen already done - nothing started just now", () => {
		const { mode, update } = createLifecycleMode();

		update.call(mode, child("sub-1", "done", { sessionName: "worker", label: "检查 diff" }));

		expect(chatText(mode)).not.toContain("派出子代理");
	});

	it("explains an orchestrator delete: the child was folded back, its record kept", () => {
		const { mode, update } = createLifecycleMode();
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));

		// The exact reason rlm-child-delete.ts stamps on rlm.delete_subagent removals.
		update.call(mode, child("sub-1", "cancelled", { error: "Deleted by parent orchestrator" }));

		const text = chatText(mode);
		expect(text).toContain("子代理 worker 已收编");
		expect(text).toContain("记录保留");
	});

	it("explains a stop that came from outside this window", () => {
		const { mode, update } = createLifecycleMode();
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));

		// The default reason of AgentSession.cancelRlmChildRun - another window stopped it.
		update.call(mode, child("sub-1", "cancelled", { error: "Cancelled by user" }));

		expect(chatText(mode)).toContain("子代理 worker 已被停止");
	});

	it("stays quiet for a locally initiated stop - the stop-all flow already summarized it", () => {
		const { mode, update } = createLifecycleMode();
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));
		// What requestStopAllSubagents records before issuing the cancellations.
		(mode as Record<string, unknown>).locallyCancelledSubagentIds = new Set(["sub-1"]);

		update.call(mode, child("sub-1", "cancelled", { error: "Cancelled by user" }));

		const text = chatText(mode);
		expect(text).not.toContain("已被停止");
		expect(text).not.toContain("已收编");
	});

	it("pairs a re-dispatch with the child it replaces", () => {
		const { mode, update } = createLifecycleMode();
		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));
		update.call(mode, child("sub-1", "cancelled", { error: "Deleted by parent orchestrator" }));

		// The successor name is minted as <name>-2 when a deleted name is re-used.
		update.call(mode, child("sub-2", "running", { sessionName: "worker-2", label: "检查 diff（重来）" }));

		const text = chatText(mode);
		expect(text).toContain("接替");
		expect(text).toContain("worker-2");
		expect(text).toContain("worker");
	});

	it("does not pair a re-dispatch once the replacement window has passed", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
			const { mode, update } = createLifecycleMode();
			update.call(mode, child("sub-1", "running", { sessionName: "worker", label: "检查 diff" }));
			update.call(mode, child("sub-1", "cancelled", { error: "Deleted by parent orchestrator" }));

			vi.setSystemTime(new Date("2026-10-03T00:02:00Z"));
			update.call(mode, child("sub-2", "running", { sessionName: "worker-2", label: "另一件事" }));

			const text = chatText(mode);
			expect(text).not.toContain("接替");
			expect(text).toContain("派出子代理 worker-2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays quiet when a cancelled child was never on screen", () => {
		const { mode, update } = createLifecycleMode();

		update.call(mode, child("sub-never-seen", "cancelled", { error: "Deleted by parent orchestrator" }));

		expect(chatText(mode)).not.toContain("收编");
		expect(chatText(mode)).not.toContain("已关闭");
	});

	it("does not announce seeded children - the startup snapshot is history, not news", () => {
		const { mode, seed } = createLifecycleMode();

		seed.call(mode, [child("sub-1", "running", { sessionName: "worker", label: "检查 diff" })]);

		expect(chatText(mode)).not.toContain("派出子代理");
	});

	it("keeps the spawn line readable when the task brief is long", () => {
		const { mode, update } = createLifecycleMode();
		const longLabel = "检查".repeat(120);

		update.call(mode, child("sub-1", "running", { sessionName: "worker", label: longLabel }));

		const text = chatText(mode);
		expect(text).toContain("派出子代理 worker");
		expect(text).not.toContain(longLabel);
	});

	it("keeps every spawn line when several children are dispatched together", () => {
		const { mode, update } = createLifecycleMode();

		update.call(mode, child("sub-1", "running", { sessionName: "worker-a", label: "第一件事" }));
		update.call(mode, child("sub-2", "running", { sessionName: "worker-b", label: "第二件事" }));
		update.call(mode, child("sub-3", "queued", { sessionName: "worker-c", label: "第三件事" }));

		const text = chatText(mode);
		expect(text).toContain("派出子代理 worker-a");
		expect(text).toContain("派出子代理 worker-b");
		expect(text).toContain("派出子代理 worker-c");
		expect(text.split("派出子代理").length - 1).toBe(3);
	});

	it("keeps every removal line when several children leave together", () => {
		const { mode, update } = createLifecycleMode();
		update.call(mode, child("sub-1", "running", { sessionName: "worker-a", label: "第一件事" }));
		update.call(mode, child("sub-2", "running", { sessionName: "worker-b", label: "第二件事" }));

		update.call(mode, child("sub-1", "cancelled", { error: "Deleted by parent orchestrator" }));
		update.call(mode, child("sub-2", "cancelled", { error: "Deleted by parent orchestrator" }));

		const text = chatText(mode);
		expect(text).toContain("子代理 worker-a 已收编");
		expect(text).toContain("子代理 worker-b 已收编");
	});

	it("reconciles settled children into the turn timelines when seeding from a snapshot", () => {
		// Attach/resync seeds the chip bar from snapshot.children; the timeline
		// entries replay creates say "running". The snapshot is the authority:
		// settled children must be pushed into the timelines (which then close
		// their lanes) instead of waiting for a report that may be queued.
		const quietUiServices = {
			settingsManager: {
				getSubagentSpendCellEnabled: () => false,
				getProcessMode: () => "quiet",
			},
		};
		const subagentUpdate = vi.fn();
		const chatContainer = new Container();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: "me",
			heartbeatCatalog: [],
			subagentSummaryLine: new SubagentSummaryLine(),
			chatContainer,
			uiServices: quietUiServices,
			liveTurnFlowStore: { subagentUpdate },
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } },
		});
		const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
			this: typeof mode,
			children: readonly AgentConnectionRlmChildAgentSnapshot[],
		) => void;

		seed.call(mode, [
			child("sub-1", "done", { sessionName: "worker-a", label: "第一件事" }),
			child("sub-2", "running", { sessionName: "worker-b", label: "第二件事" }),
			child("sub-3", "cancelled", { sessionName: "worker-c", label: "第三件事" }),
		]);

		expect(subagentUpdate).toHaveBeenCalledTimes(1);
		expect(subagentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ id: "sub-1", sessionName: "worker-a", status: "done" }),
		);
	});
});
