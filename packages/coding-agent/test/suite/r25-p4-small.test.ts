/**
 * r25 P4 batch: small honesty fixes from the K3 review of the r24 tail.
 *
 * - MV-5: a `/refine` argument parse error must still emit refine_failed and
 *   leave a model-visible failure receipt (the parse call was moved out of the
 *   try, losing both).
 * - MV-5: a persist failure must be labeled with the *effective* target scope,
 *   not the requested one - a local request rolling back a global record used
 *   to report scope="local".
 * - O1: the send-failure ledger's 512-target volume ceiling must not evict the
 *   target that is failing right now (its consecutive-failure count reset).
 * - FR-5: a kernel with no snapshot machine must not hear about a "last
 *   successfully written snapshot" that cannot exist.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import { compactionKernelStateLines } from "../../src/core/kernel/state-snapshot.js";
import { REFINEMENT_OUTCOME_CUSTOM_TYPE } from "../../src/core/messages.js";
import { getGlobalHarnessStateDir } from "../../src/core/refinement/index.js";
import { createHarness, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
let ambientAgentDir: string | undefined;
let previousAgentDirEnv: string | undefined;

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	if (previousAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
	if (ambientAgentDir) {
		rmSync(ambientAgentDir, { recursive: true, force: true });
		ambientAgentDir = undefined;
	}
	vi.restoreAllMocks();
});

describe("MV-5: refine failure receipts", () => {
	it("emits refine_failed when /refine arguments fail to parse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/refine rollback");

		// The old path lost both the event and the receipt when the parse threw
		// before the try block.
		expect(harness.eventsOfType("refine_failed").length).toBeGreaterThan(0);
		const receipt = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE,
		);
		expect(receipt).toBeDefined();
		const details = (receipt as { details: { failed?: boolean; error?: string } }).details;
		expect(details.failed).toBe(true);
		expect(details.error).toContain("Usage: /refine rollback <refinement-id>");
	});

	it("labels a global-rollback persist failure with the effective target scope", async () => {
		ambientAgentDir = mkdtempSync(join(tmpdir(), "r25-p4-agent-dir-"));
		previousAgentDirEnv = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = ambientAgentDir;
		const globalDir = getGlobalHarnessStateDir(ambientAgentDir);
		mkdirSync(globalDir, { recursive: true });
		const globalHistoryRecord = {
			id: "refine_global_target",
			summary: "global record",
			rationale: "r",
			expectedOutcome: "o",
			scope: "global",
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "global_note",
					applied: true,
					before: null,
					after: { kind: "memory", id: "global_note", title: "Note", content: "global note" },
				},
			],
			harnessStatePath: join(globalDir, "harness_state.json"),
		};
		writeFileSync(join(globalDir, "refinements.jsonl"), `${JSON.stringify(globalHistoryRecord)}\n`);
		// The global store must be readable so the rollback target resolves, but
		// its state write must fail: a symlinked harness_state.json is read as
		// unsafe (persistentWriteError) and every save refuses it.
		const realState = join(globalDir, "harness_state.real.json");
		writeFileSync(realState, "{}\n");
		symlinkSync(realState, join(globalDir, "harness_state.json"));

		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		await harness.session.prompt("/refine rollback refine_global_target");

		const receipt = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE,
		);
		expect(receipt).toBeDefined();
		const details = (receipt as { details: { failed?: boolean; scope?: string } }).details;
		expect(details.failed).toBe(true);
		// The request was local (no --global) but the rollback target is global;
		// the failure receipt must carry the scope that was actually in play.
		expect(details.scope).toBe("global");
	});
});

describe("O1: agent-message send failure ledger ceiling", () => {
	it("does not reset the count of the target that is failing right now", async () => {
		const controller: AgentSessionMessageController = {
			sendAgentMessage: vi.fn(async () => {
				throw new Error("rate limit exceeded");
			}),
		} as unknown as AgentSessionMessageController;
		const harness = await createHarness({ agentMessageController: controller });
		harnesses.push(harness);
		const session = harness.session;
		const send = (target: string) =>
			session.handleAgentMessageHostRequest("agent_message.send", { target, message: "hello" });

		// The current target fails twice, then enough other distinct targets fail
		// to fill the ledger to its ceiling, leaving the current target as the
		// oldest insertion.
		await expect(send("current")).rejects.toThrow("rate limit exceeded");
		await expect(send("current")).rejects.toThrow("rate limit exceeded");
		for (let index = 0; index < 511; index += 1) {
			await expect(send(`other-${index}`)).rejects.toThrow("rate limit exceeded");
		}

		// The third consecutive failure of "current" must terminalize; the
		// pre-fix ceiling prune evicted "current" first and reset its count.
		await expect(send("current")).rejects.toThrow(/terminal, not retryable/i);
	});
});

describe("FR-5: no-snapshot-machine compaction copy", () => {
	it("does not claim a last written snapshot when the kernel has no snapshot machine", () => {
		const lines = compactionKernelStateLines({ snapshot: null, names: ["a"], hasSnapshotConfig: false });
		const text = lines.join("\n");
		expect(text).toContain("still available");
		expect(text).toContain("no state snapshot");
		expect(text).not.toContain("last successfully written snapshot");
	});

	it("keeps the failed-write wording when a snapshot machine exists", () => {
		const lines = compactionKernelStateLines({ snapshot: null, names: ["a"], hasSnapshotConfig: true });
		const text = lines.join("\n");
		expect(text).toContain("last successfully written snapshot");
	});
});
