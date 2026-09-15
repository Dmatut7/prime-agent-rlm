import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.js";
import type { AgentSessionMessageController } from "./agent-messages.js";
import type { AgentObserveController } from "./agent-observe.js";
import type { AgentExecutionMode } from "./agent-session-config.js";
import { installAgentTraceUpload } from "./agent-traces.js";
import { AuthStorage } from "./auth-storage.js";
import type { AgentAutonomousConfig } from "./autonomous.js";
import type { AgentRlmHeartbeatController } from "./cron-jobs.js";
import { createHerdrAgentStateExtension } from "./extensions/builtin/herdr-agent-state.js";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.js";
import type { SubagentRuntimeHost } from "./rlm-runtime.js";
import { type CreateAgentSessionResult, createAgentSession } from "./sdk.js";
import { semanticEdgeLedgerPath } from "./semantic-edges.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { installAgentTelemetry, isTelemetryEnabled } from "./telemetry.js";

export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	/**
	 * Skip the built-in Herdr reporter for these services. Set for RLM subagent
	 * runtimes: they inherit the parent's HERDR_* pane identity, so their own
	 * reporter would race the parent's on the same pane and a subagent quit
	 * would release the pane while the parent is still running.
	 */
	noBuiltinHerdrReporter?: boolean;
	telemetryDisabled?: true;
	/**
	 * Stop watching `settings.json` for direct edits (CD-5). Watching is on by
	 * default wherever a session is created, because "the session keeps reading
	 * the file it loaded once" is the behaviour CD-5 reported; the watcher is
	 * unref'ed, so it never holds a process open. Callers that own the settings
	 * files themselves (tests writing them on purpose) can switch it off.
	 */
	watchSettingsFile?: boolean;
}

export interface AgentSessionCreationOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: "all" | "builtin";
	customTools?: ToolDefinition[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	includeGoals?: boolean;
	includeCompactSkill?: boolean;
	agentMessageController?: AgentSessionMessageController;
	agentObserveController?: AgentObserveController;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	rlmParentAgent?: string;
	semanticParentSessionId?: string;
	semanticSpawnedByRequestId?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	prewarmIpythonKernel?: boolean;
	autonomous?: AgentAutonomousConfig;
	serializedRefine?: boolean;
	executionMode?: AgentExecutionMode;
	telemetryDisabled?: true;
	initialGoal?: { objective: string; tokenBudget?: number };
}

export interface CreateAgentSessionFromServicesOptions extends AgentSessionCreationOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}

export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	mcpManager: McpManager;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	/**
	 * The one-time telemetry disclosure, when this run owes the user one (TEL-4).
	 *
	 * It is a separate field rather than only a diagnostic because the disclosure
	 * must be *shown* once, and the process that creates these services is not
	 * always a process a human is looking at: a daemon worker or `--print` run
	 * used to spend the one-time flag on a stderr line nobody saw, so the next
	 * interactive start stayed silent. Only a caller that really puts the notice
	 * in front of the user calls {@link markTelemetryNoticeShown}; everyone else
	 * may print it as a diagnostic and leave the flag alone.
	 */
	telemetryNotice?: string;
}

/** The disclosure text, in one place: `services.telemetryNotice` and its diagnostic carry it. */
export const TELEMETRY_NOTICE_MESSAGE =
	"Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode.";

/**
 * Record that the telemetry disclosure was shown to a human. Nothing else may
 * call this: an unseen notice is not a shown notice (TEL-4).
 */
export function markTelemetryNoticeShown(settingsManager: SettingsManager): void {
	settingsManager.setTelemetryNoticeShown(true);
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));

	// MCP integrations: registers OAuth providers and gates the built-in
	// integration skills by whether the user is logged in (enable-by-login).
	const mcpManager = new McpManager({
		authStorage,
		getUserServers: () => settingsManager.getGlobalMcpServers(),
	});
	// refresh() resets the OAuth registry to built-ins; re-add user MCP providers too.
	modelRegistry.setOnOAuthProvidersReset(() => mcpManager.registerUserProviders());

	const userExtensionFactories = options.resourceLoaderOptions?.extensionFactories ?? [];
	// The built-in Herdr reporter defers to Herdr's own file-based integration
	// when the loader actually loaded it; two reporters would race on the same
	// pane. Deferral is late-bound to the loader's loaded paths (inline
	// factories run after file extensions load), so a file that exists but is
	// disabled or never discovered does not silence the built-in.
	// noExtensions is a full opt-out: it disables the built-in reporter too,
	// not just discovered extension files.
	const skipHerdrReporter = options.noBuiltinHerdrReporter || options.resourceLoaderOptions?.noExtensions;
	const builtinExtensionFactories = skipHerdrReporter
		? []
		: [createHerdrAgentStateExtension(() => resourceLoader.getLoadedExtensionPaths())];
	const resourceLoader: DefaultResourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		extensionFactories: [...builtinExtensionFactories, ...userExtensionFactories],
		cwd,
		agentDir,
		settingsManager,
		extraBuiltinSkillOverrides: () => mcpManager.getDisabledBuiltinSkillOverrides(),
	});
	await resourceLoader.reload();

	// CD-5: a direct edit of settings.json used to be invisible to a running
	// session until it was restarted. Watch the file so the edit is loaded into
	// the session that is running, and record it so a UI can say so.
	if (options.watchSettingsFile !== false) {
		settingsManager.watchExternalSettings();
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// TEL-4: build the notice, but do not spend the one-time flag here. This
	// function runs in every process that needs services (interactive client,
	// daemon worker, --print, RPC), and spending the flag in whichever ran first
	// is how the disclosure ended up reaching nobody: the worker's stderr line
	// consumed it before the user's terminal ever existed. The caller that can
	// actually display it marks it shown via markTelemetryNoticeShown().
	let telemetryNotice: string | undefined;
	if (
		!options.telemetryDisabled &&
		isTelemetryEnabled(settingsManager) &&
		!settingsManager.getTelemetryNoticeShown()
	) {
		telemetryNotice = TELEMETRY_NOTICE_MESSAGE;
		diagnostics.push({ type: "info", message: telemetryNotice });
	}
	// A models.json that failed to load is visible in the interactive UI and in
	// `model list`, but a print, RPC or daemon client sees only diagnostics: the failure
	// must not live in the registry alone. Warning, not error - the built-in models
	// still work, and startup must not die on a broken config file.
	const modelsJsonError = modelRegistry.getError();
	if (modelsJsonError) {
		diagnostics.push({ type: "warning", message: modelsJsonError });
	}

	// Deprecated keys in a models.json that still loads: the registry reports them
	// separately from the load error, and a print/RPC/daemon client needs them here.
	for (const modelsJsonWarning of modelRegistry.getWarnings()) {
		diagnostics.push({ type: "warning", message: modelsJsonWarning });
	}

	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		mcpManager,
		diagnostics,
		...(telemetryNotice === undefined ? {} : { telemetryNotice }),
	};
}

export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	installAgentTraceUpload(options.sessionManager, {
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		// A non-persisted session (an in-memory root and its RLM descendants) must leave
		// nothing on disk, so the ledger is only wired up when persistence is allowed.
		semanticEdgesLedgerPath: options.sessionManager.allowsPersistence()
			? semanticEdgeLedgerPath({
					rlmSessionDir: options.rlmSessionDir,
					sessionArtifactDir: options.sessionManager.getSessionArtifactDir(),
				})
			: undefined,
	});
	const result = await createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		mcpManager: options.services.mcpManager,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		serviceTier: options.serviceTier,
		scopedModels: options.scopedModels,
		tools: options.tools,
		noTools: options.noTools,
		customTools: options.customTools,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		includeGoals: options.includeGoals,
		includeCompactSkill: options.includeCompactSkill,
		agentMessageController: options.agentMessageController,
		agentObserveController: options.agentObserveController,
		rlmDepth: options.rlmDepth,
		rlmMaxDepth: options.rlmMaxDepth,
		rlmSessionDir: options.rlmSessionDir,
		rlmParentNodeId: options.rlmParentNodeId,
		rlmParentAgent: options.rlmParentAgent,
		semanticParentSessionId: options.semanticParentSessionId,
		semanticSpawnedByRequestId: options.semanticSpawnedByRequestId,
		subagentRuntimeHost: options.subagentRuntimeHost,
		rlmHeartbeatController: options.rlmHeartbeatController,
		sessionStartEvent: options.sessionStartEvent,
		prewarmIpythonKernel: options.prewarmIpythonKernel,
		autonomous: options.autonomous,
		serializedRefine: options.serializedRefine,
		initialGoal: options.initialGoal,
	});
	if (result.session.rlmDepth === 0 && !options.telemetryDisabled) {
		installAgentTelemetry(result.session, {
			agentDir: options.services.agentDir,
			settingsManager: options.services.settingsManager,
			executionMode: options.executionMode,
		});
	}
	return result;
}
