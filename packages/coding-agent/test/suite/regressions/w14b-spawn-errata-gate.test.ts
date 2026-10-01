/**
 * W14-B (org-memory hard gate, C4 from /tmp/wave10/model-cases.md): the chair
 * re-initiated a review wave without checking the errata ledger and burned a
 * whole wave of subagents. Review-class RLM spawn prompts now carry a
 * mandatory gate line into the child's first turn: read
 * docs/fork/evolution-ledger.md and the errata it references before
 * initiating (立项) anything.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSpawnErrataGateText,
	injectSpawnErrataGate,
	isReviewClassSpawnPrompt,
	SPAWN_ERRATA_GATE_CUSTOM_TYPE,
} from "../../../src/modes/daemon/spawn-errata-gate.js";
import { createHarness, type Harness } from "../harness.js";

describe("W14-B spawn errata gate classifier", () => {
	it("flags review-class task prompts", () => {
		expect(isReviewClassSpawnPrompt("【W14-A】复审 daemon 启动路径的恢复分支")).toBe(true);
		expect(isReviewClassSpawnPrompt("审查 packages/ai 的 retry 逻辑")).toBe(true);
		expect(isReviewClassSpawnPrompt("复核上周的幻觉链结论是否仍然成立")).toBe(true);
		expect(isReviewClassSpawnPrompt("立项调查错链问题")).toBe(true);
		expect(isReviewClassSpawnPrompt("Review the auth storage changes")).toBe(true);
		expect(isReviewClassSpawnPrompt("re-review the compaction fix")).toBe(true);
		expect(isReviewClassSpawnPrompt("audit the compaction pipeline")).toBe(true);
	});

	it("does not flag ordinary build/fix tasks", () => {
		expect(isReviewClassSpawnPrompt("fix the typo in preview.ts")).toBe(false);
		expect(isReviewClassSpawnPrompt("实现一个新的设置面板")).toBe(false);
		expect(isReviewClassSpawnPrompt("run the test suite and report failures")).toBe(false);
		// "preview" must not trip the English review keyword.
		expect(isReviewClassSpawnPrompt("check the preview rendering")).toBe(false);
	});
});

describe("W14-B spawn errata gate text", () => {
	it("carries the mandatory read-the-ledger line and the evidence requirement", () => {
		const text = buildSpawnErrataGateText();
		expect(text).toContain("docs/fork/evolution-ledger.md");
		expect(text).toContain("勘误");
		expect(text).toContain("立项");
	});
});

describe("W14-B spawn errata gate injection", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function seedLedger(cwd: string): void {
		const forkDocs = join(cwd, "docs", "fork");
		mkdirSync(forkDocs, { recursive: true });
		writeFileSync(join(forkDocs, "evolution-ledger.md"), "# 演化账本\n");
	}

	it("injects the gate into a review-class child session's next turn", async () => {
		const child = await createHarness();
		harnesses.push(child);
		seedLedger(child.tempDir);

		const injected = await injectSpawnErrataGate(child.session, "复审 daemon 启动路径", child.tempDir);
		expect(injected).toBe(true);

		const pending = child.session.getPendingNextTurnMessageSnapshots();
		const gate = pending.find((message) => message.customType === SPAWN_ERRATA_GATE_CUSTOM_TYPE);
		expect(gate).toBeDefined();
		const text = typeof gate!.content === "string" ? gate!.content : "";
		expect(text).toContain("docs/fork/evolution-ledger.md");
	});

	it("reaches the provider on the child's first turn", async () => {
		const child = await createHarness();
		harnesses.push(child);
		seedLedger(child.tempDir);
		await injectSpawnErrataGate(child.session, "复审 daemon 启动路径", child.tempDir);

		let captured: Context | undefined;
		child.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("已查台账");
			},
		]);
		await child.session.prompt("[task from parent]\n\n复审 daemon 启动路径");

		const wire = JSON.stringify(captured?.messages ?? []);
		// customType stays on the transcript; the wire carries the gate's text.
		expect(wire).toContain("组织记忆硬门");
		expect(wire).toContain("evolution-ledger.md");
	});

	it("skips non-review prompts", async () => {
		const child = await createHarness();
		harnesses.push(child);
		seedLedger(child.tempDir);

		const injected = await injectSpawnErrataGate(child.session, "实现设置面板", child.tempDir);
		expect(injected).toBe(false);
		expect(child.session.getPendingNextTurnMessageSnapshots()).toHaveLength(0);
	});

	it("skips review prompts in repos without the ledger", async () => {
		const child = await createHarness();
		harnesses.push(child);
		// No docs/fork/evolution-ledger.md under this cwd.
		const injected = await injectSpawnErrataGate(child.session, "复审 daemon 启动路径", child.tempDir);
		expect(injected).toBe(false);
		expect(child.session.getPendingNextTurnMessageSnapshots()).toHaveLength(0);
	});
});
