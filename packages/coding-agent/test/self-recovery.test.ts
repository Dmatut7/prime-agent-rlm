import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AUTO_CONTINUE_CUSTOM_TYPE, createAutoContinueMessage } from "../src/core/messages.js";
import {
	announcedNextStep,
	completionClaimWithoutEvidence,
	createOutputTruncatedContinueMessage,
	createProviderFailureRecoveryMessage,
	dutyEventFor,
	FINISH_GATE_MAX_STRIKES,
	finishGateStrikesInRun,
	lastUserPromptText,
	PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE,
	runHasVerificationEvidence,
} from "../src/core/self-recovery.js";

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("announcedNextStep", () => {
	it.each([
		"第一个文件看完了，接下来我去改第二个文件",
		"已经定位到原因。下一步：修改 footer.ts 并跑测试",
		"现在我来跑一遍测试",
		"测试都过了。接下来我把文档也更新一下。",
		"Found it. Let me fix the parser next.",
		"Done with step one. I'll now update the tests:",
		"进度：\n- [x] 读代码\n- [ ] 改代码\n- [ ] 跑测试",
	])("reads %j as an announced next step", (text) => {
		expect(announcedNextStep(reply(text))).toBeDefined();
	});

	it.each([
		"改好了，所有测试都通过。",
		"结论：配置里的端口写错了，改成 8080 即可。",
		"要不要我接下来把测试也补上？",
		"子代理已派出，等待子代理回复。",
		"待命。",
		"改好了，测试全部通过。接下来我可以帮你把文档也补上。",
		"结论如上。如需要，我再把脚本整理成命令。",
		"Fixed and verified. If you want, I can also add a regression test.",
		"All tests pass. I'll push to origin/main once you approve.",
		"I will run it against production after your go-ahead.",
		"I'll wait for your confirmation before deleting the old branch.",
		"Rewritten history is ready; I will not force-push until you say so.",
		"测试都过了。我会在你批准后推送到 main。",
		"迁移脚本写好了，你确认后我就对生产库执行。",
		"旧分支清单列好了，等你点头我再删。",
		"- self-recovery.ts：检测三类故障（工具步骤卡死、刚宣布还有下一步就停轮、子代理干完活不回话），每个动作落成会话条目供 duty-log 事后汇报。",
		"Should I also update the docs?",
		"I checked the plan; everything below is done and verified.",
	])("leaves %j alone", (text) => {
		expect(announcedNextStep(reply(text))).toBeUndefined();
	});

	// Each misfire costs the owner a paid turn and a false "提早停下" duty-log line; each miss leaves
	// an unattended run parked on a plan it never carried out.
	it.each([
		["a past-tense report after 我先/然后我", "我先检查了日志，然后我修改了配置文件。"],
		["a finished answer that says 现在我已经", "全部完成。现在我已经把所有测试跑通了。"],
		["a summary that follows 让我总结一下", "所有步骤都完成了。让我总结一下：改了三个文件。"],
		["the owner's own to-do list", "- [ ] 配置 API key"],
		["an owner to-do list with its intro", "代码已经改好。你需要自己完成：\n- [ ] 配置 API key\n- [ ] 重启服务"],
		["a step the owner takes next", "迁移脚本写好了。接下来你需要在服务器上执行它。"],
		["a future tense that promises no work", "I will keep this in mind."],
		["an English summary", "All done. Let me summarize: three files changed."],
		["the owner's next step in English", "The patch is in. Next step is for you to run the migration."],
	])("does not misfire on %s", (_name, text) => {
		expect(announcedNextStep(reply(text))).toBeUndefined();
	});

	it.each([
		["a plan with a self-check", "我先跑一下测试，看看是否需要进一步修改。"],
		["a plan with no pronoun", "开始修复这个问题。"],
		["an English next step", "Next step is updating the docs."],
		["a plan whose steps follow a colon", "定位好了。接下来我会：\n1. 改 footer.ts\n2. 跑测试"],
		["a plan that mentions an earlier past step", "日志看完了，接下来我去改配置。"],
	])("catches %s", (_name, text) => {
		expect(announcedNextStep(reply(text))).toBeDefined();
	});

	it("only looks at a clean stop", () => {
		expect(announcedNextStep(reply("接下来我去改第二个文件", "length"))).toBeUndefined();
		expect(announcedNextStep(reply("接下来我去改第二个文件", "aborted"))).toBeUndefined();
	});

	it("excerpts the announcing line", () => {
		expect(announcedNextStep(reply("分析如下。\n\n接下来我去改第二个文件"))).toBe("接下来我去改第二个文件");
	});

	describe("with tool work on the books", () => {
		// A turn that ran tools and then parks on a question or an offer leaves the
		// unattended run half done, so those two exemptions stop applying; waits and
		// owner-approval gates stay exempt - nudging past them would run gated work.
		it.each([
			"第一个文件看完了，接下来我改第二个文件，可以吗？",
			"改好了，测试全部通过。接下来我可以帮你把文档也补上。",
			"Fixed one file. Next I will update the other, ok?",
		])("no longer exempts the question or offer in %j", (text) => {
			expect(announcedNextStep(reply(text), { ranTools: true })).toBeDefined();
			// Without the tool-work fact the same reply stays a finished answer.
			expect(announcedNextStep(reply(text))).toBeUndefined();
		});

		it.each([
			["an approval gate", "测试都过了。我会在你批准后推送到 main。"],
			["waiting on children", "子代理已派出，等待子代理回复。"],
			["an owner decision ask", "改之前要不要我先备份？"],
			["a final answer", "两个文件都改好了，结论是配置写错了。"],
		])("still leaves %s alone", (_name, text) => {
			expect(announcedNextStep(reply(text), { ranTools: true })).toBeUndefined();
		});
	});
});

describe("dutyEventFor", () => {
	it("maps every self-recovery action to the duty-log event", () => {
		expect(
			dutyEventFor({
				kind: "stuck_step_stopped",
				toolCallId: "t",
				toolName: "ipython",
				step: "sleep 999",
				silentMs: 300_000,
				repeated: false,
				at: 1,
			}),
		).toEqual({ kind: "step_stuck_stopped", tool: "sleep 999", silentMs: 300_000 });
		expect(dutyEventFor({ kind: "auto_continue", excerpt: "接下来我去改", ordinal: 1, at: 1 })).toEqual({
			kind: "auto_continue",
			reason: "接下来我去改",
		});
		expect(dutyEventFor({ kind: "child_reply_nudge", at: 1 })).toEqual({
			kind: "auto_continue",
			reason: "child_reply_missing",
		});
	});
});

describe("createOutputTruncatedContinueMessage", () => {
	it("asks the model to resume, counts into the shared auto-continue budget", () => {
		const message = createOutputTruncatedContinueMessage(
			{ reason: "output_truncated", ordinal: 2, maxOrdinal: 4 },
			7,
		);
		expect(message.customType).toBe(AUTO_CONTINUE_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.timestamp).toBe(7);
		const content = String(message.content);
		expect(content).toContain('stopReason: "length"');
		expect(content).toContain("Continue from where you stopped");
		expect(content).toContain("2 of at most 4");
	});
});

describe("createAutoContinueMessage", () => {
	it("names the configured per-prompt budget instead of a hardcoded cap", () => {
		const message = createAutoContinueMessage(
			{ reason: "announced_next_step", excerpt: "接下来我去改", ordinal: 2, maxOrdinal: 4 },
			7,
		);
		expect(message.customType).toBe(AUTO_CONTINUE_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.timestamp).toBe(7);
		const content = String(message.content);
		expect(content).toContain("2 of at most 4");
		expect(content).not.toContain("of at most 2");
	});

	it("keeps the child-reply nudge a one-shot with no budget wording", () => {
		const message = createAutoContinueMessage({ reason: "child_reply_missing", ordinal: 1, maxOrdinal: 1 });
		const content = String(message.content);
		expect(content).toContain("parent");
		expect(content).not.toContain("of at most");
	});
});

describe("createProviderFailureRecoveryMessage", () => {
	it("carries the failure shape and the one-shot notice", () => {
		const message = createProviderFailureRecoveryMessage(
			{
				attempts: 3,
				waitClass: "permanent",
				errorMessage: "overloaded_error",
				provider: "faux",
				model: "faux-1",
			},
			9,
		);
		expect(message.customType).toBe(PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		const content = String(message.content);
		expect(content).toContain("attempts: 3");
		expect(content).toContain("class: permanent");
		expect(content).toContain("faux/faux-1");
		expect(content).toContain("overloaded_error");
		expect(content).toContain("one-shot");
	});

	it("truncates a very long error message", () => {
		const message = createProviderFailureRecoveryMessage({
			attempts: 1,
			waitClass: "transient",
			errorMessage: "x".repeat(1000),
		});
		expect(String(message.content).length).toBeLessThan(2000);
	});
});

/** Helpers for the finish-gate tests: the run shapes the gate reads. */
function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function toolCallMessage(id: string, command: string): AssistantMessage {
	return {
		...reply(""),
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name: "run_command", arguments: { command } }],
	};
}

function toolResultMessage(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "run_command",
		content: [{ type: "text", text: "output" }],
		isError,
		timestamp: 0,
	};
}

/** An ipython REPL cell call: the command hides inside Python code, so the cell's own text is the only proof. */
function cellCallMessage(id: string, code: string): AssistantMessage {
	return {
		...reply(""),
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }],
	};
}

function cellResultMessage(
	toolCallId: string,
	text: string,
	isError = false,
	fileChanges?: { scope: string }[],
	changeTrackingIncomplete?: string,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [{ type: "text", text }],
		details: {
			...(fileChanges ? { fileChanges } : {}),
			...(changeTrackingIncomplete ? { changeTrackingIncomplete } : {}),
		},
		isError,
		timestamp: 0,
	};
}

function editCallMessage(id: string): AssistantMessage {
	return {
		...reply(""),
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name: "edit", arguments: { path: "a.ts", oldText: "x", newText: "y" } }],
	};
}

function editResultMessage(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "edit",
		content: [{ type: "text", text: "edited a.ts" }],
		isError,
		timestamp: 0,
	};
}

function finishGateNudge(): AgentMessage {
	return {
		role: "custom",
		customType: AUTO_CONTINUE_CUSTOM_TYPE,
		content: "[finish gate] ...",
		display: true,
		details: { reason: "finish_gate", excerpt: "修好了", ordinal: 1, maxOrdinal: 4 },
		timestamp: 0,
	};
}

describe("completionClaimWithoutEvidence", () => {
	it.each([
		"修好了。",
		"两个文件都改完了。",
		"已全部完成。",
		"搞定了，一共三处。",
		"Done.",
		"Fixed the parser.",
		"All done - the migration is in.",
	])("gates the bare claim %j after tool work", (text) => {
		expect(completionClaimWithoutEvidence(reply(text), { ranTools: true })).toBeDefined();
	});

	it.each([
		["a claim that cites the test run", "修好了，测试全部通过。"],
		["a claim that cites the count", "Fixed - 47 tests passed."],
		["a claim that cites a clean exit", "构建完成，exit code 0。"],
		["a claim that cites the finished verification", "Verification passed: all 8 keys match sources. DONE"],
		["a claim that cites the completed proof", "Proof complete: every value is backed by its source line. DONE"],
		["a plain result, not a completion claim", "测试通过。"],
		["an answer with no claim at all", "结论：配置里的端口写错了，改成 8080 即可。"],
		["a wait for approval", "已全部完成，等你确认后我再推送。"],
		["a wait for children", "子代理已派出，等待子代理回复。"],
	])("leaves %s alone", (_name, text) => {
		expect(completionClaimWithoutEvidence(reply(text), { ranTools: true })).toBeUndefined();
	});

	it("gates a claim on a task prompt even when no tool ever ran", () => {
		expect(
			completionClaimWithoutEvidence(reply("修好了。"), { ranTools: false, promptText: "修复这个 bug" }),
		).toBeDefined();
		expect(
			completionClaimWithoutEvidence(reply("Done."), { ranTools: false, promptText: "fix the footer" }),
		).toBeDefined();
	});

	it("never gates pure chat, whatever it says", () => {
		expect(
			completionClaimWithoutEvidence(reply("搞定了。"), { ranTools: false, promptText: "你好" }),
		).toBeUndefined();
		expect(
			completionClaimWithoutEvidence(reply("all done"), { ranTools: false, promptText: "what does this do?" }),
		).toBeUndefined();
		expect(completionClaimWithoutEvidence(reply("完成了。"), { ranTools: false })).toBeUndefined();
	});

	it("keeps the question/offer exemption for a tool-free turn, drops it after tool work", () => {
		const text = "修好了，要我再跑一遍吗？";
		expect(
			completionClaimWithoutEvidence(reply(text), { ranTools: false, promptText: "修复这个 bug" }),
		).toBeUndefined();
		expect(completionClaimWithoutEvidence(reply(text), { ranTools: true })).toBeDefined();
	});

	it("accepts the proof the transcript already carries", () => {
		expect(completionClaimWithoutEvidence(reply("修好了。"), { ranTools: true, verifiedWork: true })).toBeUndefined();
	});

	// The claim scan reads the sentence the reply ends on, not the whole text: an
	// analysis answer that mentions "fixed"/"implemented" mid-reply is reporting
	// history, not declaring the task done.
	it.each([
		[
			"a Chinese history report that mentions 修好了 mid-text",
			"查了一下历史：这个 bug 上个版本有人修好了，后来又被回滚。根因是配置覆盖顺序。",
		],
		[
			"an English analysis that mentions fixed/implemented mid-text",
			"I traced the history: the parser was fixed in March and the fix was reverted. The actual cause is the option merge order.",
		],
		[
			"a report whose closing sentence is a plain conclusion",
			"这轮改动 implemented the cache layer in cache.ts, without touching the interface. 结论是行为完全不变。",
		],
	])("leaves %s alone", (_name, text) => {
		expect(completionClaimWithoutEvidence(reply(text), { ranTools: true })).toBeUndefined();
	});

	it("still gates a bare claim that closes the reply", () => {
		expect(
			completionClaimWithoutEvidence(reply("查了三个文件，都核对过一遍。修好了。"), { ranTools: true }),
		).toBeDefined();
	});

	it("lets evidence cited earlier in the reply back the closing claim", () => {
		expect(completionClaimWithoutEvidence(reply("47 tests passed.\n\nDone."), { ranTools: true })).toBeUndefined();
	});

	it("only looks at a clean stop with no pending tool call", () => {
		expect(completionClaimWithoutEvidence(reply("修好了。", "length"), { ranTools: true })).toBeUndefined();
		expect(completionClaimWithoutEvidence(toolCallMessage("t1", "npm test"), { ranTools: true })).toBeUndefined();
	});
});

describe("runHasVerificationEvidence", () => {
	it("counts a green test or build command as proof", () => {
		for (const command of ["npm test", "npm run check", "pytest -q", "make build", "tsc --noEmit", "go test ./..."]) {
			expect(
				runHasVerificationEvidence([userMessage("go"), toolCallMessage("t1", command), toolResultMessage("t1")]),
				command,
			).toBe(true);
		}
	});

	it("ignores commands that verify nothing, failed runs and other runs", () => {
		expect(
			runHasVerificationEvidence([userMessage("go"), toolCallMessage("t1", "sleep 999"), toolResultMessage("t1")]),
		).toBe(false);
		// A failed test run is not proof.
		expect(
			runHasVerificationEvidence([
				userMessage("go"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1", true),
			]),
		).toBe(false);
		// A green run from before the current prompt belongs to that run, not this one.
		expect(
			runHasVerificationEvidence([
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1"),
				userMessage("now the docs"),
				reply("改完了"),
			]),
		).toBe(false);
		expect(runHasVerificationEvidence([userMessage("hi"), reply("hello")])).toBe(false);
	});

	it("does not count a REPL cell whose check failed - the cell itself finished fine", () => {
		// The hole: `r = await bash('npm test')` leaves the ipython cell clean whether
		// the tests passed or not, so a red run used to read as proof.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nprint(r.output)"),
				cellResultMessage("t1", "2 failed, 47 passed"),
			]),
		).toBe(false);
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nprint(r)"),
				cellResultMessage("t1", "BashResult(exit_code=1, output='...', duration=2.1)"),
			]),
		).toBe(false);
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nprint(r.exit_code)"),
				cellResultMessage("t1", "1"),
			]),
		).toBe(false);
	});

	it("counts a cell only when its own output carries the proof", () => {
		const proven: [string, string][] = [
			["a zero exit code", "exit_code=0"],
			["the runner's pass wording", "===== 47 passed in 1.2s ====="],
			["the bare print of r.exit_code", "0"],
			["a go test package line", "ok  \texample.com/mod\t0.3s"],
		];
		expect(proven.length).toBeGreaterThan(0);
		for (const [name, output] of proven) {
			expect(
				runHasVerificationEvidence([
					userMessage("fix it"),
					cellCallMessage("t1", "r = await bash('npm test')\nprint(r)"),
					cellResultMessage("t1", output),
				]),
				name,
			).toBe(true);
		}
		// A cell that ran the check but showed nothing proves nothing.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')"),
				cellResultMessage("t1", ""),
			]),
		).toBe(false);
		// A cell that asserts the exit code proves the run by finishing clean; the
		// same assert failing would have errored the cell instead.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nassert r.exit_code == 0, r.output"),
				cellResultMessage("t1", ""),
			]),
		).toBe(true);
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nassert r.exit_code == 0, r.output"),
				cellResultMessage("t1", "AssertionError: ...", true),
			]),
		).toBe(false);
	});

	it("voids the green run when a later check comes back red", () => {
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1"),
				toolCallMessage("t2", "npm test"),
				toolResultMessage("t2", true),
				reply("还是没过"),
			]),
		).toBe(false);
		// A later green after the red restores the proof.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1", true),
				toolCallMessage("t2", "npm test"),
				toolResultMessage("t2"),
			]),
		).toBe(true);
	});

	it("voids the green run when files changed afterwards", () => {
		const green = [userMessage("fix it"), toolCallMessage("t1", "npm test"), toolResultMessage("t1")];
		// An edit after the pass makes it stale.
		expect(
			runHasVerificationEvidence([...green, editCallMessage("e1"), editResultMessage("e1"), reply("改完了")]),
		).toBe(false);
		// A failed edit changed nothing - the pass still stands.
		expect(
			runHasVerificationEvidence([...green, editCallMessage("e1"), editResultMessage("e1", true), reply("改完了")]),
		).toBe(true);
		// A project file change from a later cell voids the pass; a scratch write does not.
		expect(
			runHasVerificationEvidence([
				...green,
				cellCallMessage("c1", "open('src/a.ts', 'w').write('x')"),
				cellResultMessage("c1", "", false, [{ scope: "project" }]),
				reply("改完了"),
			]),
		).toBe(false);
		expect(
			runHasVerificationEvidence([
				...green,
				cellCallMessage("c1", "open('/tmp/note.txt', 'w').write('x')"),
				cellResultMessage("c1", "", false, [{ scope: "scratch" }]),
				reply("记完了"),
			]),
		).toBe(true);
		// The cell that runs the check does not void itself when the run writes
		// project files (a coverage report): the change predates the verdict.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test -- --coverage')\nprint(r.exit_code)"),
				cellResultMessage("t1", "0", false, [{ scope: "project" }]),
			]),
		).toBe(true);
		// Verifying again after the edit restores the proof.
		expect(
			runHasVerificationEvidence([
				...green,
				editCallMessage("e1"),
				editResultMessage("e1"),
				toolCallMessage("t2", "npm test"),
				toolResultMessage("t2"),
			]),
		).toBe(true);
	});

	it("voids the green run when a shell command writes files afterwards", () => {
		// A classic shell tool's result carries no tracked change list (tracking lives
		// in the REPL kernel), so the command text is the only evidence of the write.
		const green = [userMessage("fix it"), toolCallMessage("t1", "npm test"), toolResultMessage("t1")];
		const writes = [
			"sed -i '' 's/a/b/' src/a.ts",
			"sed -i.bak 's/a/b/' src/a.ts",
			"echo patch >> src/a.ts",
			"cat patch.diff > src/a.ts",
			"cp src/a.ts src/b.ts",
			"mv src/a.ts src/b.ts",
			"rm src/old.ts",
			"tee src/a.ts",
			"touch src/new.ts",
			"git checkout -- src/a.ts",
			"git apply fix.diff",
			// Archives and downloads are the model's other high-frequency write paths
			// (iteration review 58): unpacking or downloading into cwd overwrites
			// project files the earlier green run never saw.
			"unzip bundle.zip",
			"tar -xzf bundle.tar.gz",
			"tar -Jxf bundle.tar.xz",
			"tar xzf bundle.tar.gz",
			"tar xf bundle.tar",
			"tar x bundle.tar",
			"tar --extract -f bundle.tar",
			"gunzip data.json.gz",
			"gzip -d data.json.gz",
			"zip -d bundle.zip stale.js",
			"7z x bundle.7z",
			"curl -o config.json https://example.com/config.json",
			"curl -sL https://example.com/x -O",
			"wget -O data.csv https://example.com/data.csv",
			"wget --output-document=data.csv https://example.com/data.csv",
		];
		expect(writes.length).toBeGreaterThan(0);
		for (const command of writes) {
			expect(
				runHasVerificationEvidence([
					...green,
					toolCallMessage("w1", command),
					toolResultMessage("w1"),
					reply("改完了"),
				]),
				command,
			).toBe(false);
		}
		// Read-only commands leave the pass standing.
		const reads = [
			"grep -r foo src/",
			"cat src/a.ts",
			"git status",
			"git diff --stat",
			"npm test 2>&1 | tail -5",
			// Listing an archive or streaming one to stdout writes nothing; neither
			// does archive creation or a download kept off disk.
			"tar -tf bundle.tar",
			"tar -tvf bundle.tar",
			"tar -cf out.tar src/",
			"gzip -l data.json.gz",
			"curl -s https://example.com/config.json",
			"wget -q -O- https://example.com/data.csv",
		];
		expect(reads.length).toBeGreaterThan(0);
		for (const command of reads) {
			expect(
				runHasVerificationEvidence([
					...green,
					toolCallMessage("w1", command),
					toolResultMessage("w1"),
					reply("改完了"),
				]),
				command,
			).toBe(true);
		}
		// A failed write command proves nothing either way; the pass stands.
		expect(
			runHasVerificationEvidence([
				...green,
				toolCallMessage("w1", "sed -i '' 's/a/b/' src/a.ts"),
				toolResultMessage("w1", true),
				reply("改完了"),
			]),
		).toBe(true);
	});

	it("does not read a cell's code as a shell command - the tracked changes are its ground truth", () => {
		// `>` in Python is a comparison, not a redirect: a cell with no tracked
		// project change keeps the pass.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1"),
				cellCallMessage("c1", "x = 1 > 2\nprint(x)"),
				cellResultMessage("c1", "False"),
				reply("改完了"),
			]),
		).toBe(true);
	});

	it("counts a cell's tracked writes even when the cell errored after writing", () => {
		// The write landed before the error did; an error result only means the edit
		// tool's no-op case, never a cell's.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1"),
				cellCallMessage("c1", "open('src/a.ts', 'w').write('x')\n1/0"),
				cellResultMessage("c1", "ZeroDivisionError", true, [{ scope: "project" }]),
				reply("改完了"),
			]),
		).toBe(false);
	});

	it("does not trust the green run when change tracking says it is incomplete", () => {
		const green = [userMessage("fix it"), toolCallMessage("t1", "npm test"), toolResultMessage("t1")];
		// A later cell whose change list is partial may hold the write that voids the
		// pass; the gate reads incomplete as a change.
		expect(
			runHasVerificationEvidence([
				...green,
				cellCallMessage("c1", "x = 1"),
				cellResultMessage("c1", "", false, undefined, "time budget used up"),
				reply("改完了"),
			]),
		).toBe(false);
		// The cell that ran the check re-proves itself: the verdict comes from its own
		// output, and its own writes are forgiven by the coverage rule either way.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("t1", "r = await bash('npm test')\nprint(r.exit_code)"),
				cellResultMessage("t1", "0", false, undefined, "time budget used up"),
			]),
		).toBe(true);
		// Incomplete tracking before the green run says nothing about what came after.
		expect(
			runHasVerificationEvidence([
				userMessage("fix it"),
				cellCallMessage("c1", "x = 1"),
				cellResultMessage("c1", "", false, undefined, "time budget used up"),
				toolCallMessage("t1", "npm test"),
				toolResultMessage("t1"),
			]),
		).toBe(true);
	});
});

describe("finishGateStrikesInRun", () => {
	it("counts consecutive gate nudges up to the release point", () => {
		expect(finishGateStrikesInRun([userMessage("fix it"), reply("修好了。")])).toBe(0);
		expect(
			finishGateStrikesInRun([userMessage("fix it"), reply("修好了。"), finishGateNudge(), reply("好了。")]),
		).toBe(1);
		const twice = [
			userMessage("fix it"),
			reply("修好了。"),
			finishGateNudge(),
			reply("好了。"),
			finishGateNudge(),
			reply("真的好了。"),
		];
		expect(finishGateStrikesInRun(twice)).toBe(FINISH_GATE_MAX_STRIKES);
	});

	it("keeps counting through tool work after a nudge - only a green verification clears the claim", () => {
		// The escape chain: a tool result after the last nudge used to restart the
		// count, so "run the check, watch it come back red, claim done anyway" was
		// nudged forever and never reached the release record. Tool work no longer
		// resets the count, and a red check is not evidence either way.
		const adversarial = [
			userMessage("fix it"),
			reply("修好了。"),
			finishGateNudge(),
			toolCallMessage("t1", "npm test"),
			toolResultMessage("t1", true), // the check ran red
			reply("搞定了。"),
			finishGateNudge(),
			toolCallMessage("t2", "npm test"),
			toolResultMessage("t2", true),
			reply("全部完成。"),
		];
		expect(finishGateStrikesInRun(adversarial)).toBe(FINISH_GATE_MAX_STRIKES);
		// Even a green verification-shaped result leaves the count alone: the claim
		// after it is simply never flagged (verifiedWork), so the old reset only
		// ever fired for a run the claim scan had already cleared.
		expect(
			finishGateStrikesInRun([
				userMessage("fix it"),
				reply("修好了。"),
				finishGateNudge(),
				toolCallMessage("t3", "npm test"),
				toolResultMessage("t3"),
				reply("修好了，测试全部通过。"),
			]),
		).toBe(1);
	});

	it("ignores other automatic continues", () => {
		const announced: AgentMessage = {
			role: "custom",
			customType: AUTO_CONTINUE_CUSTOM_TYPE,
			content: "[auto-continue] ...",
			display: true,
			details: { reason: "announced_next_step", excerpt: "接下来", ordinal: 1, maxOrdinal: 4 },
			timestamp: 0,
		};
		expect(finishGateStrikesInRun([userMessage("fix it"), announced, reply("修好了。")])).toBe(0);
	});
});

describe("lastUserPromptText", () => {
	it("reads the last user message, string or blocks", () => {
		expect(lastUserPromptText([userMessage("first"), reply("mid"), userMessage("修复这个")])).toBe("修复这个");
		expect(
			lastUserPromptText([{ role: "user", content: [{ type: "text", text: "fix the footer" }], timestamp: 0 }]),
		).toBe("fix the footer");
		expect(lastUserPromptText([reply("no prompt here")])).toBeUndefined();
	});
});

describe("finish-gate message and records", () => {
	it("asks for the proof and counts into the shared budget", () => {
		const message = createAutoContinueMessage(
			{ reason: "finish_gate", excerpt: "修好了", ordinal: 2, maxOrdinal: 4 },
			7,
		);
		expect(message.customType).toBe(AUTO_CONTINUE_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		const content = String(message.content);
		expect(content).toContain("[finish gate]");
		expect(content).toContain('"修好了"');
		expect(content).toContain("2 of at most 4");
		expect(content).toContain("do not re-run a check that already passed");
		expect(content).toContain("a check only stays passed while the code it covered stays unchanged");
		expect(content).toContain("a citation without the verdict reads as no proof");
	});

	it("maps a gate release to a decision the owner sees", () => {
		expect(dutyEventFor({ kind: "finish_gate_released", excerpt: "修好了", strikes: 2, ordinal: 3, at: 1 })).toEqual({
			kind: "decision_needed",
			question: "AI 声称完成但 2 次拿不出验证证据，已放行，结论待你核对",
		});
	});

	it("maps a budget-exhausted release to its own wording", () => {
		expect(
			dutyEventFor({
				kind: "finish_gate_released",
				excerpt: "修好了",
				strikes: 1,
				ordinal: 2,
				cause: "budget_exhausted",
				at: 1,
			}),
		).toEqual({
			kind: "decision_needed",
			question: "AI 声称完成，续跑预算耗尽（已追问 1 次）仍无验证证据，已放行，结论待你核对",
		});
	});
});
