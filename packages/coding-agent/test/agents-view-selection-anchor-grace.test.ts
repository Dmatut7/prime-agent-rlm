import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { buildUnifiedSessionIndex } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "fallback",
		activeSessionId: "fallback-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "fallback-session",
		sessionFile: "/tmp/fallback.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

/**
 * The view restored a selection whose row has not streamed in yet, and a saved
 * catalog refresh is in flight. This is the state in which Enter used to be
 * refused for the refresh's whole duration — seconds on a large catalog.
 */
function pendingSelf(options: { pendingForMs: number; refreshInFlight: boolean }) {
	const rowSummary = summary();
	const self: Record<string, unknown> = {
		rows: [
			{
				kind: "agent",
				section: "idle",
				summary: rowSummary,
				title: "fallback",
				subtitle: "",
				statusLabel: "",
				depth: 0,
				selectable: true,
				runningSubagentCount: 0,
				recursiveCost: 0,
				descendantCount: 0,
				identity: "file:/tmp/fallback.jsonl",
			},
		],
		selectedIndex: 0,
		selectionAnchorPending: true,
		selectionAnchorPendingSince: Date.now() - options.pendingForMs,
		savedCatalogRefreshPending: options.refreshInFlight,
		selectedActiveSessionId: undefined,
		unifiedRecords: [],
		unifiedIndex: buildUnifiedSessionIndex([]),
		isPendingDeleteRow: () => false,
		setStatusMessage: vi.fn(),
		finish: vi.fn(),
	};
	self.selectionAnchorGraceExpired = () => invoke("selectionAnchorGraceExpired", self);
	self.resolveMissingSelectionAnchor = () => invoke("resolveMissingSelectionAnchor", self);
	return self;
}

describe("agents view selection anchor grace", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));

	it("keeps waiting for a refresh that is still inside the grace window", () => {
		const self = pendingSelf({ pendingForMs: 100, refreshInFlight: true });
		invoke("resolveMissingSelectionAnchor", self);
		expect(self.selectionAnchorPending).toBe(true);
		expect(self.selectedActiveSessionId).toBeUndefined();
	});

	it("stops letting an in-flight refresh hold the selection past the grace window", () => {
		const self = pendingSelf({ pendingForMs: 60_000, refreshInFlight: true });
		invoke("resolveMissingSelectionAnchor", self);
		expect(self.selectionAnchorPending).toBe(false);
		expect(self.selectionAnchorPendingSince).toBe(0);
		expect(self.selectedActiveSessionId).toBe("fallback-active");
	});

	it("resolves immediately once no refresh is in flight", () => {
		const self = pendingSelf({ pendingForMs: 0, refreshInFlight: false });
		invoke("resolveMissingSelectionAnchor", self);
		expect(self.selectionAnchorPending).toBe(false);
		expect(self.selectedActiveSessionId).toBe("fallback-active");
	});

	it("opens the visible row on Enter once the grace window has passed", () => {
		const self = pendingSelf({ pendingForMs: 60_000, refreshInFlight: true });
		invoke("openSelected", self);
		// The grace expiry is what unblocks the key: openSelected re-checks the
		// anchor rather than leaving Enter a dead end for the whole RPC.
		expect(self.setStatusMessage).not.toHaveBeenCalled();
		expect(self.finish).toHaveBeenCalledOnce();
		expect((self.finish as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
			type: "open",
			summary: expect.objectContaining({ activeSessionId: "fallback-active" }),
			hasChildren: false,
		});
	});

	it("still refuses Enter while the anchor is genuinely on its way", () => {
		const self = pendingSelf({ pendingForMs: 10, refreshInFlight: true });
		invoke("openSelected", self);
		expect(self.finish).not.toHaveBeenCalled();
		expect(self.setStatusMessage).toHaveBeenCalledWith("Waiting for the selected session to load");
	});

	it("re-arms the wait on every reconcile that still cannot find the anchor", () => {
		// This is what bounds the guarantee above: a catalog that is actively
		// streaming re-stamps the wait each time it reconciles (throttled to 50 ms),
		// so the grace window only expires once the stream stops making progress.
		// Enter can therefore still wait out a slow-but-moving refresh, up to that
		// RPC's own timeout, rather than being released two seconds into it.
		const stale = Date.now() - 60_000;
		const self: Record<string, unknown> = {
			rows: pendingSelf({ pendingForMs: 0, refreshInFlight: true }).rows,
			selectedIndex: 0,
			selectedRowIdentity: "file:/tmp/never-streamed-in.jsonl",
			selectedSessionKey: undefined,
			selectedActiveSessionId: undefined,
			persistentState: {},
			selectionAnchorPending: true,
			selectionAnchorPendingSince: stale,
		};
		invoke("restoreSelection", self);
		expect(self.selectionAnchorPending).toBe(true);
		expect(self.selectionAnchorPendingSince as number).toBeGreaterThan(stale);
		expect(Date.now() - (self.selectionAnchorPendingSince as number)).toBeLessThan(1000);
	});
});
