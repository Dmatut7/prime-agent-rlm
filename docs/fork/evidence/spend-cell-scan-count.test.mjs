/**
 * Spend-cell idle-tick scan-count instrument (fork 线运维面 / 终审 B B4-ops-16).
 *
 * WHAT IT MEASURES
 *   How many context-tree scans the subagent spend cell asks for over a 60s window on
 *   the CURRENT tree, with vitest fake timers driving the real cadence code in
 *   `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
 *   `updateSubagentSummary` -> `refreshSubagentSummary` -> `updateSubagentSummaryLine`
 *   -> `syncSubagentSpendCell` -> `scheduleSubagentSpendRefresh` /
 *   `startSubagentSpendIdleTick` -> `refreshSubagentSpend`. The only stand-ins are the
 *   agent connection (`getContextTree` is a spy, so the disk-scanning RPC is counted
 *   instead of performed), the settings surface, and the top line.
 *
 * WHERE THE CADENCE COMES FROM (both legs are measured, and both are mutations-honest)
 *   - default leg: the settings surface answers with the real exported
 *     `DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS` (`src/core/settings-manager.ts`), the
 *     same constant the production getter returns for an unconfigured user;
 *   - fallback leg: the settings surface has no `getSubagentSpendCellIntervalMs` at
 *     all, so `SUBAGENT_SPEND_IDLE_TICK_MS` (`interactive-mode.ts`) drives the tick.
 *   Neither number is hardcoded in this file: a literal 15_000 here would make the
 *   instrument blind to a source change (measured - see REPORT.md "instrument's own
 *   false green").
 *
 * WHAT IT DOES NOT MEASURE
 *   Nothing about wall-clock cost: not the milliseconds the scans block the event loop
 *   and not the p50 of the turn that collides with a scan. Those figures in
 *   CHANGELOG.md ("660->156ms", "p50 快 3.56×") came from a one-off run whose baseline
 *   patch is not in this tree and whose artifacts (/tmp/spend-perf) are gone. Only the
 *   SCAN COUNT leg is reproducible here; the 22-per-60s baseline side is not.
 *
 * TWO LEGS, ONE FILE (`SPEND_CELL_LEG=current` default, `pre-v1` for the baseline side)
 *   `current`  runs against the tree it lives in and pins today's numbers.
 *   `pre-v1`   imports THAT tree's `interactive-mode.ts`, so it must be run in a
 *              worktree checked out at the commit before the spend-cell patch set
 *              (`git worktree add /tmp/spend-base-wt 0186a1247`). The count side of the
 *              "22->6 per 60s" claim is measurable there, with the same fixture and the
 *              same fake clock, which is what makes the pair comparable at all.
 *
 * RUN (from the repository root; the cwd matters because the vitest config carries the
 * workspace aliases `@earendil-works/pi-<pkg>` -> `packages/<pkg>/src`)
 *   npx vitest run --root . --config packages/coding-agent/vitest.config.ts \
 *     docs/fork/evidence/spend-cell-scan-count.test.mjs
 *   cd /tmp/spend-base-wt && SPEND_CELL_LEG=pre-v1 npx vitest run --root . \
 *     --config packages/coding-agent/vitest.config.ts \
 *     docs/fork/evidence/spend-cell-scan-count.test.mjs
 * Readings land in `$SPEND_CELL_READINGS ?? /tmp/spend-cell-scan-count.json`.
 *
 * NEGATIVE CONTROLS IN THIS FILE
 *   - `intervalMs: MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS` (5s) on the same scenario: the
 *     60s count must move (5 -> 13).
 *   - cell switched off: the count must be 0 and the figure must be blanked.
 *   - a family that disappears mid-window: the tick must stop and the count must freeze.
 * Mutations run against this file (scratch worktree, see REPORT.md):
 *   - `DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS` 15_000 -> 5_000: default leg goes red.
 *   - `SUBAGENT_SPEND_IDLE_TICK_MS` 15_000 -> 5_000: fallback leg goes red, default stays green.
 *   - `isSubagentSpendCellVisible()` -> `true`: the two visibility controls go red.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
const LEG = process.env.SPEND_CELL_LEG === "pre-v1" ? "pre-v1" : "current";

const { InteractiveMode } = await import("../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
// The pre-v1 tree predates the configurable cadence, so its settings module has no such
// constants and this leg never reads them: the fixture's interval is unused there.
const settingsManager =
	LEG === "pre-v1" ? undefined : await import("../../../packages/coding-agent/src/core/settings-manager.ts");
const DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS = settingsManager?.DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS;
const MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS = settingsManager?.MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS;

/**
 * Measured on 2026-09-18 with this file, one row per leg. `tick` says whether the tree
 * under test has the idle tick at all: the pre-v1 tree scans from events alone, so the
 * tick scenarios are skipped there instead of being asserted against a cadence that
 * does not exist.
 */
const LEGS = {
	current: { tick: true, quiet: 5, busy: 5, turnEnd: 6, tick5s: 13, gone: 2 },
	"pre-v1": { tick: false, quiet: 1, busy: 12, gone: 1 },
};
const expectations = LEGS[LEG];
const tickOnly = () => !expectations.tick;

const READINGS_PATH = process.env.SPEND_CELL_READINGS ?? "/tmp/spend-cell-scan-count.json";
const WINDOW_MS = 60_000;
/** `SUBAGENT_SPEND_DEBOUNCE_MS` in interactive-mode.ts: the leading fill's delay. */
const LEADING_FILL_MS = 600;

const scenarios = [];

function usage(input, output, cost) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function tree(root, children) {
	return {
		id: "root",
		label: "main agent",
		status: "active",
		model: { provider: "bailian", id: "deepseek-v4.1-flash" },
		ownUsage: root,
		totalUsage: root,
		children,
	};
}

function child(id, status, overrides = {}) {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

/**
 * A mode whose agent connection is a spend-cell fixture: the real cadence code runs,
 * only the connection, the settings surface and the line are stand-ins. Built through
 * the prototype on purpose - the spend fields are private, and the cadence code is
 * written to tolerate their absence (`hasSubagentSpendFigure`).
 *
 * `omitIntervalMethod` drops `getSubagentSpendCellIntervalMs` so the tick falls back to
 * the constant in `interactive-mode.ts`; without it the answer is the real settings
 * default, which is what a user with no `ui.subagentSpendCell` block gets.
 */
function createMode({ enabled = true, suspended = false, intervalMs, omitIntervalMethod = false } = {}) {
	const getContextTree = vi.fn(async () => tree(usage(1_000, 500, 0.5), []));
	const setSpend = vi.fn();
	const summaryLine = {
		setSubagentCounts: vi.fn(),
		setStallMarkers: vi.fn(),
		setSubagentSpend: setSpend,
		isSelectable: () => false,
		focused: false,
	};
	const settingsSurface = {
		getSubagentSpendCellEnabled: () => enabled,
		getSubagentSpendCellPriceOverrides: () => ({}),
		...(omitIntervalMethod
			? {}
			: { getSubagentSpendCellIntervalMs: () => intervalMs ?? DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS }),
	};
	const mode = Object.create(InteractiveMode.prototype);
	Object.assign(mode, {
		subagentSnapshots: new Map(),
		rlmNodeId: undefined,
		heartbeatCatalog: [],
		subagentSummaryLine: summaryLine,
		subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
		terminalSuspended: suspended,
		connectionState: undefined,
		rosterBar: undefined,
		uiServices: { settingsManager: settingsSurface, modelRegistry: { find: vi.fn(() => undefined) } },
		agentConnection: { getContextTree },
		scheduleHeartbeatManagerRefresh: vi.fn(),
		updateWorkingPulse: vi.fn(),
		syncWorkingLoader: vi.fn(),
		updateWorkingLoaderMessage: vi.fn(),
		ui: { requestRender: vi.fn() },
	});
	return {
		mode,
		getContextTree,
		setSpend,
		update: Reflect.get(InteractiveMode.prototype, "updateSubagentSummary"),
		schedule: Reflect.get(InteractiveMode.prototype, "scheduleSubagentSpendRefresh"),
	};
}

/** Scan timestamps, so the cadence is visible in the reading and not just its count. */
function spyScanTimes(getContextTree) {
	const stamps = [];
	const implementation = getContextTree.getMockImplementation();
	getContextTree.mockImplementation(async () => {
		stamps.push(Date.now());
		return await implementation();
	});
	return stamps;
}

function recordScenario(label, scans, extra = {}) {
	const gaps = scans.slice(1).map((stamp, index) => stamp - scans[index]);
	scenarios.push({ label, scans: scans.length, scanStamps: scans, gapsMs: gaps, ...extra });
	return scans.length;
}

afterAll(() => {
	const payload = {
		generatedAt: new Date().toISOString(),
		baseSha: process.env.SPEND_CELL_BASE_SHA ?? "unspecified",
		expectations,
		leg: LEG,
		command:
			LEG === "pre-v1"
				? "cd /tmp/spend-base-wt && SPEND_CELL_LEG=pre-v1 npx vitest run --root . --config packages/coding-agent/vitest.config.ts docs/fork/evidence/spend-cell-scan-count.test.mjs"
				: "npx vitest run --root . --config packages/coding-agent/vitest.config.ts docs/fork/evidence/spend-cell-scan-count.test.mjs",
		window: `${WINDOW_MS} ms of fake time`,
		scenarios,
	};
	mkdirSync(dirname(READINGS_PATH), { recursive: true });
	writeFileSync(READINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
});

describe("subagent spend cell: context-tree scans per 60s", () => {
	it("a quiet visible family costs one leading fill plus one scan per 15s tick", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createMode();
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(LEADING_FILL_MS);
			const afterFill = scans.length;
			await vi.advanceTimersByTimeAsync(WINDOW_MS - LEADING_FILL_MS);

			const total = recordScenario("quiet-visible-60s", scans, {
				leadingFill: afterFill,
				intervalMs: DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS,
				intervalFrom: "DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS",
			});
			expect(afterFill).toBe(1);
			// current: 1 leading fill + ticks at 15s/30s/45s/60s.
			// pre-v1: the leading fill alone - there is no idle tick to keep it fresh.
			expect(total).toBe(expectations.quiet);
			for (const gap of scans.slice(2).map((stamp, index) => stamp - scans[index + 1])) {
				expect(gap).toBeGreaterThanOrEqual(14_950);
				expect(gap).toBeLessThanOrEqual(15_050);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(tickOnly())("falls back to the constant in interactive-mode.ts when the settings surface has no interval", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createMode({ omitIntervalMethod: true });
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(LEADING_FILL_MS);
			await vi.advanceTimersByTimeAsync(WINDOW_MS - LEADING_FILL_MS);

			const total = recordScenario("fallback-constant-60s", scans, {
				intervalFrom: "SUBAGENT_SPEND_IDLE_TICK_MS (no settings method)",
			});
			// Same reading by a different road: both cadence constants must stay 15s.
			expect(total).toBe(expectations.quiet);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a continuously working family does not add scans on top of the tick", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createMode();
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(LEADING_FILL_MS);
			// An event every 100ms for the rest of the window: the removed behaviour scanned
			// per burst; this code only keeps the cadence in step with what is on screen.
			for (let elapsed = LEADING_FILL_MS; elapsed < WINDOW_MS; elapsed += 100) {
				update.call(mode, child("worker", "running", { activity: { kind: "executing" } }));
				await vi.advanceTimersByTimeAsync(100);
			}
			const total = recordScenario("busy-visible-60s", scans, { eventsPerSecond: 10 });
			// current: 5. pre-v1 (measurable in a worktree at 0186a1247): 12 - one scan per
			// 5s floor for the whole minute, which is the regression the tick removed.
			expect(total).toBe(expectations.busy);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(tickOnly())("a turn end adds exactly one forced scan on top of the tick", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update, schedule } = createMode();
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(LEADING_FILL_MS);
			await vi.advanceTimersByTimeAsync(30_000 - LEADING_FILL_MS);
			// A landed assistant message / turn end forces a refresh past the debounce and floor.
			schedule.call(mode, true);
			await vi.advanceTimersByTimeAsync(WINDOW_MS - 30_000);

			const total = recordScenario("quiet-visible-60s-one-turn-end", scans, { forcedRefreshes: 1 });
			// 1 leading fill + 4 ticks + 1 forced turn-end refresh. This is the only shape
			// this instrument reaches six scans in - which is how the changelog's "6" can be
			// read (5 idle/event + 1 turn end); the tick legs alone give five.
			expect(total).toBe(expectations.turnEnd);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(tickOnly())("negative control: the configured 5s cadence moves the same reading", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createMode({ intervalMs: MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS });
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(LEADING_FILL_MS);
			await vi.advanceTimersByTimeAsync(WINDOW_MS - LEADING_FILL_MS);

			const total = recordScenario("negative-control-5s-tick-60s", scans, {
				intervalMs: MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS,
			});
			// 1 leading fill + ticks at 5s..60s = 12.
			expect(total).toBe(expectations.tick5s);
		} finally {
			vi.useRealTimers();
		}
	});

	// Current leg only: the emergency switch became a full short-circuit with the spend-cell
	// patch set. The pre-v1 tree guards the schedule site with `subagentCounts.total === 0`
	// alone, so a switched-off cell still paid for the leading fill (measured: 1 scan in the
	// pre-v1 leg, 0 here) - that difference is itself part of what the patch set bought.
	it.skipIf(tickOnly())("negative control: a cell that is off screen scans nothing and blanks the figure", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update, setSpend } = createMode({ enabled: false });
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(WINDOW_MS);

			const total = recordScenario("negative-control-cell-off-60s", scans, { enabled: false });
			expect(total).toBe(0);
			expect(setSpend).toHaveBeenLastCalledWith(undefined);
		} finally {
			vi.useRealTimers();
		}
	});

	it("negative control: a family that disappears mid-window freezes the count", async () => {
		vi.useFakeTimers();
		try {
			const { mode, getContextTree, update } = createMode();
			const scans = spyScanTimes(getContextTree);
			update.call(mode, child("worker", "running"));
			await vi.advanceTimersByTimeAsync(16_000);
			const beforeExit = scans.length;
			// A cancelled child leaves the family (the tree drops it from the snapshots).
			update.call(mode, child("worker", "cancelled"));
			await vi.advanceTimersByTimeAsync(WINDOW_MS - 16_000);
			const total = recordScenario("negative-control-family-gone-60s", scans, { scansBeforeExit: beforeExit });
			expect(beforeExit).toBe(expectations.gone);
			expect(total).toBe(beforeExit);
		} finally {
			vi.useRealTimers();
		}
	});
});
