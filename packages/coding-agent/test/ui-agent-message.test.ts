import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRelationship,
	type AgentSessionMessage,
	type AgentSessionMessageSender,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { plain, useTruecolorTheme } from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

function message(
	body: string,
	from: AgentSessionMessageSender | undefined,
	relationship: AgentFamilyRelationship | undefined,
): AgentSessionMessage {
	return createAgentSessionMessage({
		id: "agentmsg_ui5",
		source: AGENT_MESSAGE_SOURCE,
		message: body,
		...(from ? { from } : {}),
		...(relationship ? { fromRelationship: relationship } : {}),
		target: { activeSessionId: "main-active", sessionId: "main" },
	});
}

function row(component: AgentMessageComponent, width = 120): string {
	return plain(component.render(width))
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.join("\n");
}

const child = (body = "车道 D（键位/点击区/时间线）审查完毕，报告在 /tmp/ffreview_d.md") =>
	message(body, { sessionName: "ff-review-d-keys", sessionId: "c1" }, "child");

describe("a message handed back by a subagent", () => {
	it("reads `◇ name 交回：preview`, not the old received-message wording", () => {
		const component = new AgentMessageComponent(child(), undefined, { suppressLeadingSpace: true });
		expect(row(component)).toBe(
			" ◇ ff-review-d-keys 交回：车道 D（键位/点击区/时间线）审查完毕，报告在 /tmp/ffreview_d.md",
		);
		expect(row(component)).not.toContain("◆");
		expect(row(component)).not.toContain("收到消息");
	});

	it("says 发来 for a message from anyone else", () => {
		const sources: Array<[AgentSessionMessage, string]> = [
			[message("请审查分片七", { sessionName: "Planner", sessionId: "p" }, "parent"), "Planner 发来：请审查分片七"],
			[message("我这边好了", { sessionName: "Peer", sessionId: "s" }, "sibling"), "Peer 发来：我这边好了"],
			[message("旧版本发来的", { sessionId: "legacy-session" }, undefined), "legacy-session 发来：旧版本发来的"],
			[message("没有发件人", undefined, undefined), "unknown 发来：没有发件人"],
		];
		expect(sources.length).toBeGreaterThan(0);
		for (const [source, expected] of sources) {
			const component = new AgentMessageComponent(source, undefined, { suppressLeadingSpace: true });
			expect(row(component)).toBe(` ◇ ${expected}`);
		}
	});

	it("names a child by its id when it has no name", () => {
		const component = new AgentMessageComponent(message("好了", { sessionId: "child-session" }, "child"), undefined, {
			suppressLeadingSpace: true,
		});
		expect(row(component)).toBe(" ◇ child-session 交回：好了");
	});

	it("colors the marker and the name as a subagent and leaves the rest muted", () => {
		const component = new AgentMessageComponent(child("审查完毕"), undefined, { suppressLeadingSpace: true });
		const raw = component.render(120).find((line) => line.includes("审查完毕")) ?? "";
		expect(raw).toContain(theme.fg("kindSubagent", "◇"));
		expect(raw).toContain(theme.fg("kindSubagent", "ff-review-d-keys"));
		expect(raw).toContain(theme.fg("muted", "交回"));
		expect(raw).toContain(theme.fg("muted", "：审查完毕"));
	});

	it("opens and closes on a click, keeping its whole body for the open row", () => {
		const component = new AgentMessageComponent(child("第一行\n第二行"), undefined, { suppressLeadingSpace: true });
		const click = () =>
			component
				.getClickRegions()
				.find((region) => !region.passive)
				?.onClick({ row: 0, col: 0 });
		component.render(100);
		expect(row(component, 100)).toBe(" ◇ ff-review-d-keys 交回：第一行 第二行");
		click();
		expect(row(component, 100)).toBe(" ◇ ff-review-d-keys 交回\n ╰─ 第一行\n    第二行");
		click();
		component.render(100);
		expect(row(component, 100)).toBe(" ◇ ff-review-d-keys 交回：第一行 第二行");
	});
});
