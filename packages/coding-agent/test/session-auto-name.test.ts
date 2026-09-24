import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAutonameCommand } from "../src/cli/autoname-command.js";
import { ENV_AGENT_DIR, getSessionsDir } from "../src/config.js";
import {
	autoNameForInbound,
	deriveAutoSessionName,
	firstInboundSourceFromMessages,
	inboundNameSource,
	sanitizeRefinedTitle,
	scanFirstInboundSource,
	scanLastSessionInfoEntry,
	scanSessionNamingFacts,
	stripAgentMessageEnvelope,
	uniquifyAutoName,
} from "../src/core/session-auto-name.js";
import { SessionManager } from "../src/core/session-manager.js";

const LONG_CHINESE =
	"修复 water-ops 后端缺陷（plantree #209 遗留项）：非目标用户读取「定向公告」详情时，接口返回了越权数据";

describe("deriveAutoSessionName", () => {
	it("keeps short titles verbatim", () => {
		expect(deriveAutoSessionName("水务-夜班总指挥")).toBe("水务-夜班总指挥");
	});

	it("caps at 32 code points with an ellipsis for CJK text", () => {
		const name = deriveAutoSessionName(LONG_CHINESE);
		expect(name?.endsWith("\u2026")).toBe(true);
		expect(Array.from(name ?? "").length).toBe(33);
	});

	it("takes the first meaningful line, skipping fences and blanks", () => {
		expect(deriveAutoSessionName("\n```\n\n  查最近的记忆线程  \n```")).toBe("查最近的记忆线程");
	});

	it("strips blockquote markers", () => {
		expect(deriveAutoSessionName("> 转发一条线索")).toBe("转发一条线索");
	});

	it("collapses whitespace", () => {
		expect(deriveAutoSessionName("检查\t所有调研工具   的工作状态")).toBe("检查 所有调研工具 的工作状态");
	});

	it("relocates a bare absolute path to its basename", () => {
		expect(deriveAutoSessionName("/Users/laicai/Library/Containers/com.tencent.xinWeChat/Data")).toBe("Data");
	});

	it("relocates a pasted path that carries trailing prose", () => {
		expect(deriveAutoSessionName("/Users/laicai/Library/Containers/wxid/temp/88571acb.png 你去帮我优化")).toBe(
			"88571acb.png",
		);
	});

	it("relocates a bare URL to host plus last segment", () => {
		expect(deriveAutoSessionName("https://github.com/badlogic/pi-mono/issues/4603")).toBe("github.com/4603");
	});

	it("refuses uuid-like and empty input", () => {
		expect(deriveAutoSessionName("01a0c39e-6819-74eb-aa9f-1fc21ea8670a")).toBeUndefined();
		expect(deriveAutoSessionName("   \n  ")).toBeUndefined();
	});
});

describe("inboundNameSource", () => {
	it("reads user text content", () => {
		expect(inboundNameSource({ role: "user", content: "hi there" })).toBe("hi there");
		expect(inboundNameSource({ role: "user", content: [{ type: "text", text: "block text" }] })).toBe("block text");
	});

	it("reads the raw agent-message payload from details", () => {
		expect(
			inboundNameSource({
				role: "custom",
				customType: "agent_message",
				content: "[from parent]\nAgent-to-agent message received.\n\npayload body",
				details: { message: "payload body" },
			}),
		).toBe("payload body");
	});

	it("falls back to envelope stripping when details are absent", () => {
		expect(stripAgentMessageEnvelope("[from parent]\nAgent-to-agent message received.\n\npayload body")).toBe(
			"payload body",
		);
	});

	it("ignores non-naming custom types", () => {
		expect(inboundNameSource({ role: "custom", customType: "harness_digest", content: "digest" })).toBeUndefined();
	});
});

describe("sanitizeRefinedTitle", () => {
	it("cleans quotes and takes the first line", () => {
		expect(sanitizeRefinedTitle('"水务公告越权修复"\nsecond line')).toBe("水务公告越权修复");
	});

	it("refuses prose-length answers", () => {
		expect(sanitizeRefinedTitle("x".repeat(41))).toBeUndefined();
	});

	it("refuses empty output", () => {
		expect(sanitizeRefinedTitle("  \n ")).toBeUndefined();
	});
});

describe("autoNameForInbound", () => {
	const message = { role: "user", content: "查最近的记忆线程" };

	it("stays off when disabled", () => {
		expect(autoNameForInbound({ mode: "off", currentName: undefined, message })).toBeUndefined();
	});

	it("never renames an already named session", () => {
		expect(autoNameForInbound({ mode: "llm", currentName: "人工名", message })).toBeUndefined();
	});

	it("derives an auto name from the inbound message", () => {
		expect(autoNameForInbound({ mode: "llm", currentName: undefined, message })).toEqual({
			name: "查最近的记忆线程",
			auto: true,
		});
	});

	it("prefers the disk origin over the resuming message", () => {
		expect(
			autoNameForInbound({
				mode: "llm",
				currentName: undefined,
				message: { role: "user", content: "继续" },
				diskSource: "最初的任務描述",
			})?.name,
		).toBe("最初的任務描述");
	});

	it("refuses low-information acknowledgements as names", () => {
		expect(deriveAutoSessionName("继续")).toBeUndefined();
		expect(deriveAutoSessionName("ok")).toBeUndefined();
		expect(deriveAutoSessionName("好")).toBeUndefined();
	});
});

describe("transcript provenance", () => {
	it("records and reads the auto flag, last entry wins", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-autoname-prov-"));
		mkdirSync(join(tempDir, "sessions"), { recursive: true });
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		expect(manager.getSessionNameInfo()).toBeUndefined();
		manager.appendSessionInfo("自动名", { auto: true });
		expect(manager.getSessionNameInfo()).toEqual({ name: "自动名", auto: true });
		manager.appendSessionInfo("人工名");
		expect(manager.getSessionNameInfo()).toEqual({ name: "人工名", auto: false });
	});

	it("old-shape readers still read entries carrying the auto key", () => {
		// Simulates a transcript written by this build being parsed by code that
		// only knows { type, id, parentId, timestamp, name }.
		const tempDir = mkdtempSync(join(tmpdir(), "prime-autoname-old-"));
		mkdirSync(join(tempDir, "sessions"), { recursive: true });
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		manager.appendSessionInfo("自动名", { auto: true });
		const raw = readFileSync(manager.getSessionFile()!, "utf8");
		expect(raw).toContain('"auto":true');
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getSessionName()).toBe("自动名");
		const entryLine = raw
			.split("\n")
			.filter((line) => line.includes('"session_info"'))
			.at(-1);
		const legacyView = JSON.parse(entryLine ?? "{}") as { name?: string };
		expect(legacyView.name).toBe("自动名");
	});
});

describe("disk scans", () => {
	it("scans the first inbound source past harness noise", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-autoname-scan-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
				JSON.stringify({ type: "custom_message", customType: "harness_digest", content: "digest noise" }),
				JSON.stringify({
					type: "custom_message",
					customType: "agent_message",
					content: "envelope",
					details: { message: "广播触发正文" },
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "后来的人话" } }),
			].join("\n")}\n`,
		);
		expect(scanFirstInboundSource(file)).toBe("广播触发正文");
		expect(scanLastSessionInfoEntry(file)).toBeUndefined();
		const facts = scanSessionNamingFacts(file);
		expect(facts.hasAssistant).toBe(false);
		expect(facts.headerVersion).toBe(3);
	});
});

describe("firstInboundSourceFromMessages", () => {
	it("names a broadcast turn from in-memory messages while persistence still suppresses them", () => {
		expect(
			firstInboundSourceFromMessages([
				{ role: "custom", customType: "harness_digest", content: "noise" },
				{ role: "custom", customType: "agent_message", content: "env", details: { message: "广播正文" } },
				{ role: "assistant", content: [{ type: "text", text: "收到" }] },
			]),
		).toBe("广播正文");
	});
});

describe("uniquifyAutoName", () => {
	it("suffixes collisions so sibling names stay addressable", () => {
		const taken = new Set(["修复水务公告越权"]);
		expect(uniquifyAutoName("修复水务公告越权", taken)).toBe("修复水务公告越权 2");
	});
});

describe("autoname backfill command", () => {
	it("plans unnamed sessions and writes names only with --apply", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-autoname-cli-"));
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			const unnamed = join(sessionsDir, "aaaa1111-2222-3333-4444-555566667777.jsonl");
			writeFileSync(
				unnamed,
				`${JSON.stringify({ type: "session", version: 3, id: "aaaa1111", timestamp: "t", cwd: agentDir })}\n${JSON.stringify(
					{
						type: "message",
						message: { role: "user", content: "修复水务公告越权" },
					},
				)}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "收到" }] } })}\n`,
			);
			const named = join(sessionsDir, "bbbb1111-2222-3333-4444-555566667777.jsonl");
			writeFileSync(
				named,
				`${JSON.stringify({ type: "session", version: 3, id: "bbbb1111", timestamp: "t", cwd: agentDir })}\n${JSON.stringify(
					{
						type: "session_info",
						id: "n1",
						parentId: null,
						timestamp: "t",
						name: "已有名",
					},
				)}\n`,
			);
			expect(getSessionsDir()).toBe(sessionsDir);
			const dryRun = await runAutonameCommand([]);
			expect(dryRun).toBe(0);
			expect(scanLastSessionInfoEntry(unnamed)).toBeUndefined();
			const applied = await runAutonameCommand(["--apply"]);
			expect(applied).toBe(0);
			expect(scanLastSessionInfoEntry(unnamed)).toEqual({ name: "修复水务公告越权", auto: true });
			expect(scanLastSessionInfoEntry(named)).toEqual({ name: "已有名", auto: false });
			// Empty drafts (no assistant reply) stay unnamed and discardable.
			const draft = join(sessionsDir, "cccc1111-2222-3333-4444-555566667777.jsonl");
			writeFileSync(
				draft,
				`${JSON.stringify({ type: "session", version: 3, id: "cccc1111", timestamp: "t", cwd: agentDir })}\n${JSON.stringify(
					{
						type: "message",
						message: { role: "user", content: "随便一个触发" },
					},
				)}\n`,
			);
			const rerun = await runAutonameCommand(["--apply"]);
			expect(rerun).toBe(0);
			expect(scanLastSessionInfoEntry(draft)).toBeUndefined();
			// Legacy version files are reported, never migrated for a decoration.
			const legacy = join(sessionsDir, "dddd1111-2222-3333-4444-555566667777.jsonl");
			writeFileSync(
				legacy,
				`${JSON.stringify({ type: "session", id: "dddd1111", timestamp: "t", cwd: agentDir })}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "老版本会话" },
				})}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }] } })}\n`,
			);
			const legacyRun = await runAutonameCommand([]);
			expect(legacyRun).toBe(0);
			expect(scanLastSessionInfoEntry(legacy)).toBeUndefined();
			// --json is report-only even when combined with --apply.
			const draftBefore = scanLastSessionInfoEntry(draft);
			const jsonRun = await runAutonameCommand(["--json", "--apply"]);
			expect(jsonRun).toBe(0);
			expect(scanLastSessionInfoEntry(draft)).toEqual(draftBefore);
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
