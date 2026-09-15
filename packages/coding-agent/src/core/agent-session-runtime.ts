import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionRuntimeConfig } from "./agent-session-config.js";
import type {
	AgentSessionCreationOptions,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "./agent-session-services.js";
import { isNoModelsAvailableMessage } from "./auth-guidance.js";
import type { ReplacedSessionContext, SessionShutdownEvent, SessionStartEvent } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime, SubagentRuntimeHost } from "./rlm-runtime.js";
import type { CreateAgentSessionResult } from "./sdk.js";
import { assertSessionCwdExists } from "./session-cwd.js";
import { copyImportedSession, resolveImportDestination } from "./session-import-destination.js";
import { SessionImportFileNotFoundError } from "./session-import-errors.js";
import { acquireSessionLeaseAsync, canonicalSessionPath, type SessionLease } from "./session-lease.js";
import { repairOwnedSessionFile, SessionManager } from "./session-manager.js";
import { resolveCompleteToolPairLeaf } from "./session-tool-pair.js";

export { SessionImportFileNotFoundError } from "./session-import-errors.js";

const runtimeLog = getLogger("coding-agent.agent-session-runtime");

export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	sessionConfig?: AgentSessionRuntimeConfig;
	sessionOptions?: AgentSessionCreationOptions;
}) => Promise<CreateAgentSessionRuntimeResult>;

export type AgentSessionRuntimeKind = "top-level" | "subagent";

export interface AgentSessionRuntimeMetadata {
	kind: AgentSessionRuntimeKind;
	createdAt: number;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	rlmChildId?: string;
	rlmParentNodeId?: string;
	rehydratedCompleted?: boolean;
	prompt?: string;
	spawnCode?: string;
	sessionDir?: string;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * What a failed replacement build needs to put the previous session back: the
 * manager that was live before teardown still holds the transcript, in memory for
 * non-persisted sessions and on disk otherwise.
 */
interface ReplacementRollback {
	sessionManager: SessionManager;
	cwd: string;
	sessionFile: string | undefined;
}

export interface AgentSessionRuntimeDisposeOptions {
	/** Set false when the session's artifact dir is deleted right after disposal (default true). */
	kernelSnapshot?: boolean;
}

export class AgentSessionRuntime implements SubagentRuntimeHost {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private readonly sessionReplacedListeners = new Set<(session: AgentSession) => void | Promise<void>>();
	private runtimeEnvScope?: <T>(fn: () => Promise<T>) => Promise<T>;
	private beforeSessionInvalidate?: () => void;
	private subagentRuntimeHost?: SubagentRuntimeHost;
	private subagentRuntimes = new Map<string, AgentSessionRuntime>();
	private disposePromise?: Promise<void>;

	constructor(
		private _session: AgentSession,
		private _services: AgentSessionServices,
		private readonly createRuntime: CreateAgentSessionRuntimeFactory,
		private _diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		private _modelFallbackMessage?: string,
		private readonly sessionConfig?: AgentSessionRuntimeConfig,
		private readonly _metadata: AgentSessionRuntimeMetadata = {
			kind: "top-level",
			createdAt: Date.now(),
		},
		private _sessionLease?: SessionLease,
	) {
		this.bindRuntimeHost();
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		// The "no models available" warning describes session state, not a
		// startup event: once the session gains a model (set_model, /login,
		// onboarding), the stored snapshot is stale and must not reach clients.
		if (isNoModelsAvailableMessage(this._modelFallbackMessage) && this._session.model) {
			return undefined;
		}
		return this._modelFallbackMessage;
	}

	get metadata(): AgentSessionRuntimeMetadata {
		return { ...this._metadata };
	}

	get runtimeConfig(): AgentSessionRuntimeConfig | undefined {
		return this.sessionConfig ? { ...this.sessionConfig } : undefined;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	onSessionReplaced(listener: (session: AgentSession) => void | Promise<void>): () => void {
		this.sessionReplacedListeners.add(listener);
		return () => this.sessionReplacedListeners.delete(listener);
	}

	/**
	 * Host-installed scope wrapping every runtime rebuild (new/switch/fork/
	 * import and subagent creation), during which extensions re-load. The
	 * daemon uses it to apply the session's client env for load-time captures.
	 */
	setRuntimeEnvScope(scope?: <T>(fn: () => Promise<T>) => Promise<T>): void {
		this.runtimeEnvScope = scope;
	}

	private scopedBuild<T>(fn: () => Promise<T>): Promise<T> {
		return this.runtimeEnvScope ? this.runtimeEnvScope(fn) : fn();
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this.subagentRuntimeHost = host;
		this.bindRuntimeHost();
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		// Await the kernel's final snapshot flush before invalidating the session.
		await this.session.disposeAsync();
		await this.disposeHostedSubagentRuntimes();
	}

	private bindRuntimeHost(): void {
		this._session.setSubagentRuntimeHost(this.subagentRuntimeHost ?? this);
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.bindRuntimeHost();
	}

	private async acquireReplacementLease(sessionPath: string | undefined): Promise<SessionLease | undefined> {
		if (sessionPath && this._sessionLease?.sessionPath === canonicalSessionPath(sessionPath)) {
			return this._sessionLease;
		}
		return acquireSessionLeaseAsync(sessionPath, this.services.agentDir);
	}

	private releaseUncommittedLease(lease: SessionLease | undefined): void {
		if (lease !== this._sessionLease) {
			lease?.release();
		}
	}

	private releaseSessionLease(): void {
		this._sessionLease?.release();
		this._sessionLease = undefined;
	}

	private commitReplacementLease(lease: SessionLease | undefined): void {
		if (lease === this._sessionLease) {
			return;
		}
		const previous = this._sessionLease;
		this._sessionLease = lease;
		previous?.release();
	}

	private async buildAndApplyReplacement(
		build: () => Promise<CreateAgentSessionRuntimeResult>,
		lease: SessionLease | undefined,
		rollback?: ReplacementRollback,
	): Promise<void> {
		let result: CreateAgentSessionRuntimeResult;
		try {
			result = await build();
		} catch (error) {
			this.releaseUncommittedLease(lease);
			if (rollback) {
				await this.restoreAfterFailedReplacement(rollback, error);
			}
			throw error;
		}
		this.apply(result);
		this.commitReplacementLease(lease);
	}

	/**
	 * Teardown runs before the replacement build, so the previous session is
	 * already disposed when the build fails. Hand back what a rollback needs.
	 */
	private async teardownForReplacement(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile: string | undefined,
		lease: SessionLease | undefined,
	): Promise<ReplacementRollback> {
		const rollback: ReplacementRollback = {
			sessionManager: this.session.sessionManager,
			cwd: this.cwd,
			sessionFile: this.session.sessionFile,
		};
		try {
			await this.teardownCurrent(reason, targetSessionFile);
		} catch (error) {
			this.releaseUncommittedLease(lease);
			throw error;
		}
		return rollback;
	}

	/**
	 * A failed replacement build used to leave `_session` pointing at the disposed
	 * previous session: every later prompt then died with "Cannot admit a session
	 * action because the session is disposing or disposed" and only /new recovered.
	 * Rebuild the previous session from the manager that was live before teardown
	 * and re-point the host at it, so a failed switch leaves a usable runtime.
	 *
	 * Best-effort on purpose - the caller still reports the original build error.
	 * What cannot come back is what teardown already released (the previous kernel
	 * and its hosted subagent runtimes); the transcript itself is untouched, so the
	 * restored session resumes from it.
	 */
	private async restoreAfterFailedReplacement(rollback: ReplacementRollback, cause: unknown): Promise<void> {
		try {
			const restored = await this.scopedBuild(() =>
				this.createRuntime({
					cwd: rollback.cwd,
					agentDir: this.services.agentDir,
					sessionManager: rollback.sessionManager,
					sessionStartEvent: {
						type: "session_start",
						reason: "resume",
						previousSessionFile: rollback.sessionFile,
					},
					sessionConfig: this.sessionConfig,
				}),
			);
			this.apply(restored);
		} catch (restoreError) {
			runtimeLog.warn("session replacement failed and the previous session could not be restored", {
				sessionFile: rollback.sessionFile,
				error: restoreError instanceof Error ? restoreError.message : String(restoreError),
				cause: cause instanceof Error ? cause.message : String(cause),
			});
			return;
		}
		runtimeLog.warn("session replacement failed; restored the previous session", {
			sessionFile: rollback.sessionFile,
			cause: cause instanceof Error ? cause.message : String(cause),
		});
		try {
			// The session object changed, so the host must re-point at the restored
			// one; without this it keeps driving the disposed session.
			await this.finishSessionReplacement();
		} catch (rebindError) {
			runtimeLog.warn("host rebind after a restored session failed", {
				sessionFile: rollback.sessionFile,
				error: rebindError instanceof Error ? rebindError.message : String(rebindError),
			});
		}
	}

	private async disposeSubagentRuntimes(): Promise<void> {
		const runtimes = [...this.subagentRuntimes.values()];
		this.subagentRuntimes.clear();
		let disposeError: unknown;
		for (const runtime of runtimes) {
			try {
				await runtime.dispose();
			} catch (error) {
				disposeError ??= error;
			}
		}
		if (disposeError) {
			throw disposeError;
		}
	}

	private async disposeHostedSubagentRuntimes(): Promise<void> {
		let disposeError: unknown;
		try {
			await this.subagentRuntimeHost?.disposeRlmSubagentRuntimes?.();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			await this.disposeSubagentRuntimes();
		} catch (error) {
			disposeError ??= error;
		}
		if (disposeError) {
			throw disposeError;
		}
	}

	listSubagentRuntimes(): readonly AgentSessionRuntime[] {
		return [...this.subagentRuntimes.values()];
	}

	async createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		const childCwd = options.parentSession.sessionManager.getCwd();
		const sessionManager = options.parentSession.sessionManager.allowsPersistence()
			? SessionManager.create(childCwd, options.sessionDir)
			: SessionManager.inMemory(childCwd, options.sessionDir);
		sessionManager.newSession({
			parentSession: options.parentSession.sessionFile,
			rlmDepth: options.rlmDepth,
		});
		const runtime = await this.scopedBuild(() =>
			createAgentSessionRuntime(this.createRuntime, {
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
				sessionConfig: this.sessionConfig,
				sessionOptions: {
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					serviceTier: options.serviceTier,
					scopedModels: options.scopedModels,
					initialActiveToolNames: options.activeToolNames,
					allowedToolNames: options.allowedToolNames,
					customTools: options.customTools,
					includeGoals: options.includeGoals,
					includeCompactSkill: options.includeCompactSkill,
					rlmDepth: options.rlmDepth,
					rlmMaxDepth: options.rlmMaxDepth,
					rlmSessionDir: options.sessionDir,
					rlmParentNodeId: options.rlmParentNodeId,
					rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
					semanticParentSessionId: options.parentSession.sessionId,
					semanticSpawnedByRequestId: options.spawnedByRequestId,
				},
				runtimeMetadata: {
					kind: "subagent",
					createdAt: Date.now(),
					parentSessionId: options.parentSession.sessionId,
					parentSessionFile: options.parentSession.sessionFile,
					rlmChildId: options.id,
					rlmParentNodeId: options.rlmParentNodeId,
					prompt: options.prompt,
					spawnCode: options.spawnCode,
					sessionDir: options.sessionDir,
				},
			}),
		);
		this.subagentRuntimes.set(options.id, runtime);
		try {
			await runtime.session.bindExtensions({});
			if (options.parentSession.getRlmChildRunStatus(options.id) === "cancelled") {
				throw new Error("RLM subagent startup was cancelled");
			}
			if (runtime.session.sessionName !== options.sessionName) {
				runtime.session.setSessionName(options.sessionName);
			}
			options.onSessionPublished?.(runtime.session);
		} catch (error) {
			this.subagentRuntimes.delete(options.id);
			await runtime.dispose();
			throw error;
		}
		return runtime;
	}

	async deleteRlmSubagentRuntime(childId: string, session: AgentSession): Promise<void> {
		const runtime = this.subagentRuntimes.get(childId);
		if (!runtime) {
			await session.disposeAsync();
			return;
		}
		this.subagentRuntimes.delete(childId);
		const shouldDisposeStaleSession = runtime.session !== session;
		try {
			await runtime.dispose();
		} finally {
			if (shouldDisposeStaleSession) {
				await session.disposeAsync();
			}
		}
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		for (const listener of this.sessionReplacedListeners) {
			await listener(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const lease = await this.acquireReplacementLease(sessionPath);
		let sessionManager: SessionManager;
		try {
			// This replacement takes over the write side of the file, so repair a
			// crash-torn tail before the open: the next append would otherwise glue
			// itself onto the torn line and both records would stop parsing.
			repairOwnedSessionFile(sessionPath);
			sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			this.releaseUncommittedLease(lease);
			throw error;
		}
		const rollback = await this.teardownForReplacement("resume", sessionManager.getSessionFile(), lease);
		await this.buildAndApplyReplacement(
			() =>
				this.scopedBuild(() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: "resume",
							previousSessionFile,
						},
						sessionConfig: this.sessionConfig,
					}),
				),
			lease,
			rollback,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = SessionManager.create(this.cwd, sessionDir);
		if (options?.parentSession) {
			sessionManager.newSession({
				parentSession: options.parentSession,
				rlmDepth: this.session.sessionManager.getHeader()?.rlmDepth ?? this.session.rlmDepth,
			});
		}
		const lease = await this.acquireReplacementLease(sessionManager.getSessionFile());

		const rollback = await this.teardownForReplacement("new", sessionManager.getSessionFile(), lease);
		await this.buildAndApplyReplacement(
			() =>
				this.scopedBuild(() =>
					this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: "new",
							previousSessionFile,
						},
						sessionConfig: this.sessionConfig,
					}),
				),
			lease,
			rollback,
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		if (targetLeafId) {
			targetLeafId = resolveCompleteToolPairLeaf(this.session.sessionManager.getBranch(targetLeafId))?.id ?? null;
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.allowsPersistence()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sourceHeader = this.session.sessionManager.getHeader();
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({
					parentSession: currentSessionFile,
					rlmDepth: sourceHeader?.rlmDepth ?? this.session.rlmDepth,
				});
				const lease = await this.acquireReplacementLease(sessionManager.getSessionFile());
				const rollback = await this.teardownForReplacement("fork", sessionManager.getSessionFile(), lease);
				await this.buildAndApplyReplacement(
					() =>
						this.scopedBuild(() =>
							this.createRuntime({
								cwd: this.cwd,
								agentDir: this.services.agentDir,
								sessionManager,
								sessionStartEvent: {
									type: "session_start",
									reason: "fork",
									previousSessionFile,
								},
								sessionConfig: this.sessionConfig,
							}),
						),
					lease,
					rollback,
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			// The source file is this runtime's live session: repairing its torn tail
			// before the re-open keeps the fork from silently missing the torn record
			// (and keeps the runtime's own next append from gluing onto it).
			repairOwnedSessionFile(currentSessionFile);
			const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sourceManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			repairOwnedSessionFile(forkedSessionPath);
			const sessionManager = SessionManager.open(forkedSessionPath, sessionDir);
			const lease = await this.acquireReplacementLease(sessionManager.getSessionFile());
			const rollback = await this.teardownForReplacement("fork", sessionManager.getSessionFile(), lease);
			await this.buildAndApplyReplacement(
				() =>
					this.scopedBuild(() =>
						this.createRuntime({
							cwd: sessionManager.getCwd(),
							agentDir: this.services.agentDir,
							sessionManager,
							sessionStartEvent: {
								type: "session_start",
								reason: "fork",
								previousSessionFile,
							},
							sessionConfig: this.sessionConfig,
						}),
					),
				lease,
				rollback,
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			const sourceHeader = sessionManager.getHeader();
			sessionManager.newSession({
				parentSession: this.session.sessionFile,
				rlmDepth: sourceHeader?.rlmDepth ?? this.session.rlmDepth,
			});
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		const lease = await this.acquireReplacementLease(sessionManager.getSessionFile());
		const rollback = await this.teardownForReplacement("fork", sessionManager.getSessionFile(), lease);
		await this.buildAndApplyReplacement(
			() =>
				this.scopedBuild(() =>
					this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: "fork",
							previousSessionFile,
						},
						sessionConfig: this.sessionConfig,
					}),
				),
			lease,
			rollback,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * The transcript is copied into the session directory under its own basename.
	 * A basename that is already taken by a *different* transcript does not get
	 * overwritten: the copy moves to a free sibling name and receives a session id
	 * of its own, so an import can never destroy a registered session. A session id
	 * that another transcript in the directory already declares is reassigned the
	 * same way, even under a free name, because `--resume <id>` and the artifact
	 * directory are both keyed on it. Importing byte-identical content reuses the
	 * file that is already there.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destination = resolveImportDestination(resolvedPath, join(sessionDir, basename(resolvedPath)));
		const destinationPath = destination.path;
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const lease = await this.acquireReplacementLease(destinationPath);
		let sessionManager: SessionManager;
		try {
			if (!destination.reusedExisting && resolve(destinationPath) !== resolvedPath) {
				copyImportedSession(resolvedPath, destinationPath, {
					renamed: destination.renamed,
					sessionId: destination.sessionId,
				});
			}

			// A copied import can carry a torn tail from its source file; repair it
			// before the open so the runtime's first append does not glue onto it.
			repairOwnedSessionFile(destinationPath);
			sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			this.releaseUncommittedLease(lease);
			throw error;
		}
		const rollback = await this.teardownForReplacement("resume", sessionManager.getSessionFile(), lease);
		await this.buildAndApplyReplacement(
			() =>
				this.scopedBuild(() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: "resume",
							previousSessionFile,
						},
						sessionConfig: this.sessionConfig,
					}),
				),
			lease,
			rollback,
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	private async disposeOnce(options: AgentSessionRuntimeDisposeOptions): Promise<void> {
		let disposeError: unknown;
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
		} catch (error) {
			disposeError ??= error;
		}
		try {
			this.beforeSessionInvalidate?.();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			// Await the kernel's final snapshot flush before tearing the session down.
			await this.session.disposeAsync({ kernelSnapshot: options.kernelSnapshot ?? true });
		} catch (error) {
			disposeError ??= error;
		}
		try {
			await this.disposeHostedSubagentRuntimes();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			if (disposeError) {
				throw disposeError;
			}
		} finally {
			this.releaseSessionLease();
		}
	}

	async dispose(options?: AgentSessionRuntimeDisposeOptions): Promise<void> {
		if (!this.disposePromise) {
			this.disposePromise = this.disposeOnce(options ?? {});
		}
		await this.disposePromise;
	}
}

export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		sessionConfig?: AgentSessionRuntimeConfig;
		sessionOptions?: AgentSessionCreationOptions;
		runtimeMetadata?: AgentSessionRuntimeMetadata;
		sessionLease?: SessionLease;
	},
): Promise<AgentSessionRuntime> {
	const { sessionLease, ...runtimeOptions } = options;
	const lease =
		sessionLease ??
		(await acquireSessionLeaseAsync(runtimeOptions.sessionManager.getSessionFile(), runtimeOptions.agentDir));
	try {
		assertSessionCwdExists(runtimeOptions.sessionManager, runtimeOptions.cwd);
		const result = await createRuntime(runtimeOptions);
		return new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
			runtimeOptions.sessionConfig,
			runtimeOptions.runtimeMetadata,
			lease,
		);
	} catch (error) {
		lease?.release();
		throw error;
	}
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.js";
