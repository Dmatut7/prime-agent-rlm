import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import * as state from "../src/modes/agents-view/agents-view-state.js";
import { createSearchTextMatcher } from "../src/modes/agents-view/session-view-search.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const lazySearchableText = (state as { unifiedSessionSearchableText?: (record: unknown) => string })
	.unifiedSessionSearchableText;
const hasLazyCorpus = typeof lazySearchableText === "function";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

/** Identity aliases the daemon and the view agree on (see summaryIdentityAliases). */
function identities(summary: SessionSummary): string[] {
	return [
		summary.runtimeKind === "subagent" && summary.rlmChildId ? `agent:${summary.rlmChildId}` : undefined,
		summary.sessionFile ? `file:${summary.sessionFile}` : undefined,
		`session:${summary.sessionId}`,
		summary.activeSessionId ? `active:${summary.activeSessionId}` : undefined,
		`active:${summary.id}`,
	].filter((key): key is string => key !== undefined);
}

/**
 * A saved row whose transcript excerpt counts reads: the corpus join is the whole
 * cost of the search index, so the count is the work the view did for a pass.
 */
function countingSaved(id: string, transcript = `transcript of ${id} `.repeat(200)) {
	const reads = { transcript: 0 };
	const saved = {
		id,
		path: `/tmp/artifacts/${id}.jsonl`,
		name: `saved ${id}`,
		firstMessage: `first ${id}`,
		created: new Date(Date.now() - 86_400_000),
		modified: new Date(),
		cwd: "/tmp/project",
		messageCount: 4,
		get allMessagesText() {
			reads.transcript++;
			return transcript;
		},
	} as unknown as AgentConnectionSavedSessionInfo;
	return { saved, reads };
}

function heartbeatJob(nextRunAt: string): AgentConnectionHeartbeat {
	return {
		job: {
			id: "job-1",
			status: "active",
			activeSessionId: "a-active",
			sessionId: "a",
			sessionFile: "/tmp/a.jsonl",
			nextRunAt,
		},
	} as unknown as AgentConnectionHeartbeat;
}

function rowsShape(records: readonly state.UnifiedSessionRecord[]) {
	const index = state.buildUnifiedSessionIndex(records);
	const scoped = state.scopeToSessionSubtree(records, undefined, index);
	const filtered = state.filterUnifiedSessions(scoped, () => true, { skipSearchText: true });
	const rows = state.buildAgentsViewRows(
		filtered,
		new Set(),
		new Set(),
		undefined,
		state.computeRecursiveRollups(records, index),
	);
	return rows.map((row) => ({
		identity: row.identity,
		kind: row.kind,
		section: row.section,
		title: row.title,
		subtitle: row.subtitle,
		statusLabel: row.statusLabel,
		depth: row.depth,
		parentIdentity: row.parentIdentity,
		descendantCount: row.descendantCount,
		sessionId: row.summary.sessionId,
	}));
}

function recordsShape(records: readonly state.UnifiedSessionRecord[]) {
	return records.map((record) => ({
		identity: record.identity,
		section: record.section,
		identityAliases: [...record.identityAliases].sort(),
		daemon: record.daemon ? { ...record.daemon } : undefined,
		saved: record.saved?.id,
		heartbeat: record.heartbeat,
		corpus: hasLazyCorpus ? lazySearchableText!(record) : record.searchableText,
	}));
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

describe("roster-driven catalog rebuilds", () => {
	/**
	 * The real rebuild path with a hand-built `this`: the point is to count
	 * rebuilds (one render each) and reused records across a burst of roster
	 * frames, so the rebuild itself must run rather than be stubbed.
	 */
	type Harness = {
		ui: { requestRender: ReturnType<typeof vi.fn> };
		unifiedRecords: state.UnifiedSessionRecord[];
		lastCatalogReconcileAt: number;
	} & Record<string, unknown>;

	function harness(summaries: SessionSummary[]): Harness {
		const self: Record<string, unknown> = {
			stopped: false,
			rosterStore: { summaries: () => summaries },
			persistentState: {},
			lastListedSummaries: [],
			inactiveAgentIdentities: new Set<string>(),
			savedSessions: [],
			lastSuccessfulSavedSessions: [],
			heartbeats: [],
			expandedSubagentParents: new Set<string>(),
			programShownParents: new Set<string>(),
			savedCatalogReady: true,
			scopeKey: undefined,
			scopeRootSummary: undefined,
			unifiedRecords: [],
			unifiedIndex: state.buildUnifiedSessionIndex([]),
			scopedRecords: [],
			rows: [],
			selectedIndex: 0,
			selectedRowIdentity: undefined,
			selectedSessionKey: undefined,
			anchorSessionId: undefined,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			renameTarget: undefined,
			actionModeSearchQuery: undefined,
			catalogReconcileTimer: undefined,
			catalogReconcileDirty: false,
			lastCatalogReconcileAt: 0,
			pendingCatalogDirty: true as Set<string> | true,
			reconcileBase: undefined,
			ui: { requestRender: vi.fn() },
			editor: { getText: () => "" },
		};
		for (const method of [
			"markCatalogFullRebuild",
			"takeCatalogReconcileScope",
			"reconcileCatalogs",
			"scheduleCatalogReconcile",
			"applySessionList",
			"withPendingDeleteSession",
			"getFilteredRecords",
			"applyPendingAncestorExpansion",
			"restoreSelection",
			"syncSelectedRowState",
			"rebuildRows",
			"setStatusMessage",
			"resolveMissingSelectionAnchor",
		]) {
			self[method] = (...args: unknown[]) => invoke(method, self, ...args);
		}
		return self as Harness;
	}

	it("coalesces a burst of roster frames and rebuilds only the row they touched", () => {
		vi.useFakeTimers();
		const summaries = Array.from({ length: 40 }, (_, index) =>
			summary({ id: `active-${index}`, sessionId: `session-${index}` }),
		);
		const self = harness(summaries);
		const frame = () => ({
			changedSessionIds: new Set(identities(summaries[5]!)),
			fullResync: false,
		});

		invoke("onRosterUpdate", self, frame());
		expect(self.ui.requestRender).toHaveBeenCalledTimes(1);
		const afterFirst = self.unifiedRecords as state.UnifiedSessionRecord[];

		// A streaming session pushes one frame per event. Each one used to rebuild
		// every row of the catalog.
		for (let event = 0; event < 39; event++) {
			summaries[5] = { ...summaries[5]!, messageCount: summaries[5]!.messageCount + 1 };
			invoke("onRosterUpdate", self, frame());
		}
		expect({ rebuildsDuringBurst: self.ui.requestRender.mock.calls.length }).toEqual({ rebuildsDuringBurst: 1 });
		vi.advanceTimersByTime(50);
		expect({ rebuildsAfterWindow: self.ui.requestRender.mock.calls.length }).toEqual({ rebuildsAfterWindow: 2 });
		const rebuilt = self.unifiedRecords as state.UnifiedSessionRecord[];
		expect({
			reusedRows: rebuilt.filter((record) => afterFirst.includes(record)).length,
			totalRows: rebuilt.length,
		}).toEqual({ reusedRows: 39, totalRows: 40 });
		expect(rebuilt[5]?.daemon?.messageCount).toBe(40);
	});

	it("rebuilds immediately once the coalescing window has elapsed", () => {
		vi.useFakeTimers();
		const summaries = [summary({ id: "active-0", sessionId: "session-0" })];
		const self = harness(summaries);
		const frame = { changedSessionIds: new Set(identities(summaries[0]!)), fullResync: false };
		invoke("onRosterUpdate", self, frame);
		expect(self.ui.requestRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60);
		summaries[0] = { ...summaries[0]!, messageCount: 2 };
		invoke("onRosterUpdate", self, frame);
		expect(self.ui.requestRender).toHaveBeenCalledTimes(2);
	});
});

describe("incremental catalog reconcile", () => {
	const daemon = [
		summary({ id: "a-active", sessionId: "a", sessionFile: "/tmp/a.jsonl", sessionName: "alpha" }),
		summary({
			id: "b-active",
			sessionId: "b",
			sessionFile: "/tmp/b.jsonl",
			sessionName: "bravo",
			activeSessionId: "b-active",
		}),
		summary({
			id: "child-active",
			sessionId: "child",
			activeSessionId: "child-active",
			sessionFile: "/tmp/child.jsonl",
			runtimeKind: "subagent",
			rlmChildId: "child",
			parentSessionId: "a",
			firstMessage: "sub task",
		}),
	];
	const savedSessions: AgentConnectionSavedSessionInfo[] = [
		{
			id: "saved-a",
			path: "/tmp/a.jsonl",
			name: "alpha saved",
			firstMessage: "hello",
			created: new Date(Date.now() - 1000),
			modified: new Date(),
			cwd: "/tmp/project",
			messageCount: 2,
		} as unknown as AgentConnectionSavedSessionInfo,
	];

	it("carries unchanged rows over and rebuilds only the dirty ones", () => {
		const previous = state.reconcileUnifiedSessions(daemon, savedSessions, []);
		const touched = { ...daemon[1]!, messageCount: 9 };
		const next = state.reconcileUnifiedSessions([daemon[0]!, touched, daemon[2]!], savedSessions, [], {
			previous,
			dirtySessionIds: new Set(identities(touched)),
		});
		const reused = next.filter((record) => previous.includes(record)).length;
		expect({ reused, total: next.length }).toEqual({ reused: 2, total: 3 });
		// The dirty row is a new object with the new value.
		expect(next[1]).not.toBe(previous[1]);
		expect(next[1]?.daemon?.messageCount).toBe(9);
	});

	it("rebuilds every row when the catalog's shape changed", () => {
		const previous = state.reconcileUnifiedSessions(daemon, savedSessions, []);
		const spawned = summary({
			id: "new-active",
			sessionId: "new",
			sessionFile: "/tmp/new.jsonl",
			sessionName: "charlie",
		});
		const withNewRow = state.reconcileUnifiedSessions([...daemon, spawned], savedSessions, [], {
			previous,
			dirtySessionIds: new Set(identities(spawned)),
		});
		expect(withNewRow.filter((record) => previous.includes(record))).toHaveLength(0);
		const withoutRow = state.reconcileUnifiedSessions(daemon.slice(1), savedSessions, [], {
			previous,
			dirtySessionIds: new Set(),
		});
		expect(withoutRow.filter((record) => previous.includes(record))).toHaveLength(0);
	});

	it("carries rows whose aggregated heartbeat did not move", () => {
		const previous = state.reconcileUnifiedSessions(daemon, savedSessions, [
			heartbeatJob("2026-09-15T05:00:00.000Z"),
		]);
		const next = state.reconcileUnifiedSessions(daemon, savedSessions, [heartbeatJob("2026-09-15T05:00:00.000Z")], {
			previous,
			dirtySessionIds: new Set(),
		});
		expect(next.filter((record) => previous.includes(record))).toHaveLength(3);
	});

	it("rebuilds the row whose heartbeat aggregate moved even though its own row is clean", () => {
		const before = state.reconcileUnifiedSessions(daemon, savedSessions, [heartbeatJob("2026-09-15T05:00:00.000Z")]);
		const after = state.reconcileUnifiedSessions(daemon, savedSessions, [heartbeatJob("2026-09-15T05:30:00.000Z")], {
			previous: before,
			dirtySessionIds: new Set(),
		});
		expect(after.filter((record) => before.includes(record))).toHaveLength(2);
		expect(after[0]?.heartbeat?.nextRunAt).toBe("2026-09-15T05:30:00.000Z");
	});

	it("produces the same catalog and rows as a full rebuild across catalog mutations", () => {
		type Step = { name: string; daemon: SessionSummary[]; saved: AgentConnectionSavedSessionInfo[] };
		const renamed = { ...daemon[0]!, sessionName: "alpha renamed" };
		const restarted = { ...daemon[1]!, activeSessionId: "b-restarted", messageCount: 12 };
		const childDone = {
			...daemon[2]!,
			sessionFile: undefined,
			messageCount: 30,
		};
		const secondSaved = {
			...savedSessions[0]!,
			id: "saved-b",
			path: "/tmp/b.jsonl",
			name: "bravo saved",
		} as AgentConnectionSavedSessionInfo;
		const steps: Step[] = [
			{ name: "no change", daemon, saved: savedSessions },
			{ name: "one row renamed", daemon: [renamed, daemon[1]!, daemon[2]!], saved: savedSessions },
			{ name: "one row restarted", daemon: [renamed, restarted, daemon[2]!], saved: savedSessions },
			{ name: "child row updated", daemon: [renamed, restarted, childDone], saved: savedSessions },
			{
				name: "child row removed",
				daemon: [renamed, restarted],
				saved: savedSessions,
			},
			{ name: "saved catalog grew", daemon: [renamed, restarted], saved: [savedSessions[0]!, secondSaved] },
			{ name: "saved catalog emptied", daemon: [renamed, restarted], saved: [] },
			{ name: "a new session appeared", daemon: [renamed, restarted, childDone, renamed], saved: [] },
		];

		let previous = state.reconcileUnifiedSessions(daemon, savedSessions, []);
		let previousDaemon = daemon;
		let previousSaved = savedSessions;
		for (const step of steps) {
			const dirty = new Set<string>();
			for (const row of [...previousDaemon, ...step.daemon]) for (const key of identities(row)) dirty.add(key);
			const full = state.reconcileUnifiedSessions(step.daemon, step.saved, []);
			const incremental = state.reconcileUnifiedSessions(step.daemon, step.saved, [], {
				previous: previousSaved === step.saved ? previous : undefined,
				dirtySessionIds: previousSaved === step.saved ? dirty : undefined,
			});
			expect(recordsShape(incremental), step.name).toEqual(recordsShape(full));
			expect(rowsShape(incremental), step.name).toEqual(rowsShape(full));
			previous = incremental;
			previousDaemon = step.daemon;
			previousSaved = step.saved;
		}
	});
});

describe("lazy search corpus", () => {
	it("does not build row corpora for a pass whose query cannot use them", () => {
		const { saved, reads } = countingSaved("inactive-1");
		const { saved: second, reads: secondReads } = countingSaved("inactive-2");
		const records = state.reconcileUnifiedSessions([], [saved, second], []);
		const matcher = createSearchTextMatcher("");
		const filtered = state.filterUnifiedSessions(records, matcher, { skipSearchText: !matcher.requiresText });
		expect(filtered).toHaveLength(2);
		// An empty search box cannot match on text, so reading a 64 KiB transcript
		// excerpt per row is work with no reader.
		expect({ transcriptReads: reads.transcript + secondReads.transcript }).toEqual({ transcriptReads: 0 });
	});

	it("reuses the transcript corpus across passes over the same saved snapshot", () => {
		const { saved, reads } = countingSaved("inactive-1");
		const matcher = createSearchTextMatcher("transcript");
		for (let pass = 0; pass < 3; pass++) {
			const records = state.reconcileUnifiedSessions([], [saved], []);
			state.filterUnifiedSessions(records, matcher, { skipSearchText: !matcher.requiresText });
		}
		// The excerpt is a pure function of the saved snapshot the daemon handed over,
		// so a catalog pass over an unchanged row must not re-join it.
		expect({ transcriptReads: reads.transcript }).toEqual({ transcriptReads: 1 });
	});

	it.skipIf(!hasLazyCorpus)("memoizes a row's corpus for the record's lifetime", () => {
		const { saved, reads } = countingSaved("inactive-1");
		const [record] = state.reconcileUnifiedSessions([], [saved], []);
		const first = lazySearchableText!(record!);
		const second = lazySearchableText!(record!);
		expect(second).toBe(first);
		expect({ transcriptReads: reads.transcript }).toEqual({ transcriptReads: 1 });
		expect(first).toContain("saved inactive-1");
	});
});
