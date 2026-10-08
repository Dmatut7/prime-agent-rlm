import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lane J (display audit D1-D5 + examples/README): the docs must describe the
 * behavior the code actually ships. Each assertion pairs a doc claim with the
 * code surface it describes, so reverting a doc fix turns the test red.
 */

function readDoc(rel: string): string {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
}

const tuiDoc = readDoc("../docs/tui.md");
const readme = readDoc("../README.md");
const usageDoc = readDoc("../docs/usage.md");
const settingsDoc = readDoc("../docs/settings.md");
const tuiPkgReadme = readDoc("../../tui/README.md");
const extExamplesReadme = readDoc("../examples/extensions/README.md");
const extensionTypes = readDoc("../src/core/extensions/types.ts");
const footerSource = readDoc("../src/modes/interactive/components/footer.ts");

describe("D1: docs/tui.md documents the real ctx.ui.custom API", () => {
	it("never shows the non-existent handle API or pi.ui", () => {
		expect(tuiDoc).not.toContain("pi.ui.");
		expect(tuiDoc).not.toContain("handle.requestRender");
		expect(tuiDoc).not.toContain("handle.close");
		expect(tuiDoc).not.toContain("= ctx.ui.custom(selector)");
	});

	it("shows the factory signature the code defines", () => {
		// types.ts: custom<T>(factory: (tui, theme, keybindings, done) => Component | Promise<Component>, options?)
		expect(extensionTypes).toMatch(
			/custom<T>\(\s*factory:\s*\(\s*tui: TUI,\s*theme: Theme,\s*keybindings: KeybindingsManager,\s*done: \(result: T\) => void/s,
		);
		expect(tuiDoc).toContain("ctx.ui.custom<boolean>((tui, theme, keybindings, done)");
	});

	it("documents the daemon-session limitation consistent with extensions.md", () => {
		expect(tuiDoc).toMatch(/[Dd]aemon sessions/);
		expect(tuiDoc).toContain("resolves `undefined`");
	});

	it("shows the real execute parameter order", () => {
		// types.ts: execute(toolCallId, params, signal, onUpdate, ctx)
		const m =
			/execute\(\s*toolCallId: string,\s*params: Static<TParams>,\s*signal: AbortSignal \| undefined,\s*onUpdate: AgentToolUpdateCallback<TDetails> \| undefined,\s*ctx: ExtensionContext,?\s*\)/s.exec(
				extensionTypes,
			);
		expect(m, "ToolDefinition.execute keeps the (toolCallId, params, signal, onUpdate, ctx) order").not.toBeNull();
		expect(tuiDoc).toContain("async execute(toolCallId, params, signal, onUpdate, ctx)");
		expect(tuiDoc).not.toContain("execute(toolCallId, params, onUpdate, ctx, signal)");
	});
});

describe("D2: Escape is documented as the interrupt key", () => {
	it("README and usage.md stop claiming Escape never interrupts", () => {
		expect(readme).not.toContain("Clear the input without interrupting active work");
		expect(readme).not.toContain("clears the input without interrupting active work");
		expect(usageDoc).not.toContain("clears the input bar without interrupting the agent");
	});

	it("README and usage.md describe interrupt-while-working plus the stashed draft", () => {
		expect(readme).toMatch(/Escape \| Interrupt active work/);
		expect(readme).toContain("Ctrl+S restores it");
		expect(usageDoc).toMatch(/\*\*Escape\*\* interrupts the current operation/);
		expect(usageDoc).toContain("Ctrl+S restores it");
	});
});

describe("D3: README describes the real footer", () => {
	it("no longer claims the footer is empty by default", () => {
		expect(readme).not.toContain("Footer** - Empty by default");
	});

	it("describes the watermark line gated by footer.telemetry", () => {
		expect(readme).toContain("footer.telemetry");
		expect(readme).toContain("watermark");
		// The settings doc row is the detailed contract; sanity that it exists.
		expect(settingsDoc).toContain("`footer.telemetry`");
	});
});

describe("D4: tui README tells the truth about overwide lines", () => {
	it("never claims the TUI errors on overwide lines", () => {
		expect(tuiPkgReadme).not.toContain("the TUI will error");
		expect(tuiPkgReadme).not.toContain("The TUI will error");
	});

	it("describes the clamp + crash-log behavior the code implements", () => {
		// tui.ts: clampOverwideLine + logClampedOverwideLines write ~/.prime/agent/pi-crash.log
		expect(tuiPkgReadme).toContain("clamp");
		expect(tuiPkgReadme).toContain("pi-crash.log");
	});
});

describe("D5: compaction marker text matches the implementation", () => {
	it("settings.md uses the exact string footer.ts renders", () => {
		const m = /imminent \? " \u00b7 ([^"]+)" : ""/.exec(footerSource);
		expect(m, "footer.ts still appends an imminent-compaction marker").not.toBeNull();
		const marker = m![1]!;
		expect(settingsDoc).toContain("`" + marker + "`");
		expect(settingsDoc).not.toContain("`压缩在即`");
	});
});

describe("examples: real execute order and install paths", () => {
	it("extensions README shows the real execute parameter order", () => {
		expect(extExamplesReadme).toContain("async execute(toolCallId, params, signal, onUpdate, ctx)");
		expect(extExamplesReadme).not.toContain("execute(toolCallId, params, onUpdate, ctx, signal)");
	});

	it("extension examples point at ~/.prime/agent, not the legacy ~/.pi", () => {
		for (const f of ["commands.ts", "pirate.ts", "claude-rules.ts", "prompt-customizer.ts", "tools.ts"]) {
			const src = readDoc(`../examples/extensions/${f}`);
			expect(src, f).not.toContain("~/.pi/");
			expect(src, f).not.toContain(".pi/extensions/");
			expect(src, f).toContain("~/.prime/agent/extensions/");
		}
	});
});
