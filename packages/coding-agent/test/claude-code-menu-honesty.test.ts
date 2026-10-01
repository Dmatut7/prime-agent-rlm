import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { checkClaudeCodeLoggedIn } from "../src/modes/interactive/claude-code-login-probe.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * The /model menu claimed "signed-in providers sort first, the rest get a login prompt",
 * but a machine with the `claude` binary installed showed every claude-code model at the
 * top with no badge while `claude auth status` reported logged out. These tests pin the
 * honest signal chain: the CLI probe, the badge/sort override it feeds, and the
 * select-path gate that routes an unconfigured pick into the login flow.
 */

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("checkClaudeCodeLoggedIn", () => {
	it("is not logged in when no claude executable exists", async () => {
		const runAuthStatus = vi.fn();
		await expect(checkClaudeCodeLoggedIn({ findExecutable: () => undefined, runAuthStatus })).resolves.toBe(false);
		expect(runAuthStatus).not.toHaveBeenCalled();
	});

	it("honors CLAUDE_CODE_OAUTH_TOKEN without probing the CLI", async () => {
		const runAuthStatus = vi.fn();
		await expect(
			checkClaudeCodeLoggedIn({ findExecutable: () => "/fake/claude", envToken: "sk-ant-oat01-x", runAuthStatus }),
		).resolves.toBe(true);
		expect(runAuthStatus).not.toHaveBeenCalled();
	});

	it("parses the CLI's auth status answer", async () => {
		await expect(
			checkClaudeCodeLoggedIn({
				findExecutable: () => "/fake/claude",
				envToken: "",
				runAuthStatus: () => Promise.resolve(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })),
			}),
		).resolves.toBe(true);
		await expect(
			checkClaudeCodeLoggedIn({
				findExecutable: () => "/fake/claude",
				envToken: "",
				runAuthStatus: () => Promise.resolve(JSON.stringify({ loggedIn: false, authMethod: "none" })),
			}),
		).resolves.toBe(false);
	});

	it("treats a failed or garbled probe as logged out", async () => {
		await expect(
			checkClaudeCodeLoggedIn({
				findExecutable: () => "/fake/claude",
				envToken: "",
				runAuthStatus: () => Promise.reject(new Error("timed out")),
			}),
		).resolves.toBe(false);
		await expect(
			checkClaudeCodeLoggedIn({
				findExecutable: () => "/fake/claude",
				envToken: "",
				runAuthStatus: () => Promise.resolve("not json"),
			}),
		).resolves.toBe(false);
	});
});

describe("ModelSelectorComponent probe honesty", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSelector(unconfiguredProviders?: ReadonlySet<string>) {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
		});
		harnesses.push(harness);
		const base = harness.getModel("faux-1")!;
		// The walkthrough lie: the catalog claims claude-code configured because the binary
		// exists, so it sorts first with no badge. openai is the honestly configured control.
		const claudeModel = { ...base, provider: "claude-code", id: "claude-opus-5-5", name: "Claude Opus" };
		const openaiModel = { ...base, provider: "openai", id: "gpt-5", name: "GPT-5" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [claudeModel, openaiModel],
				configuredProviders: new Set(["claude-code", "openai"]),
				...(unconfiguredProviders ? { unconfiguredProviders } : {}),
				getRows: () => 40,
			},
		);
		await waitForAsyncRender();
		return selector;
	}

	function rowIndex(lines: string[], marker: string): number {
		return lines.findIndex((line) => line.includes(marker));
	}

	it("badges and demotes a catalog-configured provider the probe disproved", async () => {
		const selector = await createSelector(new Set(["claude-code"]));

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const claudeRow = rowIndex(lines, "claude-opus-5-5");
		const openaiRow = rowIndex(lines, "gpt-5");

		expect(openaiRow).toBeGreaterThanOrEqual(0);
		expect(claudeRow).toBeGreaterThan(openaiRow);
		expect(lines[claudeRow]).toContain("需登录");
		expect(lines[openaiRow]).not.toContain("需登录");
	});

	it("re-sorts live when the probe settles, and restores on a later login", async () => {
		const selector = await createSelector();

		const before = stripAnsi(selector.render(120).join("\n")).split("\n");
		expect(rowIndex(before, "claude-opus-5-5")).toBeLessThan(rowIndex(before, "gpt-5"));
		expect(before[rowIndex(before, "claude-opus-5-5")]).not.toContain("需登录");

		selector.setUnconfiguredProviders(new Set(["claude-code"]));
		const after = stripAnsi(selector.render(120).join("\n")).split("\n");
		expect(rowIndex(after, "claude-opus-5-5")).toBeGreaterThan(rowIndex(after, "gpt-5"));
		expect(after[rowIndex(after, "claude-opus-5-5")]).toContain("需登录");

		selector.setUnconfiguredProviders(undefined);
		const restored = stripAnsi(selector.render(120).join("\n")).split("\n");
		expect(rowIndex(restored, "claude-opus-5-5")).toBeLessThan(rowIndex(restored, "gpt-5"));
		expect(restored[rowIndex(restored, "claude-opus-5-5")]).not.toContain("需登录");
	});
});

describe("InteractiveMode claude-code select gate", () => {
	type ProbeFake = {
		connectionConfiguredProviders: Set<string>;
		claudeCodeLoginStatus: { value: boolean; checkedAt: number } | undefined;
		modelRegistry: { hasConfiguredAuth: (model: { provider: string }) => boolean };
	};

	function createProbeFake(loginStatus: boolean | undefined): ProbeFake {
		const fake: ProbeFake = {
			connectionConfiguredProviders: new Set(["claude-code"]),
			claudeCodeLoginStatus: loginStatus === undefined ? undefined : { value: loginStatus, checkedAt: Date.now() },
			modelRegistry: { hasConfiguredAuth: () => true },
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return fake;
	}

	const isModelProviderConfigured = Reflect.get(InteractiveMode.prototype, "isModelProviderConfigured") as (
		this: ProbeFake,
		model: { provider: string },
	) => boolean;

	it("treats a probe-disproved provider as unconfigured even when the catalog claims it", () => {
		const mode = createProbeFake(false);
		expect(isModelProviderConfigured.call(mode, { provider: "claude-code" })).toBe(false);
		// Other providers are untouched by the claude-code probe.
		expect(isModelProviderConfigured.call(mode, { provider: "openai" })).toBe(true);
	});

	it("keeps the catalog claim while the probe is unknown or says logged in", () => {
		expect(isModelProviderConfigured.call(createProbeFake(undefined), { provider: "claude-code" })).toBe(true);
		expect(isModelProviderConfigured.call(createProbeFake(true), { provider: "claude-code" })).toBe(true);
	});
});
