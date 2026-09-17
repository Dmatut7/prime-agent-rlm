/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { FauxModelDefinition, FauxProviderRegistration, FauxResponseStep, Model } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import type { AgentObserveController } from "../../src/core/agent-observe.js";
import type { KernelResidencyFacts } from "../../src/core/agent-session.js";
import { AgentSession, type AgentSessionEvent, type AutoRefineReviewer } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { AgentAutonomousConfig } from "../../src/core/autonomous.js";
import type { ExtensionRunner } from "../../src/core/extensions/index.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import type { SubagentRuntimeHost } from "../../src/core/rlm-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { StallWatchdogTimers } from "../../src/core/stall-watchdog.js";
import type { JournaledBashFacts, TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.js";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.js";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	agentObserveController?: AgentObserveController;
	agentMessageController?: AgentSessionMessageController;
	subagentRuntimeHost?: SubagentRuntimeHost;
	persistSession?: boolean;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	includeGoals?: boolean;
	autonomous?: AgentAutonomousConfig;
	autoRefineReviewer?: AutoRefineReviewer;
	serializedRefine?: boolean;
	initialGoal?: { objective: string; tokenBudget?: number };
	stallAbortSettleGraceMs?: number;
	/** Fake-clock timers injected into the session's stall watchdog (deterministic driving). */
	stallWatchdogTimers?: StallWatchdogTimers;
	/** Kernel/host liveness facts behind the stall watchdog vouch (see turn-liveness.ts). */
	stallKernelLivenessFacts?: () => TurnLivenessKernelFacts | undefined;
	/** Degraded fact source used when the kernel heartbeat is stale or absent. */
	stallJournaledBashHandles?: (kernelPid: number | undefined) => JournaledBashFacts | undefined;
	/** Kernel residency facts behind the eviction-facing activity term (see agent-session.ts). */
	kernelResidencyFacts?: () => KernelResidencyFacts | undefined;
	rlmTerminalNoticeAbandonAfterMs?: number;
	failureWakeQuietWindowMs?: number;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		api: options.api,
		provider: options.provider,
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.persistSession
		? SessionManager.create(tempDir, join(tempDir, "sessions"))
		: SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader,
		agentObserveController: options.agentObserveController,
		agentMessageController: options.agentMessageController,
		subagentRuntimeHost: options.subagentRuntimeHost,
		baseToolsOverride: toolMap,
		extensionRunnerRef,
		rlmDepth: options.rlmDepth,
		rlmMaxDepth: options.rlmMaxDepth,
		includeGoals: options.includeGoals,
		autonomous: options.autonomous,
		autoRefineReviewer: options.autoRefineReviewer,
		serializedRefine: options.serializedRefine,
		initialGoal: options.initialGoal,
		stallAbortSettleGraceMs: options.stallAbortSettleGraceMs,
		stallWatchdogTimers: options.stallWatchdogTimers,
		stallKernelLivenessFacts: options.stallKernelLivenessFacts,
		stallJournaledBashHandles: options.stallJournaledBashHandles,
		kernelResidencyFacts: options.kernelResidencyFacts,
		rlmTerminalNoticeAbandonAfterMs: options.rlmTerminalNoticeAbandonAfterMs,
		failureWakeQuietWindowMs: options.failureWakeQuietWindowMs,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		modelRegistry,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				// Spawned fixture processes may still be flushing their final registry
				// writes; retry briefly instead of failing the suite on ENOTEMPTY.
				// Node's rmSync maxRetries does not cover ENOTEMPTY, so back off
				// manually; a cleanup failure must not fail an otherwise green suite.
				for (let attempt = 0; attempt < 20; attempt++) {
					try {
						rmSync(tempDir, { recursive: true, force: true });
						break;
					} catch (error) {
						if (attempt === 19) {
							console.warn(`harness cleanup gave up on ${tempDir}: ${String(error)}`);
							break;
						}
						// Flush window for fixture processes still writing.
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
					}
				}
			}
		},
	};
}
