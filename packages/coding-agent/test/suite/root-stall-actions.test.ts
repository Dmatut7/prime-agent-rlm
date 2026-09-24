/**
 * Root-session stall actions (r4 recovery-shell, mechanism ④): the view the
 * interactive host mounts for a stall event, the event shape an in-process
 * emitter produces, and the settings the daemon gates its half on.
 *
 * The TUI component's rendering is pinned in the tui package; what this file
 * pins is the coding-agent side: the mount decision is a pure function of the
 * event type and the host's real keybinding facts (B1/B2/S1), a session-emitted
 * stall event degrades to no-actions (the daemon adds the field on the wire),
 * and the two settings blocks resolve their documented defaults.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { type StallActionBarHostFacts, stallActionBarView } from "../../src/core/stall-diagnostics-render.js";
import { StallFakeClock } from "../fixtures/stall-fake-clock.js";
import { createHarness, type Harness } from "./harness.js";

const WARN_AFTER_MS = 50;

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang Forever",
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function host(overrides: Partial<StallActionBarHostFacts> = {}): StallActionBarHostFacts {
	return { interruptKeyLabel: "Esc", canInterrupt: true, canDiagnose: true, ...overrides };
}

describe("stall action bar view resolution", () => {
	it("a warning mounts both actions when the host can honor them", () => {
		const view = stallActionBarView({ type: "stall_warning" }, host());

		expect(view).toEqual({ canAbort: true, canDiagnose: true });
	});

	it("S1: terminal stall stages never offer actions", () => {
		for (const type of ["stall_abort", "stall_unsettled"] as const) {
			expect(stallActionBarView({ type }, host())).toBeUndefined();
		}
	});

	it("B2: an empty interrupt label means the interrupt action is not offered", () => {
		const view = stallActionBarView({ type: "stall_warning" }, host({ interruptKeyLabel: "" }));

		expect(view).toEqual({ canAbort: false, canDiagnose: true });
	});

	it("F1: without an interrupt handler the action is not offered either", () => {
		const view = stallActionBarView({ type: "stall_warning" }, host({ canInterrupt: false }));

		expect(view).toEqual({ canAbort: false, canDiagnose: true });
	});

	it("no usable action mounts nothing (the plain error channel stays the whole report)", () => {
		const view = stallActionBarView(
			{ type: "stall_warning" },
			host({ interruptKeyLabel: "", canInterrupt: false, canDiagnose: false }),
		);

		expect(view).toBeUndefined();
	});
});

describe("a session-emitted stall event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("carries the diagnostics payload and no actions field (the daemon adds actions on the wire)", async () => {
		const clock = new StallFakeClock();
		const session = await createHarness({
			tools: [hangTool()],
			settings: {
				stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
				retry: { enabled: false },
			},
			stallWatchdogTimers: clock.timersImpl,
		});
		harnesses.push(session);
		session.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void session.session.prompt("call the hanging tool");
		await vi.waitFor(
			() => {
				expect(session.eventsOfType("tool_execution_start")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		clock.advance(WARN_AFTER_MS);
		await vi.waitFor(
			() => {
				expect(session.eventsOfType("stall_warning")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		const [warning] = session.eventsOfType("stall_warning");
		expect(warning).toBeDefined();
		if (!warning) throw new Error("unreachable");
		expect(warning.diagnostics.inFlightToolCalls.length).toBeGreaterThanOrEqual(1);
		// The in-process emitter never fills the field: the local host resolves
		// its own keys and an older client never sees a phantom promise. The
		// positive control for this detector is the daemon's enrichment, pinned
		// in test/daemon-stall-recovery.test.ts.
		expect("actions" in warning).toBe(false);
	});
});

describe("stall recovery settings resolution", () => {
	it("resolves the documented defaults", () => {
		const manager = SettingsManager.inMemory({});

		// Warn-only by default (silence is normal for long work): the automatic
		// actions are off unless the owner opts into silence kills.
		expect(manager.getSubagentStallRecoverySettings()).toEqual({
			enabled: false,
			graceSeconds: 300,
			maxPerSession: 3,
		});
		expect(manager.getRootStallRecoverySettings()).toEqual({
			enabled: false,
			humanWindowSeconds: 120,
			maxPerSession: 3,
		});
	});

	it("honors the rollback handles and the tuning keys", () => {
		const manager = SettingsManager.inMemory({
			subagents: { stallRecovery: { enabled: false, graceSeconds: 10 } },
			stallWatchdog: { rootRecovery: { enabled: false, humanWindowSeconds: 0 } },
		});

		expect(manager.getSubagentStallRecoverySettings()).toMatchObject({
			enabled: false,
			graceSeconds: 10,
		});
		// humanWindowSeconds 0 is a valid setting (act as soon as confirmed), not
		// a fallback trigger.
		expect(manager.getRootStallRecoverySettings()).toMatchObject({
			enabled: false,
			humanWindowSeconds: 0,
		});
	});

	it("rejects non-finite or negative values back to the defaults", () => {
		const manager = SettingsManager.inMemory({
			subagents: { stallRecovery: { graceSeconds: Number.NaN, maxPerSession: -1 } },
			stallWatchdog: { rootRecovery: { humanWindowSeconds: Number.POSITIVE_INFINITY } },
		});

		expect(manager.getSubagentStallRecoverySettings()).toMatchObject({
			graceSeconds: 300,
			maxPerSession: 3,
		});
		expect(manager.getRootStallRecoverySettings()).toMatchObject({ humanWindowSeconds: 120 });
	});
});
