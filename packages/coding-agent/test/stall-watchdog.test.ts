import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { StallWatchdog, type StallWatchdogTimers } from "../src/core/stall-watchdog.js";
import type { ExtensionFactory } from "../src/index.js";

class FakeClock {
	nowMs = 0;
	private nextId = 1;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];

	readonly timersImpl: StallWatchdogTimers = {
		setTimeout: (fn, delayMs) => {
			const id = this.nextId++;
			this.timers.push({ id, at: this.nowMs + delayMs, fn });
			return id;
		},
		clearTimeout: (handle) => {
			this.timers = this.timers.filter((timer) => timer.id !== handle);
		},
		now: () => this.nowMs,
	};

	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			this.timers.sort((a, b) => a.at - b.at);
			const next = this.timers.find((timer) => timer.at <= target);
			if (!next) break;
			this.timers = this.timers.filter((timer) => timer !== next);
			this.nowMs = next.at;
			next.fn();
		}
		this.nowMs = target;
	}
}

describe("StallWatchdog", () => {
	it("warns then aborts after sustained silence", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			abortSettleGraceMs: 500,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(999);
		expect(stages).toEqual([]);
		clock.advance(1);
		expect(stages).toEqual(["warn"]);
		clock.advance(1999);
		expect(stages).toEqual(["warn"]);
		clock.advance(1);
		expect(stages).toEqual(["warn", "abort"]);
		// Abort never settles: one final escalation, then the watchdog gives up.
		clock.advance(500);
		expect(stages).toEqual(["warn", "abort", "abort_unsettled"]);
		clock.advance(10_000);
		expect(stages).toEqual(["warn", "abort", "abort_unsettled"]);
	});

	it("touch resets the warn deadline and cancels escalations", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		for (let i = 0; i < 5; i++) {
			clock.advance(900);
			watchdog.touch();
		}
		expect(stages).toEqual([]);
		// Touching after the warning cancels the pending abort and re-arms the warn
		// deadline from the touch.
		clock.advance(1000);
		expect(stages).toEqual(["warn"]);
		clock.advance(1500);
		watchdog.touch();
		clock.advance(999);
		expect(stages).toEqual(["warn"]);
		clock.advance(1);
		expect(stages).toEqual(["warn", "warn"]);
	});

	it("disarm stops all escalation", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(500);
		watchdog.disarm();
		clock.advance(60_000);
		expect(stages).toEqual([]);
		expect(watchdog.currentState).toBe("idle");
	});

	it("stays inert when disabled", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: false,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		watchdog.touch();
		clock.advance(60_000);
		expect(stages).toEqual([]);
		expect(watchdog.currentState).toBe("idle");
	});

	it("supports warn-only mode without an abort stage", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: undefined,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(60_000);
		expect(stages).toEqual(["warn"]);
	});

	it("defers escalation while paused", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		let paused = false;
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			isPaused: () => paused,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		paused = true;
		clock.advance(5000);
		expect(stages).toEqual([]);
		// Paused silence is rebased, not accumulated: after the pause lifts, a full
		// warn window must elapse before the warning fires, and the abort stage then
		// needs its normal escalation gap instead of firing immediately.
		paused = false;
		clock.advance(999);
		expect(stages).toEqual([]);
		clock.advance(1);
		expect(stages).toEqual(["warn"]);
		clock.advance(1999);
		expect(stages).toEqual(["warn"]);
		clock.advance(1);
		expect(stages).toEqual(["warn", "abort"]);
	});

	it("rebases lastActivityAt when abort fires while paused", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		let paused = false;
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			isPaused: () => paused,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(1000);
		expect(stages).toEqual(["warn"]);

		paused = true;
		clock.advance(2000);
		expect(stages).toEqual(["warn"]);
		expect(watchdog.currentState).toBe("armed");

		paused = false;
		clock.advance(999);
		expect(stages).toEqual(["warn"]);
		clock.advance(1);
		expect(stages).toEqual(["warn", "warn"]);
		clock.advance(1999);
		expect(stages).toEqual(["warn", "warn"]);
		clock.advance(1);
		expect(stages).toEqual(["warn", "warn", "abort"]);
	});

	it("escalates once a wedged pause outlives the snooze budget", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			// Warn-only: keeps the expectation to a single stage however far the clock runs.
			abortAfterMs: undefined,
			timers: clock.timersImpl,
			// A wedged pause: it never lifts, which is what a compaction that never
			// settles looks like from here.
			isPaused: () => true,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		// The budget is max(10 * warnAfterMs, 30min) = 30min, counted from the first
		// snooze, so 29 minutes of wedged pause is still excused.
		clock.advance(29 * 60 * 1000);
		expect(stages).toEqual([]);
		// Past the budget the pause stops being an excuse and escalation resumes.
		clock.advance(2 * 60 * 1000);
		expect(stages).toEqual(["warn"]);
	});

	it("reads warn/abort thresholds live from getter functions", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		let warnMs = 1000;
		let abortMs: number | undefined = 3000;
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: () => warnMs,
			abortAfterMs: () => abortMs,
			abortSettleGraceMs: 500,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		// Initial thresholds: warn at 1000ms, abort at 3000ms.
		watchdog.arm();
		clock.advance(1000);
		expect(stages).toEqual(["warn"]);

		// Change thresholds and re-arm: the new values must take effect.
		warnMs = 200;
		abortMs = 600;
		watchdog.arm();
		clock.advance(200);
		expect(stages).toEqual(["warn", "warn"]);
		clock.advance(400);
		expect(stages).toEqual(["warn", "warn", "abort"]);
		clock.advance(500);
		expect(stages).toEqual(["warn", "warn", "abort", "abort_unsettled"]);
	});

	it("respects live enabled flag from a getter function", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		let enabled = true;
		const watchdog = new StallWatchdog({
			enabled: () => enabled,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		enabled = false;
		watchdog.arm();
		clock.advance(60_000);
		expect(stages).toEqual([]);
		expect(watchdog.currentState).toBe("idle");
	});

	it("stops escalating when the watchdog is disabled mid-turn", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		let enabled = true;
		const watchdog = new StallWatchdog({
			enabled: () => enabled,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			abortSettleGraceMs: 500,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(1000);
		expect(stages).toEqual(["warn"]);
		expect(watchdog.currentState).toBe("warned");

		// The user turns the watchdog off while an abort timer is already pending:
		// the pending escalation must be dropped, not fired into a live turn.
		enabled = false;
		clock.advance(60_000);
		expect(stages).toEqual(["warn"]);
		expect(watchdog.currentState).toBe("idle");
	});

	it("touch during aborting does not re-arm the escalation cycle", () => {
		const clock = new FakeClock();
		const stages: string[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			abortSettleGraceMs: 500,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info.stage),
		});

		watchdog.arm();
		clock.advance(1000); // warn
		clock.advance(2000); // abort -> enters "aborting"
		expect(stages).toEqual(["warn", "abort"]);
		expect(watchdog.currentState).toBe("aborting");

		// A touch during the settle grace period must NOT cancel the settle timer
		// or restart the warn->abort cycle.
		watchdog.touch();
		expect(watchdog.currentState).toBe("aborting");

		clock.advance(500); // settle grace expires -> abort_unsettled -> idle
		expect(stages).toEqual(["warn", "abort", "abort_unsettled"]);
		expect(watchdog.currentState).toBe("idle");

		// No further escalation after giving up.
		clock.advance(60_000);
		expect(stages).toEqual(["warn", "abort", "abort_unsettled"]);
	});
});

describe("AgentSession stall watchdog (integration)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	interface Harness {
		session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		events: AgentSessionEvent[];
		faux: ReturnType<typeof registerFauxProvider>;
	}

	async function createHarness(
		settings: Record<string, unknown>,
		extensionFactory?: ExtensionFactory,
	): Promise<Harness> {
		const tempDir = join(tmpdir(), `pi-stall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: faux.getModel(),
			authStorage,
			settingsManager,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			resourceLoader,
		});
		await session.bindExtensions({});

		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(event);
		});

		cleanups.push(async () => {
			unsubscribe();
			await session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { session, events, faux };
	}

	function waitFor(
		events: AgentSessionEvent[],
		predicate: (event: AgentSessionEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<AgentSessionEvent> {
		return new Promise((resolve, reject) => {
			const startedAt = Date.now();
			const timer = setInterval(() => {
				const found = events.find(predicate);
				if (found) {
					clearInterval(timer);
					resolve(found);
					return;
				}
				if (Date.now() - startedAt > timeoutMs) {
					clearInterval(timer);
					reject(new Error("Timed out waiting for session event"));
				}
			}, 5);
		});
	}

	it("stream silence becomes a retryable stall error (provider-level detection)", async () => {
		const { session, events, faux } = await createHarness({
			// Keep the session watchdog out of the way for this case.
			stallWatchdog: { enabled: true, warnAfterSeconds: 2, abortAfterSeconds: 4 },
			retry: { enabled: false, provider: { streamStallTimeoutMs: 60 } },
		});
		// A provider step that accepts the request but never streams anything back.
		faux.setResponses([() => new Promise<never>(() => {})]);

		void session.prompt("hang the stream");
		await waitFor(events, (event) => event.type === "agent_end");

		const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
		expect(assistant).toBeDefined();
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toContain("Stream stalled");
		expect(assistant.errorMessage).toContain("streamStallTimeoutMs");
	});

	it("aborts a never-returning tool via the session watchdog, then recovers", async () => {
		const hangFactory: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				pi.registerTool({
					name: "hang_forever",
					label: "Hang Forever",
					description: "A tool that never returns",
					parameters: Type.Object({}),
					execute: () => new Promise<never>(() => {}),
				});
			});
		};
		const { session, events, faux } = await createHarness(
			{
				stallWatchdog: { enabled: true, warnAfterSeconds: 0.2, abortAfterSeconds: 0.6 },
				retry: { enabled: false },
			},
			hangFactory,
		);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {})), fauxAssistantMessage("recovered")]);

		void session.prompt("call the hanging tool");

		const warning = await waitFor(events, (event) => event.type === "stall_warning");
		expect(warning.type).toBe("stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		expect(warning.message).toContain("no session activity");
		// The warning must include actionable guidance, not just a description.
		expect(warning.message).toContain("interrupt");
		expect(warning.diagnostics.inFlightToolCalls.some((call) => call.toolName === "hang_forever")).toBe(true);

		const abortEvent = await waitFor(events, (event) => event.type === "stall_abort");
		expect(abortEvent.type).toBe("stall_abort");
		if (abortEvent.type !== "stall_abort") throw new Error("unreachable");
		expect(abortEvent.message).toContain("aborted automatically");

		await waitFor(events, (event) => event.type === "agent_end");
		// The aborted tool batch settles as an error tool result, and the run ends.
		const toolResult = [...session.messages].reverse().find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult?.role !== "toolResult") throw new Error("expected tool result");
		expect(toolResult.isError).toBe(true);
		expect(JSON.stringify(toolResult.content).toLowerCase()).toContain("aborted");

		// The session must be usable again after the auto-abort.
		await session.promptAndWait("come back");
		const recovered = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (recovered?.role !== "assistant") throw new Error("expected assistant message after recovery");
		expect(recovered.stopReason).toBe("stop");
		expect(recovered.content.some((block) => block.type === "text" && block.text === "recovered")).toBe(true);
	});
});
