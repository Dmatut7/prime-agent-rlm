/**
 * W14-B (org-memory hard gate, C5 from /tmp/wave10/model-cases.md): a session
 * reopened after a restart used to come back with its transcript but no
 * first-class statement of what was in flight - the model ran its own
 * checklist instead of resuming the interrupted task. On every fresh bind of
 * a persisted session the daemon now injects a resume briefing (active goal +
 * persistent flag, queued inputs, interrupted worker operations, duty-log
 * tail, org-memory doc index, harness-store pointer) as next-turn context.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_STATE_CUSTOM_TYPE } from "../../../src/core/goals.js";
import type { CustomMessageEntry } from "../../../src/core/session-manager.js";
import {
	buildResumeBriefing,
	maybeInjectResumeBriefing,
	queuedInputsReplayOfVerdict,
	RESUME_BRIEFING_CUSTOM_TYPE,
} from "../../../src/modes/daemon/resume-briefing.js";
import { createHarness, type Harness } from "../harness.js";

describe("W14-B resume briefing builder", () => {
	it("returns undefined when nothing is in flight", () => {
		expect(
			buildResumeBriefing({
				queuedCount: 0,
				interruptedOperations: [],
				orgDocs: [],
				now: 1_000_000,
			}),
		).toBeUndefined();
	});

	it("reports an active persistent goal with budget usage", () => {
		const briefing = buildResumeBriefing({
			goal: {
				active: true,
				status: "active",
				goalId: "g1",
				objective: "把 UI 更新做完",
				tokenBudget: 50000,
				tokensUsed: 12345,
				timeUsedSeconds: 600,
				continuationsUsed: 1,
				persistent: true,
			},
			queuedCount: 0,
			interruptedOperations: [],
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toBeDefined();
		expect(briefing).toContain("把 UI 更新做完");
		expect(briefing).toContain("persistent");
		expect(briefing).toContain("12345/50000");
		expect(briefing).toContain("status: active");
	});

	it("reports a paused goal as resumable rather than active", () => {
		const briefing = buildResumeBriefing({
			goal: {
				active: false,
				status: "paused",
				objective: "long running audit",
				tokensUsed: 10,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
			},
			queuedCount: 0,
			interruptedOperations: [],
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toContain("status: paused");
		expect(briefing).toContain("long running audit");
	});

	it("omits a completed goal", () => {
		expect(
			buildResumeBriefing({
				goal: {
					active: false,
					status: "complete",
					objective: "done already",
					tokensUsed: 10,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
				},
				queuedCount: 0,
				interruptedOperations: [],
				orgDocs: [],
				now: 1_000_000,
			}),
		).toBeUndefined();
	});

	it("lists queued inputs and interrupted worker operations", () => {
		const briefing = buildResumeBriefing({
			queuedCount: 3,
			interruptedOperations: ["turn_end", "bash_exec"],
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toContain("3 queued input");
		expect(briefing).toContain("turn_end");
		expect(briefing).toContain("bash_exec");
	});

	it("reports queued inputs recovered from the interruption marker even when the rebuilt queue is empty", () => {
		// wave-40: a crashed worker takes its in-memory queue with it; the texts it
		// never delivered ride the recovery marker, and the briefing must not claim
		// "nothing pending" over them.
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: ["turn_end"],
			queuedInputs: { texts: ["把剩下的测试修完", "顺手看下 lint"], replay: { kind: "replayed" } },
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toBeDefined();
		expect(briefing).toContain("把剩下的测试修完");
		expect(briefing).toContain("顺手看下 lint");
		expect(briefing).toContain("replayed into the queue");
	});

	it("says the recovered queued inputs were not replayed when the automatic resume is skipped as stale", () => {
		// The stale guard skips the whole automatic resume, so the recovered texts
		// stay in the marker; the briefing listing them must not read as a replay.
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: ["turn_end"],
			queuedInputs: { texts: ["把剩下的测试修完"], replay: { kind: "skipped", reason: "stale" } },
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toBeDefined();
		expect(briefing).toContain("把剩下的测试修完");
		expect(briefing).toContain("but were not replayed");
		expect(briefing).toContain("too old");
		expect(briefing).not.toContain("replayed into the queue");
	});

	it("says the recovered queued inputs were not replayed when the crash-loop guard skips the resume", () => {
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: ["turn_end"],
			queuedInputs: { texts: ["把剩下的测试修完"], replay: { kind: "skipped", reason: "resume-loop" } },
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toBeDefined();
		expect(briefing).toContain("把剩下的测试修完");
		expect(briefing).toContain("but were not replayed");
		expect(briefing).toContain("crash-resume");
		expect(briefing).not.toContain("replayed into the queue");
	});

	it("says the recovered queued inputs were not replayed on the /resume replacement path", () => {
		// refreshReplacedSessionState injects the briefing without going through
		// resumeWorkerInterruptedSession, so nothing replays the marker's texts.
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: ["turn_end"],
			queuedInputs: { texts: ["把剩下的测试修完"], replay: { kind: "not-replayed" } },
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toBeDefined();
		expect(briefing).toContain("把剩下的测试修完");
		expect(briefing).toContain("but were not replayed");
		expect(briefing).toContain("replaced in place");
		expect(briefing).not.toContain("replayed into the queue");
	});

	it("maps the resume verdict to the briefing's replay claim", () => {
		expect(queuedInputsReplayOfVerdict({ kind: "skip", reason: "no-marker" })).toEqual({ kind: "not-replayed" });
		expect(queuedInputsReplayOfVerdict({ kind: "skip", reason: "stale" })).toEqual({
			kind: "skipped",
			reason: "stale",
		});
		expect(queuedInputsReplayOfVerdict({ kind: "skip", reason: "resume-loop" })).toEqual({
			kind: "skipped",
			reason: "resume-loop",
		});
		const marker: CustomMessageEntry = {
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "custom_message",
			customType: "prime-agent.worker_recovery",
			content: "<prime_agent_worker_interrupted>…</prime_agent_worker_interrupted>",
			display: false,
		};
		expect(queuedInputsReplayOfVerdict({ kind: "resume", marker, queuedInputs: [] })).toEqual({ kind: "replayed" });
	});

	it("carries the duty-log tail: last doing, unfinished, pending decisions", () => {
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: [],
			orgDocs: [],
			duty: {
				awayMs: 3_600_000,
				activeMs: 1_800_000,
				finishedTurns: 14,
				children: [],
				incidents: [],
				pending: [{ question: "要不要继续", at: 900_000 }],
				unfinished: "接下来跑全量门禁",
				lastDoing: "更新 settings 面板",
			},
			now: 1_000_000,
		});
		expect(briefing).toContain("更新 settings 面板");
		expect(briefing).toContain("接下来跑全量门禁");
		expect(briefing).toContain("要不要继续");
		expect(briefing).toContain("14");
	});

	it("indexes the org-memory docs and names the ledger", () => {
		const briefing = buildResumeBriefing({
			queuedCount: 0,
			interruptedOperations: [],
			orgDocs: ["docs/fork/evolution-ledger.md", "docs/fork/tl2-review-fixes-20260930.md"],
			now: 1_000_000,
		});
		expect(briefing).toContain("docs/fork/evolution-ledger.md");
		expect(briefing).toContain("tl2-review-fixes-20260930.md");
	});

	it("states the facts are context, not a new instruction", () => {
		const briefing = buildResumeBriefing({
			queuedCount: 1,
			interruptedOperations: [],
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toContain("not a new instruction");
	});

	it("points at the continual harness stores that survived the reopen", () => {
		// The reopen is exactly when the model cannot tell what it knew: the
		// briefing names the persistent stores and the read call into them.
		const briefing = buildResumeBriefing({
			queuedCount: 1,
			interruptedOperations: [],
			orgDocs: [],
			now: 1_000_000,
		});
		expect(briefing).toContain("continual harness");
		expect(briefing).toContain("survived the reopen");
		expect(briefing).toContain("`rlm.harness.search('terms', global_=True)`");
	});
});

describe("W14-B resume briefing injection on the recovery path", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createInterruptedSessionFile(): Promise<string> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("正在更新 UI 的设置面板")]);
		await harness.session.prompt("把设置面板更新一下");
		harness.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
			active: true,
			status: "active",
			goalId: "g1",
			objective: "把 UI 更新做完",
			tokenBudget: 50000,
			tokensUsed: 12345,
			timeUsedSeconds: 600,
			continuationsUsed: 1,
			persistent: true,
		});
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		harness.session.dispose();
		return sessionFile!;
	}

	it("injects the in-flight state as next-turn context when a persisted session is reopened", async () => {
		const sessionFile = await createInterruptedSessionFile();
		const resumed = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(resumed);

		const injected = await maybeInjectResumeBriefing(resumed.session);
		expect(injected).toBe(true);

		const pending = resumed.session.getPendingNextTurnMessageSnapshots();
		const briefing = pending.find((message) => message.customType === RESUME_BRIEFING_CUSTOM_TYPE);
		expect(briefing).toBeDefined();
		const text = typeof briefing!.content === "string" ? briefing!.content : JSON.stringify(briefing!.content);
		expect(text).toContain("把 UI 更新做完");
		expect(text).toContain("persistent");
	});

	it("delivers the briefing to the provider on the first turn after the resume", async () => {
		const sessionFile = await createInterruptedSessionFile();
		const resumed = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(resumed);
		await maybeInjectResumeBriefing(resumed.session);

		let captured: Context | undefined;
		resumed.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("好的，继续刚才的活");
			},
		]);
		await resumed.session.prompt("我重启了");

		expect(captured).toBeDefined();
		const wire = JSON.stringify(captured!.messages);
		expect(wire).toContain("session_resume_briefing");
		expect(wire).toContain("把 UI 更新做完");
		// Consumed by the turn: nothing left pending afterwards.
		expect(
			resumed.session
				.getPendingNextTurnMessageSnapshots()
				.filter((message) => message.customType === RESUME_BRIEFING_CUSTOM_TYPE),
		).toHaveLength(0);
	});

	it("reports queued inputs the crash marker carries, with an empty in-memory queue", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("做到了一半")]);
		await harness.session.prompt("把设置面板更新一下");
		// The worker died with queued inputs it never delivered: the supervisor's
		// interruption marker carries their texts (details.queuedInputs).
		harness.sessionManager.appendCustomMessageEntry(
			"prime-agent.worker_recovery",
			"<prime_agent_worker_interrupted>…</prime_agent_worker_interrupted>",
			false,
			{ activeSessionId: "dead", operations: ["turn_end"], queuedInputs: ["把剩下的测试修完"] },
		);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		harness.session.dispose();

		const resumed = await createHarness({ existingSessionFile: sessionFile! });
		harnesses.push(resumed);
		const injected = await maybeInjectResumeBriefing(resumed.session, {
			queuedInputsReplay: { kind: "replayed" },
		});
		expect(injected).toBe(true);

		const briefing = resumed.session
			.getPendingNextTurnMessageSnapshots()
			.find((message) => message.customType === RESUME_BRIEFING_CUSTOM_TYPE);
		const text = typeof briefing?.content === "string" ? briefing.content : "";
		expect(text).toContain("把剩下的测试修完");
		expect(text).toContain("replayed into the queue");
		expect(text).not.toContain("0 queued input");
	});

	it("does not claim a replay when the caller reports the resume was skipped", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("做到了一半")]);
		await harness.session.prompt("把设置面板更新一下");
		harness.sessionManager.appendCustomMessageEntry(
			"prime-agent.worker_recovery",
			"<prime_agent_worker_interrupted>…</prime_agent_worker_interrupted>",
			false,
			{ activeSessionId: "dead", operations: ["turn_end"], queuedInputs: ["把剩下的测试修完"] },
		);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		harness.session.dispose();

		const resumed = await createHarness({ existingSessionFile: sessionFile! });
		harnesses.push(resumed);
		const injected = await maybeInjectResumeBriefing(resumed.session, {
			queuedInputsReplay: { kind: "skipped", reason: "resume-loop" },
		});
		expect(injected).toBe(true);

		const briefing = resumed.session
			.getPendingNextTurnMessageSnapshots()
			.find((message) => message.customType === RESUME_BRIEFING_CUSTOM_TYPE);
		const text = typeof briefing?.content === "string" ? briefing.content : "";
		// The texts still surface (they are the user's lost work), but the wording
		// must follow the actual outcome: skipped resume, no replay.
		expect(text).toContain("把剩下的测试修完");
		expect(text).toContain("but were not replayed");
		expect(text).not.toContain("replayed into the queue");
	});

	it("does not inject into a fresh session with no prior work", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const injected = await maybeInjectResumeBriefing(harness.session);
		expect(injected).toBe(false);
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(0);
	});

	it("indexes the repo's org-memory docs when docs/fork exists under the session cwd", async () => {
		const sessionFile = await createInterruptedSessionFile();
		const resumed = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(resumed);
		// The resumed session's cwd is the resuming harness's temp dir (production
		// rehydration overrides the recorded cwd the same way).
		const forkDocs = join(resumed.tempDir, "docs", "fork");
		mkdirSync(forkDocs, { recursive: true });
		const ledger = join(forkDocs, "evolution-ledger.md");
		const errata = join(forkDocs, "fix-plan-r3.md");
		writeFileSync(ledger, "# 演化账本\n");
		writeFileSync(errata, "# fix plan r3\n");
		utimesSync(errata, new Date("2026-09-30T00:00:00Z"), new Date("2026-09-30T00:00:00Z"));
		utimesSync(ledger, new Date("2026-10-02T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));

		const injected = await maybeInjectResumeBriefing(resumed.session);
		expect(injected).toBe(true);

		const briefing = resumed.session
			.getPendingNextTurnMessageSnapshots()
			.find((message) => message.customType === RESUME_BRIEFING_CUSTOM_TYPE);
		const text = typeof briefing?.content === "string" ? briefing.content : "";
		expect(text).toContain("docs/fork/evolution-ledger.md");
		// Newest first: the ledger outranks the older errata doc.
		expect(text.indexOf("evolution-ledger.md")).toBeLessThan(text.indexOf("fix-plan-r3.md"));
	});
});
