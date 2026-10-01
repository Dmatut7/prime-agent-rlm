// W5-B: the session_context_loss notice (半落地尾巴①, written on load when the
// transcript is damaged) is display:true but fell into buildConversationComponents'
// "other custom" hole - the live face shows it, a replayed session did not. The
// same hole swallowed every other owner-visible custom notice without a dedicated
// branch; a generic display-gated fallback now mirrors the live path's
// createDisplayedCustomMessageComponent tail.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
	initTheme(undefined, false);
});

const baseOptions = {
	ui: {} as TUI,
	cwd: "/tmp",
	toolOptions: {},
	getToolDefinition: () => undefined,
};

function customNotice(customType: string, content: string, display: boolean) {
	return {
		role: "custom" as const,
		customType,
		content,
		display,
		timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
	};
}

describe("session_context_loss replay", () => {
	it("pins the customType literal against the producer sides", () => {
		// The wire value lives in messages.ts and the emission site uses the
		// constant; a rename of either must fail here instead of silently
		// dropping the notice on replay (old transcripts store the literal).
		const messages = readFileSync(resolve(__dirname, "../src/core/messages.ts"), "utf8");
		expect(messages).toContain('SESSION_CONTEXT_LOSS_CUSTOM_TYPE = "session_context_loss"');
		const session = readFileSync(resolve(__dirname, "../src/core/agent-session.ts"), "utf8");
		expect(session).toContain("customType: SESSION_CONTEXT_LOSS_CUSTOM_TYPE");
	});

	function contextLossNotice(display: boolean) {
		return customNotice(
			"session_context_loss",
			"This session's transcript is damaged: 2 transcript lines could not be read (line 41: invalid JSON).",
			display,
		);
	}

	it.each(["quiet", "legacy"] as const)("replays the damage notice instead of dropping it (%s)", (processMode) => {
		const components = buildConversationComponents([contextLossNotice(true)], { ...baseOptions, processMode });

		expect(components).toHaveLength(1);
		expect(components[0]).toBeInstanceOf(CustomMessageComponent);
		const rendered = stripAnsi(components[0]!.render(100).join("\n"));
		expect(rendered).toContain("session_context_loss");
		expect(rendered).toContain("This session's transcript is damaged");
	});

	it("honors display:false even for the damage notice", () => {
		const components = buildConversationComponents([contextLossNotice(false)], baseOptions);
		expect(components).toHaveLength(0);
	});
});

describe("generic display:true custom notices replay", () => {
	// Every owner-visible custom notice the session persists without a dedicated
	// replay branch. The live path renders all of them through the generic
	// custom-message box; the replay fallback keeps them visible. A literal here
	// pinned against its producer file fails on a rename instead of letting the
	// notice fall back into the hole.
	const notices = [
		{
			name: "provider_failure_recovery",
			sourceFile: "../src/core/self-recovery.ts",
			literal: 'PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE = "provider_failure_recovery"',
			content: "[provider-failure recovery] The last model request kept failing at the provider.",
		},
		{
			name: "empty_response_recovery",
			sourceFile: "../src/core/messages.ts",
			literal: 'EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE = "empty_response_recovery"',
			content: "[empty-response recovery] The model returned an empty response until the ladder was spent.",
		},
		{
			name: "system_interruption",
			sourceFile: "../src/core/messages.ts",
			literal: 'SYSTEM_INTERRUPTION_CUSTOM_TYPE = "system_interruption"',
			content: "[system interruption] The stalled turn was killed so the session could recover.",
		},
		{
			name: "stall_recovery_escalation",
			sourceFile: "../src/core/messages.ts",
			literal: 'STALL_RECOVERY_ESCALATION_CUSTOM_TYPE = "stall_recovery_escalation"',
			content: "[stall recovery] A wedged child was interrupted automatically.",
		},
		{
			name: "rlm_child_recovery_action",
			sourceFile: "../src/core/messages.ts",
			literal: 'RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE = "rlm_child_recovery_action"',
			content: "[child recovery] The daemon interrupted the wedged child worker.",
		},
		{
			name: "image_delivery_suspicion",
			sourceFile: "../src/core/messages.ts",
			literal: 'IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE = "image_delivery_suspicion"',
			content: "[Image delivery suspicion] Automatic session notice, not a message from the user.",
		},
		{
			name: "async_bash_completion",
			sourceFile: "../src/core/messages.ts",
			literal: 'ASYNC_BASH_COMPLETION_CUSTOM_TYPE = "async_bash_completion"',
			content: "[bash-done pid:123 exit:0]",
		},
		{
			name: "autonomous_status",
			sourceFile: "../src/core/agent-session.ts",
			literal: 'customType: "autonomous_status"',
			content: "[autonomous-status: running]\n\nContinuations: 1/4.",
		},
		{
			name: "ipython_bootstrap_failed",
			sourceFile: "../src/core/agent-session.ts",
			literal: 'customType: "ipython_bootstrap_failed"',
			content: "<ipython_bootstrap_failed>\nPython kernel failed to start.\n</ipython_bootstrap_failed>",
		},
		{
			name: "mcp_connection_outcome",
			sourceFile: "../src/core/messages.ts",
			literal: 'MCP_CONNECTION_OUTCOME_CUSTOM_TYPE = "mcp_connection_outcome"',
			content: "Login succeeded for acme, but connection verification did not complete.",
		},
		{
			name: "thinking_level_clamped",
			sourceFile: "../src/core/messages.ts",
			literal: 'THINKING_LEVEL_CLAMPED_CUSTOM_TYPE = "thinking_level_clamped"',
			content: "[thinking] Requested level high was clamped to medium by the model.",
		},
	];

	it("pins every notice's customType literal against its producer", () => {
		expect(notices.length).toBeGreaterThan(0);
		const cache = new Map<string, string>();
		for (const notice of notices) {
			const path = resolve(__dirname, notice.sourceFile);
			const source = cache.get(path) ?? readFileSync(path, "utf8");
			cache.set(path, source);
			expect(source, `${notice.name} literal missing from ${notice.sourceFile}`).toContain(notice.literal);
		}
	});

	it.each(notices)("replays $name instead of dropping it (legacy)", (notice) => {
		const components = buildConversationComponents([customNotice(notice.name, notice.content, true)], baseOptions);

		expect(components).toHaveLength(1);
		expect(components[0]).toBeInstanceOf(CustomMessageComponent);
		const rendered = stripAnsi(components[0]!.render(100).join("\n"));
		expect(rendered).toContain(notice.name);
		expect(rendered.length).toBeGreaterThan(0);
	});

	it.each(notices)("honors display:false for $name", (notice) => {
		const components = buildConversationComponents([customNotice(notice.name, notice.content, false)], baseOptions);
		expect(components).toHaveLength(0);
	});

	it.each(["quiet"] as const)(
		"replays provider_failure_recovery inside the quiet timeline too (%s)",
		(processMode) => {
			const notice = notices.find((entry) => entry.name === "provider_failure_recovery");
			expect(notice).toBeDefined();
			const components = buildConversationComponents([customNotice(notice!.name, notice!.content, true)], {
				...baseOptions,
				processMode,
			});
			expect(components).toHaveLength(1);
			expect(components[0]).toBeInstanceOf(CustomMessageComponent);
		},
	);
});
