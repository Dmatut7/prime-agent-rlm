import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type Context, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { PromptTemplate } from "../src/core/prompt-templates.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i]!;
		if (message.role === "user") {
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
		}
	}
	return "";
}

function makeSkill(name: string): Skill {
	return {
		kind: "markdown",
		name,
		description: `Test skill ${name}`,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: "/tmp/skills",
		sourceInfo: { path: `/tmp/skills/${name}`, source: "local", scope: "project", origin: "top-level" },
		disableModelInvocation: false,
	};
}

function makeTemplate(name: string): PromptTemplate {
	return {
		name,
		description: `Test template ${name}`,
		content: `TEMPLATE_BODY_${name.toUpperCase()}`,
		sourceInfo: { source: "local", scope: "project", baseDir: "/tmp" } as PromptTemplate["sourceInfo"],
		filePath: `/tmp/${name}.md`,
	};
}

describe("AgentSession slash-command typo guard", () => {
	let tempDir: string;
	let sessions: AgentSession[];
	let promptCalls: string[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-slash-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessions = [];
		promptCalls = [];
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			session.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(options: { templates?: PromptTemplate[]; skills?: ReturnType<typeof makeSkill>[] } = {}) {
		const streamFn: StreamFn = (_model, context) => {
			promptCalls.push(lastUserText(context));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage(),
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		const resourceLoader = createTestResourceLoader({ skills: options.skills ?? [] });
		const loader = resourceLoader as unknown as {
			getPrompts: () => { prompts: PromptTemplate[]; diagnostics: unknown[] };
		};
		loader.getPrompts = () => ({ prompts: options.templates ?? [], diagnostics: [] });
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader,
		});
		sessions.push(session);
		return session;
	}

	it("rejects slash-command typos with a suggestion before any model call", async () => {
		const session = createSession();

		await expect(session.prompt("/resuem")).rejects.toThrow("Unknown command: /resuem. Did you mean /resume?");
		expect(promptCalls).toEqual([]);
	});

	it("passes through short path-like tokens that only weakly resemble a command", async () => {
		const session = createSession();

		// "tmp" differs from "mcp" by two characters; short tokens only match on a
		// single-character typo, so this prompt reaches the model.
		await session.prompt("/tmp notes for the cleanup");
		expect(promptCalls).toEqual(["/tmp notes for the cleanup"]);
	});

	it("passes a real on-disk path prompt through untouched", async () => {
		const session = createSession();

		const pathPrompt = "/tmp/merge-doc-inputs/04-port-specs-ux.md is the spec to read";
		await session.prompt(pathPrompt);
		expect(promptCalls).toEqual([pathPrompt]);
	});

	it("still rejects single-character typos of short commands", async () => {
		const session = createSession();

		// "log" is one insertion away from the /logs builtin.
		await expect(session.prompt("/log rotate policies")).rejects.toThrow(
			"Unknown command: /log. Did you mean /logs?",
		);
		expect(promptCalls).toEqual([]);
	});

	it("passes through slash-prefixed prompts without a near command match", async () => {
		const session = createSession();

		await session.prompt("/etc/hosts is where hostname lookups start");
		expect(promptCalls).toEqual(["/etc/hosts is where hostname lookups start"]);
	});

	it("leaves a registered command with arguments alone", async () => {
		const session = createSession();

		await session.prompt("/model opus");
		expect(promptCalls).toEqual(["/model opus"]);
	});

	it("suggests registered skills for typo'd skill commands", async () => {
		const session = createSession({ skills: [makeSkill("python")] });

		await expect(session.prompt("/skill:pythno fix the bug")).rejects.toThrow(
			"Unknown command: /skill:pythno. Did you mean /skill:python?",
		);
		expect(promptCalls).toEqual([]);
	});

	it("suggests a typo'd invocation of a skill this fork really ships", async () => {
		const session = createSession({ skills: [makeSkill("agent-message"), makeSkill("rlm-heartbeat")] });

		await expect(session.prompt("/skill:agent-mesage send the receipt")).rejects.toThrow(
			"Unknown command: /skill:agent-mesage. Did you mean /skill:agent-message?",
		);
		expect(promptCalls).toEqual([]);
	});

	it("passes through oversized /-prefixed prompts without fuzzy matching", async () => {
		const session = createSession();

		const longPath = `/very/long/${"a".repeat(500)}/path`;
		await session.prompt(`${longPath} is the file to inspect`);
		expect(promptCalls).toEqual([`${longPath} is the file to inspect`]);
	});

	it("expands registered templates instead of guarding them", async () => {
		const session = createSession({ templates: [makeTemplate("worktree-check")] });

		await session.prompt("/worktree-check");
		expect(promptCalls).toEqual(["TEMPLATE_BODY_WORKTREE-CHECK"]);
	});
});
