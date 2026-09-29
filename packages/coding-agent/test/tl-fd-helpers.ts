import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Spacer, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { TimelineNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { createReplayHost, type ReplayHost, type ReplayOptions, replayInto } from "./tl-fix-host.js";
import { plain } from "./ui-blocks-helpers.js";

/** The chat the interactive mode's own replay builds, and the other two ways to build one: live events, the test builder. */

export type { ReplayHost, ReplayOptions } from "./tl-fix-host.js";

export function createHost(): ReplayHost {
	return createReplayHost();
}

/** The mode's own replay of a session file's messages. */
export async function replay(
	messages: AgentMessage[],
	options: ReplayOptions = { clearChat: true },
	host: ReplayHost = createHost(),
): Promise<ReplayHost> {
	await replayInto(host, messages, options);
	return host;
}

/** The test builder's chat for the same messages. */
export function built(messages: readonly AgentMessage[]): Component[] {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
}

export const summariesOf = (children: readonly Component[]) =>
	children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);

/** Every line the chat draws, times blanked, with the closing rows left out (only the live flow and the mode's replay draw them). */
export function screenLines(children: readonly Component[], width = 100): string[] {
	return plain(
		children.filter((child) => !(child instanceof TurnStripComponent)).flatMap((child) => child.render(width)),
	).map((line) => line.replace(/\d\d:\d\d(?::\d\d)?/g, "HH:MM").trimEnd());
}

export const screenOf = (children: readonly Component[], width = 100): string =>
	screenLines(children, width).join("\n");

/** What the chat is, one entry per component: the same words say the same layout live and replayed. */
export function outline(children: readonly Component[]): string[] {
	const out: string[] = [];
	for (const child of children) {
		if (child instanceof Spacer || child instanceof TurnStripComponent) continue;
		const text = plain(child.render(200))
			.map((line) => line.replace(/\d\d:\d\d/, "HH:MM").trim())
			.filter((line) => line.length > 0)
			.join(" / ");
		if (child instanceof TurnSummaryComponent) out.push(`turn(byUser=${child.state.startedByUser})`);
		else if (child instanceof UserMessageComponent) out.push(`user: ${text}`);
		else if (child instanceof AssistantMessageComponent) out.push(`answer: ${text || "(nothing drawn)"}`);
		else if (child instanceof AgentMessageComponent) out.push(`report: ${text}`);
		else if (child instanceof TimelineNoticeRow) out.push(`notice: ${text || "(out of sight)"}`);
		else if (text) out.push(`other: ${text}`);
	}
	return out;
}
