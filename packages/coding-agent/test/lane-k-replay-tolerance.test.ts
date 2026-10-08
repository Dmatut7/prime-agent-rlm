import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Spacer, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type CustomMessage,
	customMessageShapeError,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../src/core/messages.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { boxRecordFromMessage } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness } from "./suite/harness.js";
import { plain } from "./ui-blocks-helpers.js";

/**
 * Lane K of the 2026-10-06 display audit: replay tolerance and存量兼容性.
 *
 * - R5-M20: 4b51ff170 renamed the no-reply notice's `lastAssistantTextPreview`
 *   to `lastAssistantText`; transcripts written before it still carry the old
 *   field (the owner's real session files hold 108 of them), and the quiet
 *   replay's "它最后写的：" detail went blank for every one of them.
 * - R5-M21: a stored message with missing fields (e.g. a custom_message with
 *   no `content`) crashed every replay of its session with a bare TypeError -
 *   the session could never be opened or attached again. Replay now skips a
 *   malformed message with a visible warning, and the write side refuses to
 *   persist one.
 */

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

/** The notice as a pre-4b51ff170 session file stored it: preview under the old name. */
function legacyNotice(): CustomMessage {
	return {
		role: "custom",
		customType: RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
		content: "RLM child worker-1 (child-1) completed without sending a reply",
		display: true,
		details: {
			kind: "completed_without_reply",
			childId: "child-1",
			sessionName: "worker-1",
			lastAssistantTextPreview: "审查完了：没发现问题。",
		},
		timestamp: 1_000,
	};
}

describe("R5-M20: legacy lastAssistantTextPreview still reads in replay", () => {
	it("shows the stored answer of a pre-rename no-reply notice", () => {
		const record = boxRecordFromMessage(legacyNotice());
		expect(record?.kind).toBe("notice");
		if (record?.kind !== "notice") return;
		expect(record.notice.detail).toContain("审查完了：没发现问题。");
	});

	it("prefers the new field when both are present", () => {
		const message = legacyNotice();
		(message.details as { lastAssistantText?: string }).lastAssistantText = "新字段的答案。";
		const record = boxRecordFromMessage(message);
		expect(record?.kind).toBe("notice");
		if (record?.kind !== "notice") return;
		expect(record.notice.detail).toContain("新字段的答案。");
		expect(record.notice.detail).not.toContain("审查完了");
	});
});

describe("R5-M21: one malformed stored message cannot take the session down", () => {
	function replay(messages: AgentMessage[]): string {
		const components = buildConversationComponents(messages, {
			ui: { requestRender: () => {} } as never,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		return plain(components.flatMap((component) => (component instanceof Spacer ? [] : component.render(100)))).join(
			"\n",
		);
	}

	it("renders a custom message without content as a marked-malformed row", () => {
		// The exact bad line class from the audit: a custom_message entry whose
		// message has no content field crashed replay at CustomMessageComponent's
		// content.filter with a bare TypeError, every time the session was opened.
		// The row now says the message is malformed instead.
		const bad = {
			role: "custom",
			customType: "some_notice",
			display: true,
			timestamp: 2_000,
		} as unknown as AgentMessage;
		const screen = replay([
			{ role: "user", content: "做件事", timestamp: 1_000 },
			bad,
			{
				role: "assistant",
				content: [{ type: "text", text: "做完了。" }],
				stopReason: "stop",
				timestamp: 3_000,
			} as AgentMessage,
		]);
		expect(screen).toContain("做完了。");
		expect(screen).toContain("[some_notice]");
		expect(screen).toContain("malformed");
	});

	it("skips an assistant message without content and keeps the rest of the turn", () => {
		const badAssistant = {
			role: "assistant",
			stopReason: "stop",
			timestamp: 2_000,
		} as unknown as AgentMessage;
		const screen = replay([
			{ role: "user", content: "做件事", timestamp: 1_000 },
			badAssistant,
			{
				role: "assistant",
				content: [{ type: "text", text: "做完了。" }],
				stopReason: "stop",
				timestamp: 3_000,
			} as AgentMessage,
		]);
		expect(screen).toContain("做完了。");
		expect(screen).toContain("已跳过");
	});
});

describe("R5-M21: the write side refuses a malformed custom message", () => {
	it("customMessageShapeError names the broken field", () => {
		expect(customMessageShapeError({ customType: "x", content: "ok" })).toBeUndefined();
		expect(customMessageShapeError({ customType: "x", content: [{ type: "text", text: "ok" }] })).toBeUndefined();
		expect(
			customMessageShapeError({
				customType: "x",
				content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
			}),
		).toBeUndefined();
		expect(customMessageShapeError({ customType: "x" })).toMatch(/content/);
		expect(customMessageShapeError({ customType: "x", content: 42 })).toMatch(/content/);
		expect(customMessageShapeError({ content: "ok" })).toMatch(/customType/);
		expect(customMessageShapeError({ customType: "x", content: [{ type: "text" }] })).toMatch(/text/);
	});

	it("sendCustomMessage rejects the poison and persists nothing for it", async () => {
		const harness = await createHarness({ persistSession: true });
		try {
			const sessionFile = harness.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			await expect(
				harness.session.sendCustomMessage({ customType: "lane-k.poison", display: true } as never),
			).rejects.toThrow(/malformed custom message/);
			expect(harness.session.messages.some((m) => (m as CustomMessage).customType === "lane-k.poison")).toBe(false);

			// A well-formed message still lands, in memory and on disk. flushNow
			// bypasses the no-assistant guard that keeps pre-model entries off disk,
			// so everything in memory is written: had the poison entered the state,
			// it would be here.
			await harness.session.sendCustomMessage({ customType: "lane-k.ok", content: "没问题", display: true });
			harness.sessionManager.flushNow();
			const raw = readFileSync(sessionFile!, "utf8");
			expect(raw).not.toContain("lane-k.poison");
			expect(raw).toContain("lane-k.ok");
		} finally {
			harness.cleanup();
		}
	});
});
