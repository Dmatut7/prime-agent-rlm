import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";
import { createAgentConnectionState } from "../src/modes/agent-connection/snapshot.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { conversationMessages } from "./suite/harness.js";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("daemon extension binding", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});

	it("keeps extension replacement callbacks daemon-side and rebinds before withSession", async () => {
		const phases: string[] = [];
		let oldSessionFile: string | undefined;
		let replacementSessionFile: string | undefined;

		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-replace", {
					description: "daemon replace",
					handler: async (_args, ctx) => {
						phases.push("command");
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								phases.push("withSession");
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								await replacedCtx.sendUserMessage("daemon replacement message");
							},
						});
					},
				});
			},
			["replacement reply"],
		);

		const outbound: DaemonOutbound[] = [];
		const heartbeat: AgentCronJob = {
			id: "heartbeat-1",
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-test",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "check status",
			schedule: { kind: "interval", expression: "every 10s", intervalMs: 10_000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: "2026-01-01T00:00:10.000Z",
			runCount: 0,
		};
		const state: ActiveSessionState = {
			activeSessionId: "active-test",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-test",
			lastEventSequence: 0,
			summaryState: { summary: "old recap", taskState: "completed", basedOnMessageCount: 2 },
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
				if (message.type === "session_replaced") {
					phases.push("broadcast:session_replaced");
				}
			},
			createConnectionState: (targetState) => {
				const connectionState = createAgentConnectionState(targetState.runtime, targetState.activeSessionId);
				if (targetState.summaryState?.summary) {
					connectionState.recap = targetState.summaryState.summary;
				}
				connectionState.heartbeat = heartbeat;
				return connectionState;
			},
			sessionReplaced: (targetState) => {
				phases.push("sessionReplaced");
				targetState.summaryState = undefined;
			},
			shutdown: () => {
				phases.push("shutdown");
			},
		});

		await runtime.session.prompt("/daemon-replace");

		const replacementIndex = phases.indexOf("broadcast:session_replaced");
		const withSessionIndex = phases.indexOf("withSession");
		expect(replacementIndex).toBeGreaterThan(-1);
		expect(withSessionIndex).toBeGreaterThan(-1);
		expect(phases.indexOf("sessionReplaced")).toBeLessThan(replacementIndex);
		expect(replacementIndex).toBeLessThan(withSessionIndex);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(outbound).toContainEqual(
			expect.objectContaining({
				type: "session_replaced",
				activeSessionId: "active-test",
				state: expect.objectContaining({
					heartbeat: expect.objectContaining({ id: "heartbeat-1" }),
				}),
			}),
		);
		const replaced = outbound.find(
			(message): message is Extract<DaemonOutbound, { type: "session_replaced" }> =>
				message.type === "session_replaced",
		);
		expect(replaced?.state.recap).toBeUndefined();
		expect(conversationMessages(runtime.session).map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:daemon replacement message",
			"assistant:replacement reply",
		]);
	});

	it("notifies once when an extension calls ctx.ui.custom, which daemon sessions cannot host (R3-M6)", async () => {
		const customResults: unknown[] = [];
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("custom-ui", {
					description: "custom ui probe",
					handler: async (_args, ctx) => {
						customResults.push(await ctx.ui.custom(async () => ({ render: () => [], invalidate: () => {} })));
						customResults.push(await ctx.ui.custom(async () => ({ render: () => [], invalidate: () => {} })));
					},
				});
			},
			["done"],
		);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-custom",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-custom",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("/custom-ui");

		// The call still resolves undefined (no UI host), but the user is told why
		// instead of the extension reporting a silent "cancelled".
		expect(customResults).toEqual([undefined, undefined]);
		const notifies = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "extension_ui_request" }> =>
				message.type === "extension_ui_request" && message.method === "notify",
		);
		expect(notifies).toHaveLength(1);
		expect(String(notifies[0]!.payload.message)).toContain("ctx.ui.custom");
		expect(notifies[0]!.payload.notifyType).toBe("warning");
	});

	function bindDialogState(
		runtime: Awaited<ReturnType<typeof createRuntimeForTest>>,
		activeSessionId: string,
	): { state: ActiveSessionState; outbound: DaemonOutbound[] } {
		const outbound: DaemonOutbound[] = [];
		// Dialog methods only reach the wire when a UI-capable client is attached.
		const uiClient = { supportsExtensionUi: true } as unknown as DaemonSocketClient;
		const state: ActiveSessionState = {
			activeSessionId,
			runtime,
			clients: new Set([uiClient]),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: `generation-${activeSessionId}`,
			lastEventSequence: 0,
		};
		return { state, outbound };
	}

	function dismissalsOf(outbound: DaemonOutbound[]): Extract<DaemonOutbound, { type: "extension_ui_dismiss" }>[] {
		return outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "extension_ui_dismiss" }> =>
				message.type === "extension_ui_dismiss",
		);
	}

	it("broadcasts extension_ui_dismiss with reason timeout when a dialog times out (R3-M3)", async () => {
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("timeout-dialog", {
					description: "dialog nobody answers",
					handler: async (_args, ctx) => {
						await ctx.ui.select("Pick one", ["a", "b"], { timeout: 30 });
					},
				});
			},
			["done"],
		);
		const { state, outbound } = bindDialogState(runtime, "active-timeout");
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("/timeout-dialog");

		const request = outbound.find(
			(message) => message.type === "extension_ui_request" && message.method === "select",
		);
		expect(request).toBeDefined();
		expect(dismissalsOf(outbound)).toEqual([
			{
				type: "extension_ui_dismiss",
				activeSessionId: "active-timeout",
				id: request && "id" in request ? request.id : "never",
				reason: "timeout",
			},
		]);
	});

	it("broadcasts extension_ui_dismiss with reason aborted when the dialog's signal aborts", async () => {
		const controller = new AbortController();
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("abort-dialog", {
					description: "dialog aborted mid-flight",
					handler: async (_args, ctx) => {
						await ctx.ui.select("Pick one", ["a", "b"], { signal: controller.signal });
					},
				});
			},
			["done"],
		);
		const { state, outbound } = bindDialogState(runtime, "active-abort");
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		const prompting = runtime.session.prompt("/abort-dialog");
		// State barrier: abort only once the request is actually on the wire.
		await vi.waitFor(() => {
			expect(outbound.some((message) => message.type === "extension_ui_request")).toBe(true);
		});
		controller.abort();
		await prompting;

		const dismissals = dismissalsOf(outbound);
		expect(dismissals).toHaveLength(1);
		expect(dismissals[0]).toMatchObject({
			type: "extension_ui_dismiss",
			activeSessionId: "active-abort",
			reason: "aborted",
		});
	});

	it("emits no dismissal when the request is answered through its pending entry (the answered announce belongs to handleExtensionUiResponse)", async () => {
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("answered-dialog", {
					description: "dialog answered in time",
					handler: async (_args, ctx) => {
						await ctx.ui.select("Pick one", ["a", "b"], { timeout: 10_000 });
					},
				});
			},
			["done"],
		);
		const { state, outbound } = bindDialogState(runtime, "active-answered");
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		const prompting = runtime.session.prompt("/answered-dialog");
		await vi.waitFor(() => {
			expect(state.extensionUiRequests.size).toBe(1);
		});
		const entry = [...state.extensionUiRequests.entries()][0];
		if (!entry) throw new Error("dialog request never registered");
		entry[1].resolve({ value: "a" });
		await prompting;

		expect(dismissalsOf(outbound)).toHaveLength(0);
	});

	it("marks daemon pasteToEditor as an insert, keeping setEditorText a replace", async () => {
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("paste-probe", {
					description: "paste probe",
					handler: async (_args, ctx) => {
						ctx.ui.pasteToEditor("insert me");
						ctx.ui.setEditorText("replace all");
					},
				});
			},
			["done"],
		);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-paste",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-paste",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("/paste-probe");

		// pasteToEditor mapped to a wholesale draft replace: a paste must insert at
		// the cursor (the in-process binding pastes through the editor's bracketed
		// path); the wire flag carries that intent and old clients keep replacing.
		const writes = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "extension_ui_request" }> =>
				message.type === "extension_ui_request" && message.method === "setEditorText",
		);
		expect(writes).toHaveLength(2);
		expect(writes[0]!.payload).toMatchObject({ text: "insert me", insert: true });
		expect(writes[1]!.payload).toMatchObject({ text: "replace all" });
		expect(writes[1]!.payload).not.toHaveProperty("insert");
	});
});
