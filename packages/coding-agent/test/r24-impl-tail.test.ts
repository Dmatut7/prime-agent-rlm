import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { compactionKernelStateLines } from "../src/core/kernel/state-snapshot.js";
import {
	convertToLlm,
	createRefinementFailureMessage,
	createRefinementOutcomeMessage,
	refinementOutcomeToLlmText,
} from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { createTestResourceLoader } from "./utilities.js";

const tempDir = mkdtempSync(join(tmpdir(), "r24-impl-tail-"));
afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function createBareSession(options?: { agentMessageController?: AgentSessionMessageController }): {
	session: AgentSession;
	dispose: () => void;
} {
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: { model, systemPrompt: "probe", tools: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: tempDir,
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
		agentMessageController: options?.agentMessageController,
	});
	return {
		session,
		dispose: () => {
			session.dispose();
			faux.unregister();
		},
	};
}

describe("FR-4: quiescence barrier gives up after its deadline instead of hanging", () => {
	it("returns { settled: false } and warns when descendants never settle", async () => {
		const { session, dispose } = createBareSession();
		try {
			// Park the barrier: a bash operation that never completes keeps the
			// session active, so the wait loops on its 1s activity tick forever.
			let releaseBash: () => void = () => {};
			const bashGate = new Promise<void>((resolve) => {
				releaseBash = resolve;
			});
			const operations: BashOperations = {
				exec: async () => {
					await bashGate;
					return { exitCode: 0 };
				},
			};
			const bash = session.executeBash("gate", undefined, { operations });
			await session.waitForIdle();

			vi.useFakeTimers();
			try {
				const quiescence = session.waitForRlmQuiescence();
				// On the pre-fix code nothing gives up, so this race would sit on
				// the timer side; the give-up deadline must resolve it instead.
				const outcome = await Promise.race([quiescence.then((result) => result), sleep(500).then(() => undefined)]);
				await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
				const settled = await Promise.race([quiescence.then((result) => result), sleep(500).then(() => undefined)]);
				expect(outcome).toBeUndefined(); // before the deadline: still waiting
				expect(settled).toEqual({ settled: false, timedOut: true });
			} finally {
				vi.useRealTimers();
			}
			releaseBash();
			await bash;
		} finally {
			dispose();
		}
	});

	it("reports settled: true when nothing is unsettled (positive control)", async () => {
		const { session, dispose } = createBareSession();
		try {
			await expect(session.waitForRlmQuiescence()).resolves.toEqual({ settled: true });
		} finally {
			dispose();
		}
	});
});

describe("FR-5: the post-compaction kernel notice marks a failed snapshot write", () => {
	it("says the snapshot was not written when the write was refused or failed", () => {
		const lines = compactionKernelStateLines({ snapshot: null, names: ["a", "b"] });
		const text = lines.join("\n");
		// The kernel is still live, so availability stays true...
		expect(text).toContain("persisted through compaction");
		// ...but the persistence claim is withdrawn honestly.
		expect(text).toContain("could not be written");
		expect(text).toContain("must be recreated");
		expect(text).toContain("These names are still defined: a, b.");
	});

	it("keeps the success wording and lists skipped names on a successful write", () => {
		const lines = compactionKernelStateLines({
			snapshot: {
				saved: ["a"],
				skipped: [{ name: "gpu_tensor", reason: "unpicklable" }],
				pruned: ["big"],
				bytes: 10,
				path: "/tmp/kernel-state.pkl",
			},
			names: ["a"],
		});
		const text = lines.join("\n");
		expect(text).toContain("Variables above the per-variable snapshot limit were removed: big.");
		expect(text).toContain("gpu_tensor (unpicklable)");
		expect(text).toContain("will not survive a restart");
		expect(text).toContain("These names are still defined: a.");
		expect(text).not.toContain("could not be written");
	});

	it("says the namespace is unknown when listing failed", () => {
		const lines = compactionKernelStateLines({ snapshot: null, names: null });
		expect(lines.join("\n")).toContain("could not be listed");
	});
});

describe("MV-5: refinement failures leave a model-visible receipt", () => {
	it("renders a failure receipt even with zero edit rows", () => {
		const message = createRefinementFailureMessage({
			refinementId: "ref-1",
			scope: "local",
			reason: "provider error: 502",
		});
		expect(message.content).toContain("Refinement failed: provider error: 502");
		expect(message.details.failed).toBe(true);
		expect(message.details.edits).toEqual([]);
		// The zero-edit drop rule is for successes that recorded nothing; a
		// failure must reach the model.
		const text = refinementOutcomeToLlmText(message.details);
		expect(text).toBeDefined();
		expect(text).toContain('outcome="failed"');
		expect(text).toContain("provider error: 502");
		expect(text).toContain("no edits were applied");
		// And it rides convertToLlm like the success receipt does.
		const converted = convertToLlm([message]);
		expect(converted).toHaveLength(1);
		expect((converted[0]?.content as { type: string; text: string }[])[0]?.text).toContain('outcome="failed"');
	});

	it("keeps dropping empty success outcomes (control)", () => {
		const message = createRefinementOutcomeMessage({
			id: "ref-2",
			summary: "nothing to do",
			scope: "local",
			appliedEdits: [],
			rationale: "control",
			expectedOutcome: "control",
			harnessStatePath: "/tmp/control-harness-state.json",
		});
		expect(refinementOutcomeToLlmText(message.details)).toBeUndefined();
	});
});

describe("O1: agent-message send failure ledger expires", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not count a day-old failure as consecutive", async () => {
		const controller: AgentSessionMessageController = {
			sendAgentMessage: vi.fn(async () => {
				throw new Error("rate limit exceeded");
			}),
		} as unknown as AgentSessionMessageController;
		const { session, dispose } = createBareSession({ agentMessageController: controller });
		try {
			const send = () =>
				session.handleAgentMessageHostRequest("agent_message.send", {
					target: "worker",
					message: "hello",
				});
			// First attempts pass the retryable error through unchanged.
			await expect(send()).rejects.toThrow("rate limit exceeded");
			await expect(send()).rejects.toThrow("rate limit exceeded");
			// The third consecutive failure is terminal (M6b behavior preserved).
			await expect(send()).rejects.toThrow(/terminal, not retryable/i);
			// A day later the ledger entry has expired: the failure sequence
			// restarts and the original retryable error passes through again
			// instead of a stale terminal verdict.
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
			await expect(send()).rejects.toThrow("rate limit exceeded");
		} finally {
			dispose();
		}
	});
});
