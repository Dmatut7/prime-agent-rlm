import type { Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextTreeNode } from "../src/core/context-tree.js";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The fullscreen top bar and the sub-agent spend cell read their figures from one
 * disk-scanning RPC (`getContextTree`). These pins cover the sharing contract:
 * one turn-end beat costs one scan for both consumers, the emergency switch
 * (`ui.subagentSpendCell: false`) stops the scan on both surfaces (the header
 * degrades to the session's own in-memory usage total), a settled scan answers
 * the header for one cadence window, and a forced turn-end refresh still scans
 * for real when all the header holds is an older windowed result.
 *
 * The harness follows the established partial-mode pattern
 * (test/subagent-summary-line.test.ts createSpendMode): Object.create on the
 * prototype, only the connection/settings stand-ins, real method bodies.
 */

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

/** Root carries the branch total (own + child), like a real tree does. */
function branchTree(rootOwn: Usage, branchTotal: Usage, children: ContextTreeNode[] = []): ContextTreeNode {
	return {
		id: "root",
		label: "main agent",
		status: "active",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		ownUsage: rootOwn,
		totalUsage: branchTotal,
		children,
	};
}

function child(id: string, own: Usage, model: { provider: string; id: string }): ContextTreeNode {
	return { id, label: id, status: "done", model, ownUsage: own, totalUsage: own, children: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Flush pending microtasks (scans land, publishers run) without moving the clock. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

type HarnessOptions = {
	getContextTree?: () => Promise<ContextTreeNode>;
	/** `SessionStats.cost` behind the degraded header figure. */
	ownCost?: number;
	spendCellEnabled?: boolean;
	/** subagentCounts.total: 0 keeps the spend cell off screen (header scans alone). */
	family?: number;
	sessionId?: string;
	priceOverrides?: Record<string, { input?: number; output?: number }>;
};

function createThrottleMode(options: HarnessOptions = {}) {
	const state = { enabled: options.spendCellEnabled ?? true };
	const getContextTree = vi.fn(
		options.getContextTree ?? (async () => branchTree(usage(100, 50, 0.05), usage(100, 50, 0.05))),
	);
	const getSessionStats = vi.fn(async () => ({ cost: options.ownCost ?? 0 }));
	const setSubagentSpend = vi.fn();
	const connectionState = { sessionId: options.sessionId ?? "session-1" };
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		connectionState,
		agentConnection: { getContextTree, getSessionStats },
		terminalSuspended: false,
		subagentCounts: { total: options.family ?? 0, running: options.family ?? 0, idle: 0, inactive: 0 },
		subagentSummaryLine: { setSubagentSpend },
		// The idle tick is a real interval; these pins drive the event paths, so the
		// tick arm/disarm is stubbed (same isolation as createSpendMode's stubIdleTick).
		startSubagentSpendIdleTick: vi.fn(),
		stopSubagentSpendIdleTick: vi.fn(),
		uiServices: {
			settingsManager: {
				getSubagentSpendCellEnabled: () => state.enabled,
				getSubagentSpendCellIntervalMs: () => 15_000,
				getSubagentSpendCellPriceOverrides: () => options.priceOverrides ?? {},
			},
			modelRegistry: { find: vi.fn(() => undefined) },
		},
		ui: { requestRender: vi.fn() },
	});
	const call =
		(name: string) =>
		(...args: unknown[]) =>
			(Reflect.get(InteractiveMode.prototype, name) as (...a: unknown[]) => unknown).call(mode, ...args);
	return {
		mode,
		state,
		connectionState,
		getContextTree,
		getSessionStats,
		setSubagentSpend,
		refreshTopBarCost: () => call("refreshTopBarCost")(),
		scheduleSpend: (force = false) => call("scheduleSubagentSpendRefresh")(force),
		topBarCost: () => Reflect.get(mode, "topBarCost") as { sessionId?: string; total?: number },
	};
}

/**
 * A mode built through the prototype and nothing else: the constructor never runs, so
 * `uiServices` - and the settings surface the emergency switch is read from - is absent.
 * That is exactly what the resync regression harnesses look like, and the refresh called
 * from `renderResyncedSession` has to survive it: the figure on screen is cosmetic, the
 * TypeError it threw there was not (it aborted the render path a reconnect runs).
 */
function createUiservicelessMode() {
	const getContextTree = vi.fn(async () => branchTree(usage(100, 50, 0.05), usage(100, 50, 0.05)));
	const requestRender = vi.fn();
	const published = { sessionId: "session-1", total: 1.25 };
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		connectionState: { sessionId: "session-1" },
		agentConnection: { getContextTree, getSessionStats: vi.fn(async () => ({ cost: 0 })) },
		// The figure a real session's header already holds, and the refresh bookkeeping
		// that goes with it: both must come back untouched.
		topBarCost: published,
		topBarCostRefresh: { generation: 3, lastSuccessGeneration: 3 },
		ui: { requestRender },
	});
	return {
		mode,
		getContextTree,
		requestRender,
		published,
		topBarCost: () => Reflect.get(mode, "topBarCost"),
		refreshTopBarCost: () => (Reflect.get(InteractiveMode.prototype, "refreshTopBarCost") as () => void).call(mode),
	};
}

describe("top bar cost refresh sharing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("pays one context-tree scan for a whole turn-end beat, and both figures read that scan", async () => {
		vi.useFakeTimers();
		try {
			// root recorded 0.5, child kimi-k3 recorded 1.2, branch total 1.7.
			const tree = branchTree(usage(1_000, 500, 0.5), usage(3_000, 1_500, 1.7), [
				child("sub-1", usage(2_000, 1_000, 1.2), { provider: "bailian", id: "kimi-k3" }),
			]);
			const scan = deferred<ContextTreeNode>();
			const h = createThrottleMode({ family: 1, getContextTree: () => scan.promise });

			// The beat: session_status (header), agent_end (header), the cell's forced
			// refresh - three triggers while the first scan is still in flight.
			h.refreshTopBarCost();
			h.refreshTopBarCost();
			h.scheduleSpend(true);
			await vi.advanceTimersByTimeAsync(0); // fires the forced timer mid-scan
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			scan.resolve(tree);
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			// Same scan, both figures: the header reads the branch total, the cell the
			// children's money - priced from the same tree object.
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 1.7 });
			expect(h.setSubagentSpend).toHaveBeenCalled();
			const figure = h.setSubagentSpend.mock.calls.at(-1)?.[0] as { cost: number; parentCost: number };
			expect(figure.cost).toBe(1.2);
			expect(figure.parentCost).toBe(0.5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still costs one scan when the header's scan has already landed before the forced cell refresh fires", async () => {
		vi.useFakeTimers();
		try {
			// Fast-RPC ordering: the header's scan settles in the same millisecond the
			// turn-end refresh is armed, so the cell reuses the landed result
			// (share.at >= notBefore) instead of starting a twin scan.
			const h = createThrottleMode({ family: 1 });
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			h.scheduleSpend(true);
			await vi.advanceTimersByTimeAsync(0);
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);
			expect(h.setSubagentSpend).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("the forced turn-end refresh scans for real when the header only holds a windowed result", async () => {
		vi.useFakeTimers();
		try {
			// Forced semantics must not be eaten by the sharing window: a turn end needs
			// the numbers the turn settled, so a result from before the request does
			// not answer it.
			const h = createThrottleMode({ family: 1 });
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1_000); // inside the 5s window
			h.refreshTopBarCost(); // header itself reuses, no scan
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			h.scheduleSpend(true);
			await vi.advanceTimersByTimeAsync(0);
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("scans for the header alone when there is no family, and throttles an event burst to one scan per window", async () => {
		vi.useFakeTimers();
		try {
			// No family: the cell is off screen and never scans; the header must still
			// get its own figure (a missing family is not the emergency switch).
			const h = createThrottleMode({ family: 0 });
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.05 });

			// A session_status / session_info_changed burst inside the window: no rescan.
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(200); // t = 1000
				h.refreshTopBarCost();
				await flush();
			}
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			// Past the light window (SUBAGENT_SPEND_MIN_INTERVAL_MS): the next event scans.
			await vi.advanceTimersByTimeAsync(4_100); // t = 5100
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("widens the sharing window after a heavy scan, like the spend cell's cadence does", async () => {
		vi.useFakeTimers();
		try {
			const h = createThrottleMode({ family: 0 });
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);

			// A heavy (>100ms) scan: deferred past 200ms of fake time.
			await vi.advanceTimersByTimeAsync(5_100); // t = 5100, window lapsed
			const heavy = deferred<ContextTreeNode>();
			h.getContextTree.mockImplementation(() => heavy.promise);
			h.refreshTopBarCost();
			expect(h.getContextTree).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(200); // t = 5300, scan lands here
			heavy.resolve(branchTree(usage(100, 50, 0.06), usage(100, 50, 0.06)));
			await flush();
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.06 });

			// The window is now the heavy interval (15s): 6s later is inside it.
			await vi.advanceTimersByTimeAsync(6_000); // t = 11300
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(2);

			// 16s past the heavy scan's landing: outside the widened window.
			await vi.advanceTimersByTimeAsync(10_000); // t = 21300
			h.getContextTree.mockImplementation(async () => branchTree(usage(100, 50, 0.07), usage(100, 50, 0.07)));
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(3);
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.07 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the tree scan on both surfaces while the emergency switch is off, and the header degrades to the session's own spend", async () => {
		vi.useFakeTimers();
		try {
			const h = createThrottleMode({ family: 1, spendCellEnabled: false, ownCost: 0.42 });
			h.refreshTopBarCost();
			h.refreshTopBarCost();
			h.scheduleSpend(true);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(h.getContextTree).not.toHaveBeenCalled();
			// The header is not blank while the tree is off: it reads the session's own
			// in-memory usage total (no per-model correction exists for it).
			expect(h.getSessionStats).toHaveBeenCalled();
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.42 });
			expect(h.setSubagentSpend).toHaveBeenCalledWith(undefined);

			// The switch flipped back on: the very next header event scans the tree again.
			h.state.enabled = true;
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(1);
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.05 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the corrected branch total with the tree on, the uncorrected own spend with it off, and clamps a negative degraded read at zero", async () => {
		// Same tree, same override: the difference between the two figures is pinned,
		// not incidental. Tree path: recorded 1.01 + (7 - 1) = 7.01.
		const tree = branchTree(usage(900, 100, 0.01), usage(1_000_900, 100, 1.01), [
			child("sub-1", usage(1_000_000, 0, 1), { provider: "bailian", id: "kimi-k3" }),
		]);
		const priceOverrides = { "bailian/kimi-k3": { input: 7 } };

		const on = createThrottleMode({ family: 1, priceOverrides, getContextTree: async () => tree });
		on.refreshTopBarCost();
		await flush();
		expect(on.topBarCost()).toEqual({ sessionId: "session-1", total: 7.01 });

		const off = createThrottleMode({ family: 1, spendCellEnabled: false, ownCost: 0.25, priceOverrides });
		off.refreshTopBarCost();
		await flush();
		expect(off.topBarCost()).toEqual({ sessionId: "session-1", total: 0.25 });

		// Money on screen clamps at zero on the degraded path too (same funnel as the
		// tree path's attribution-gap clamp).
		const negative = createThrottleMode({ family: 1, spendCellEnabled: false, ownCost: -3 });
		negative.refreshTopBarCost();
		await flush();
		expect(negative.topBarCost()).toEqual({ sessionId: "session-1", total: 0 });
	});

	it("keeps the header's figure out of the next session: a rebind rescans, and a scan that lands late is discarded", async () => {
		const h = createThrottleMode({ family: 0 });
		h.refreshTopBarCost();
		await flush();
		expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.05 });

		// Rebind while a scan for the old session is in flight: the memo is keyed to
		// the session, so the new session scans for itself.
		const stale = deferred<ContextTreeNode>();
		h.getContextTree.mockImplementation(() => stale.promise);
		h.connectionState.sessionId = "session-2";
		h.refreshTopBarCost();
		expect(h.getContextTree).toHaveBeenCalledTimes(2);

		const fresh = deferred<ContextTreeNode>();
		h.getContextTree.mockImplementation(() => fresh.promise);
		h.connectionState.sessionId = "session-3";
		h.refreshTopBarCost();
		expect(h.getContextTree).toHaveBeenCalledTimes(3);
		fresh.resolve(branchTree(usage(1, 1, 3.3), usage(1, 1, 3.3)));
		await flush();
		expect(h.topBarCost()).toEqual({ sessionId: "session-3", total: 3.3 });

		// The session-2 scan landing now must not overwrite the session-3 figure.
		stale.resolve(branchTree(usage(1, 1, 2.2), usage(1, 1, 2.2)));
		await flush();
		expect(h.topBarCost()).toEqual({ sessionId: "session-3", total: 3.3 });
	});

	it("keeps the last good figure when a scan fails, and retries on the next refresh", async () => {
		vi.useFakeTimers();
		try {
			const h = createThrottleMode({ family: 0 });
			h.refreshTopBarCost();
			await flush();
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.05 });

			await vi.advanceTimersByTimeAsync(6_000); // outside the window
			h.getContextTree.mockImplementation(async () => {
				throw new Error("scan blew up");
			});
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(2);
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.05 });

			// A failed scan is not memoized: the next event retries immediately.
			h.getContextTree.mockImplementation(async () => branchTree(usage(1, 1, 0.09), usage(1, 1, 0.09)));
			h.refreshTopBarCost();
			await flush();
			expect(h.getContextTree).toHaveBeenCalledTimes(3);
			expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 0.09 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("arms no timer of its own: the sharing is a timestamp memo, not a scheduled handle", async () => {
		vi.useFakeTimers();
		try {
			const off = createThrottleMode({ family: 0, spendCellEnabled: false, ownCost: 0.1 });
			off.refreshTopBarCost();
			await flush();
			const on = createThrottleMode({ family: 0 });
			on.refreshTopBarCost();
			on.refreshTopBarCost();
			await flush();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes a figure the real TopBar renders", async () => {
		const tree = branchTree(usage(900, 100, 0.01), usage(1_000_900, 100, 1.01), [
			child("sub-1", usage(1_000_000, 0, 1), { provider: "bailian", id: "kimi-k3" }),
		]);
		const h = createThrottleMode({ family: 1, getContextTree: async () => tree });
		h.refreshTopBarCost();
		await flush();
		expect(h.topBarCost()).toEqual({ sessionId: "session-1", total: 1.01 });

		// The wiring the constructor installs, replayed against the harness: a figure
		// keyed to another session renders as nothing.
		const bar = new TopBar({
			getChatName: () => "demo",
			getCostUsd: () => {
				const cost = h.topBarCost();
				return cost.sessionId === h.connectionState.sessionId ? cost.total : undefined;
			},
		});
		expect(stripAnsi(bar.render(21)[0] ?? "")).toContain("$1.01");
	});

	it("a harness with no uiServices keeps the figure it holds instead of throwing", async () => {
		// The negative control for the emergency-switch wiring: the switch is read through
		// `this.uiServices`, and a partial harness has none. `renderResyncedSession` runs
		// this refresh on a reconnect, so the missing surface used to surface as a
		// TypeError inside a rendering path (4509's resync case is the behavioural half of
		// this pin; this is the focused one, on the method itself).
		const h = createUiservicelessMode();
		expect(() => h.refreshTopBarCost()).not.toThrow();
		await flush();
		// The header keeps the figure it already had - neither blanked nor replaced...
		expect(h.topBarCost()).toBe(h.published);
		// ... and neither reading costs anything: no context-tree scan was asked for, and
		// the frame was not invalidated to show a figure nobody produced.
		expect(h.getContextTree).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
	});
});
