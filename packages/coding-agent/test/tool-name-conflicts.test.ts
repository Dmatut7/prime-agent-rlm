import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const toolCode = (name: string, description: string) => `
	import { Type } from "typebox";
	export default function(pi) {
		pi.registerTool({
			name: "${name}",
			label: "${name}",
			description: "${description}",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	}
`;

describe("tool name conflicts are loud", () => {
	let tempDir: string;
	let agentDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), `pi-tool-conflict-${Date.now()}-`));
		agentDir = join(tempDir, "agent");
		extensionsDir = join(tempDir, "extensions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extensionsDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const makeRunner = async () => {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, SessionManager.inMemory(), modelRegistry);
	};

	it("names both extension paths and a free name when two extensions register the same tool", async () => {
		writeFileSync(join(extensionsDir, "a-first.ts"), toolCode("shared", "first"));
		writeFileSync(join(extensionsDir, "b-second.ts"), toolCode("shared", "second"));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runner = await makeRunner();
		const tools = runner.getAllRegisteredTools();

		// Existing resolution behavior is preserved: the first registration wins.
		expect(tools).toHaveLength(1);
		expect(tools[0]?.definition.description).toBe("first");

		const diagnostics = runner.getToolDiagnostics();
		const message = diagnostics.map((d) => d.message).join("\n");
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(message).toContain("shared");
		expect(message).toContain("a-first.ts");
		expect(message).toContain("b-second.ts");
		expect(message).toContain("shared2");
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("stays quiet when extensions register distinct tool names", async () => {
		writeFileSync(join(extensionsDir, "a-first.ts"), toolCode("tool_a", "a"));
		writeFileSync(join(extensionsDir, "b-second.ts"), toolCode("tool_b", "b"));

		const runner = await makeRunner();
		expect(runner.getAllRegisteredTools()).toHaveLength(2);
		expect(runner.getToolDiagnostics()).toHaveLength(0);
	});

	it("notifies the UI instead of stderr when an extension-runner UI context is bound", async () => {
		writeFileSync(join(extensionsDir, "a-first.ts"), toolCode("shared", "first"));
		writeFileSync(join(extensionsDir, "b-second.ts"), toolCode("shared", "second"));

		const runner = await makeRunner();
		const notify = vi.fn();
		runner.setUIContext({ notify } as unknown as ExtensionUIContext);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		runner.getAllRegisteredTools();

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("shared2"), "warning");
		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("reports an extension overriding a built-in tool name, naming both sources", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "ipython",
						label: "shadow ipython",
						description: "Extension replacement for the built-in ipython tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "shadowed" }], details: {} }),
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		// Overriding a built-in name stays allowed (documented feature), but must be loud.
		const ipython = session.getAllTools().find((tool) => tool.name === "ipython");
		expect(ipython?.sourceInfo).toMatchObject({ source: "inline" });

		const diagnostics = session.getToolDiagnostics();
		const message = diagnostics.map((d) => d.message).join("\n");
		expect(message).toContain("ipython");
		expect(message).toContain("<builtin:ipython>");
		expect(message).toContain("<inline:1>");
		expect(message).toContain("ipython2");
		expect(message).toContain("resolves a tool by name");
		expect(diagnostics.some((d) => d.type === "warning")).toBe(true);

		session.dispose();
	});

	it("notifies the bound session UI when a custom tool shadows a built-in name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			customTools: [
				{
					name: "ipython",
					label: "sdk ipython",
					description: "SDK replacement for the built-in ipython tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "sdk" }], details: {} }),
				},
			],
		});
		const notify = vi.fn();
		await session.bindExtensions({ uiContext: { notify } as unknown as ExtensionUIContext });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("<builtin:ipython>"), "warning");

		session.dispose();
	});

	it("reports an SDK custom tool overriding a built-in tool name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			customTools: [
				{
					name: "ipython",
					label: "sdk ipython",
					description: "SDK replacement for the built-in ipython tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "sdk" }], details: {} }),
				},
			],
		});

		const diagnostics = session.getToolDiagnostics();
		const message = diagnostics.map((d) => d.message).join("\n");
		expect(message).toContain("<builtin:ipython>");
		expect(message).toContain("<sdk:ipython>");

		session.dispose();
	});

	it("reports an SDK custom tool overriding an extension tool name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "shared_tool",
						label: "extension shared_tool",
						description: "extension version",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "extension" }], details: {} }),
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			customTools: [
				{
					name: "shared_tool",
					label: "sdk shared_tool",
					description: "sdk version",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "sdk" }], details: {} }),
				},
			],
		});
		await session.bindExtensions({});

		// SDK custom tools are applied after extension tools, so the SDK tool wins here.
		expect(session.getToolDefinition("shared_tool")?.description).toBe("sdk version");
		const message = session
			.getToolDiagnostics()
			.map((d) => d.message)
			.join("\n");
		expect(message).toContain("<sdk:shared_tool>");
		expect(message).toContain("<inline:1>");
		expect(message).toContain("shared_tool2");

		session.dispose();
	});

	it("stays quiet when a session has no tool name conflicts", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "unrelated_tool",
						label: "unrelated",
						description: "no conflict here",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		expect(session.getToolDiagnostics()).toHaveLength(0);

		session.dispose();
	});
});
