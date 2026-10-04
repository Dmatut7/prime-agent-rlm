import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener, PromptOptions } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { emptyGoalState } from "../src/core/goals.js";
import {
	type CustomEntry,
	SESSION_TREE_MAX_WIRE_DEPTH,
	SESSION_TREE_MAX_WIRE_NODES,
	type SessionEntry,
} from "../src/core/session-manager.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../src/modes/agent-connection/types.js";

type RuntimeSession = AgentSessionRuntime["session"];
type RuntimeRebindCallback = Parameters<AgentSessionRuntime["setRebindSession"]>[0];
type RuntimeBeforeInvalidateCallback = Parameters<AgentSessionRuntime["setBeforeSessionInvalidate"]>[0];

interface FakeSessionControl {
	session: RuntimeSession;
	compactionPerModel: Map<string, boolean>;
	compactionPerModelWrites: Array<[string | undefined, boolean]>;
	compactionGlobalWrites: boolean[];
	listenerCount(): number;
	unsubscribeCount(): number;
	emit(event: AgentSessionEvent): void;
}

class FakeRuntime {
	private _session: RuntimeSession;
	rebindSession: RuntimeRebindCallback;
	beforeSessionInvalidate: RuntimeBeforeInvalidateCallback;
	disposed = false;

	constructor(session: RuntimeSession) {
		this._session = session;
	}

	get session(): RuntimeSession {
		return this._session;
	}

	setRebindSession(callback?: RuntimeRebindCallback): void {
		this.rebindSession = callback;
	}

	setBeforeSessionInvalidate(callback?: RuntimeBeforeInvalidateCallback): void {
		this.beforeSessionInvalidate = callback;
	}

	invalidateCurrentSession(): void {
		this.beforeSessionInvalidate?.();
	}

	async replaceSession(session: RuntimeSession): Promise<void> {
		this._session = session;
		await this.rebindSession?.(session);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function asRuntime(runtime: FakeRuntime): AgentSessionRuntime {
	return runtime as unknown as AgentSessionRuntime;
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp,
	};
}

function createFakeSession(
	id: string,
	messages: AgentMessage[],
	options: { model?: { provider: string; id: string } } = {},
): FakeSessionControl {
	const listeners = new Set<AgentSessionEventListener>();
	let unsubscriptions = 0;
	const compactionPerModel = new Map<string, boolean>();
	const compactionPerModelWrites: Array<[string | undefined, boolean]> = [];
	const compactionGlobalWrites: boolean[] = [];
	const thinkingLevel: AgentConnectionState["thinkingLevel"] = "medium";
	const buildSessionContext = () => ({
		messages,
		thinkingLevel,
		model: null,
	});
	const model = getModel("openai", "gpt-5.1");
	const session = {
		sessionManager: {
			getCwd: () => `/tmp/${id}`,
			getSessionDir: () => "/tmp/prime-agent-sessions",
			getLeafId: () => `${id}-leaf`,
			getEntries: () => [],
			getTree: () => [],
			// The snapshot ships the depth-bounded tree, so the double has to answer the
			// bounded request the real SessionManager answers. The stats are distinctive on
			// purpose: the snapshot must forward what the manager measured (including a
			// truncation), not invent its own.
			getBoundedTree: () => ({
				tree: [
					{
						entry: {
							type: "message",
							id: `${id}-node`,
							parentId: null,
							timestamp: new Date(1).toISOString(),
							message: messages[0] ?? userMessage("tree node", 1),
						},
						children: [],
					},
				],
				stats: {
					entries: 3,
					returnedNodes: 1,
					omittedNodes: 2,
					maxDepth: SESSION_TREE_MAX_WIRE_DEPTH + 2,
					depthLimit: SESSION_TREE_MAX_WIRE_DEPTH,
					// The r19 anchor semantics: the live leaf survived the bound and the
					// shallowest retained node sits one level down.
					maxNodes: SESSION_TREE_MAX_WIRE_NODES,
					retainedFromDepth: 1,
					leafIncluded: true,
					truncated: true,
				},
			}),
			buildSessionContext,
		},
		buildSessionContext,
		model: options.model,
		thinkingLevel,
		getAvailableThinkingLevels: () => ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: `/tmp/${id}.jsonl`,
		sessionId: id,
		sessionName: `${id} name`,
		autoCompactionEnabled: true,
		// Settings-side collaborator: the connection resolves and writes the
		// auto-compaction switch through the settings manager (per serving model),
		// never through the session's own flag.
		settingsManager: {
			getCompactionEnabled: () => true,
			getCompactionEnabledForModel: (modelKey: string | undefined) =>
				(modelKey !== undefined ? compactionPerModel.get(modelKey) : undefined) ?? true,
			setCompactionEnabled: (enabled: boolean) => {
				compactionGlobalWrites.push(enabled);
			},
			setCompactionEnabledForModel: (modelKey: string | undefined, enabled: boolean) => {
				compactionPerModelWrites.push([modelKey, enabled]);
				if (modelKey !== undefined) {
					compactionPerModel.set(modelKey, enabled);
				}
			},
		},
		messages,
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		goalState: emptyGoalState(),
		modelRegistry: {
			refreshModelCatalog: async () => ({ models: model ? [model] : [], configuredProviders: ["openai"] }),
		},
		scopedModels: [],
		getActiveToolNames: () => ["ipython"],
		getContextUsage: () => undefined,
		cancelRlmChildRun: (childId: string) => childId === "child-1",
		getRlmChildSnapshots: () => [],
		getToolDefinition: (toolName: string) => ({
			name: toolName,
			label: toolName,
			description: `${toolName} description`,
			promptSnippet: `${toolName} prompt`,
			promptGuidelines: [`Use ${toolName}`],
			parameters: { type: "object" },
			renderShell: "self",
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			renderCall: () => undefined,
			renderResult: () => undefined,
		}),
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => {
				unsubscriptions++;
				listeners.delete(listener);
			};
		},
	} as unknown as RuntimeSession;

	return {
		session,
		compactionPerModel,
		compactionPerModelWrites,
		compactionGlobalWrites,
		listenerCount: () => listeners.size,
		unsubscribeCount: () => unsubscriptions,
		emit(event: AgentSessionEvent) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
	};
}

describe("InProcessAgentConnection", () => {
	it("returns the bounded session tree with its stats, not an unbounded tree", async () => {
		const session = createFakeSession("tree-bound", [userMessage("hello", 1)]);
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const sessionTree = await connection.getSessionTree();

		// The tree comes from getBoundedTree (the fake's single bounded node), not from
		// the unbounded getTree() (empty in the fake): the in-process connection must
		// offer the same bounded contract the daemon connection does.
		expect(sessionTree.tree).toHaveLength(1);
		expect(sessionTree.tree[0]?.entry.id).toBe("tree-bound-node");
		expect(sessionTree.leafId).toBe("tree-bound-leaf");
		expect(sessionTree.bound).toEqual({
			entries: 3,
			returnedNodes: 1,
			omittedNodes: 2,
			maxDepth: SESSION_TREE_MAX_WIRE_DEPTH + 2,
			depthLimit: SESSION_TREE_MAX_WIRE_DEPTH,
			maxNodes: SESSION_TREE_MAX_WIRE_NODES,
			retainedFromDepth: 1,
			leafIncluded: true,
			truncated: true,
		});
	});

	it.each([
		{ accepted: true, promptResult: "pending", expectedError: undefined },
		{ accepted: false, promptResult: "resolve", expectedError: "Prompt was not accepted by the session." },
		{ accepted: false, promptResult: "reject", expectedError: "real session error" },
	] as const)(
		"settles bare prompts from admission (accepted: $accepted, result: $promptResult)",
		async ({ accepted, promptResult, expectedError }) => {
			const session = createFakeSession("prompt-admission", []);
			let finishTurn = () => {};
			const turn = new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
			const prompt = vi.fn((_message: string, options?: PromptOptions) => {
				options?.preflightResult?.(accepted);
				if (promptResult === "pending") return turn;
				if (promptResult === "reject") return Promise.reject(new Error("real session error"));
				return Promise.resolve();
			});
			Object.assign(session.session, { prompt });
			const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));
			const result = expect(connection.prompt("hello"));

			if (expectedError) await result.rejects.toThrow(expectedError);
			else await result.resolves.toBeUndefined();
			expect(prompt).toHaveBeenCalledWith(
				"hello",
				expect.objectContaining({ preflightResult: expect.any(Function) }),
			);
			finishTurn();
		},
	);
	it("forwards prompt admission cancellation to the session", async () => {
		const session = createFakeSession("prompt-cancellation", []);
		const prompt = vi.fn(
			(_message: string, options?: PromptOptions) =>
				new Promise<void>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("Prompt admission was cancelled.")), {
						once: true,
					});
				}),
		);
		Object.assign(session.session, { prompt });
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));
		const controller = new AbortController();

		const admission = connection.prompt("hello", { signal: controller.signal });
		controller.abort();

		await expect(admission).rejects.toThrow("Prompt admission was cancelled.");
		expect(prompt).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ signal: controller.signal, preflightResult: expect.any(Function) }),
		);
	});

	it("loads the full model catalog through the connection boundary", async () => {
		const session = createFakeSession("models", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		const catalog = await connection.getModelCatalog();

		expect(catalog.configuredProviders).toEqual(["openai"]);
		expect(catalog.models).toHaveLength(1);
		expect(catalog.models[0]).toMatchObject({ provider: "openai", id: "gpt-5.1" });
	});

	it("exposes serializable tool metadata without local execution or renderer callbacks", async () => {
		const session = createFakeSession("tools", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		const definition = await connection.getToolDefinition("custom_tool");

		expect(definition).toEqual({
			name: "custom_tool",
			label: "custom_tool",
			description: "custom_tool description",
			promptSnippet: "custom_tool prompt",
			promptGuidelines: ["Use custom_tool"],
			parameters: { type: "object" },
			renderShell: "self",
		});
		expect(definition).not.toHaveProperty("execute");
		expect(definition).not.toHaveProperty("renderCall");
		expect(definition).not.toHaveProperty("renderResult");
	});

	it("cancels rlm child runs through the session", async () => {
		const session = createFakeSession("rlm", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		await expect(connection.cancelRlmChild("child-1")).resolves.toBe(true);
		await expect(connection.cancelRlmChild("finished-child")).resolves.toBe(false);
	});

	it("loads session context through the connection boundary", async () => {
		const session = createFakeSession("ctx", [userMessage("context", 1)]);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		await expect(connection.getSessionContext()).resolves.toEqual({
			messages: [userMessage("context", 1)],
			thinkingLevel: "medium",
			model: null,
		});
	});

	it("builds initial snapshots from the current runtime", async () => {
		const messages = [userMessage("snapshot context", 1)];
		const session = createFakeSession("snapshot", messages);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot).toMatchObject({
			state: {
				cwd: "/tmp/snapshot",
				sessionId: "snapshot",
				messageCount: 1,
				leafId: "snapshot-leaf",
			},
			messages: [userMessage("snapshot context", 1)],
			sessionContext: {
				messages: [userMessage("snapshot context", 1)],
				thinkingLevel: "medium",
				model: null,
			},
			sessionTree: {
				tree: [
					{
						entry: {
							type: "message",
							id: "snapshot-node",
							parentId: null,
							timestamp: new Date(1).toISOString(),
							message: userMessage("snapshot context", 1),
						},
					},
				],
				leafId: "snapshot-leaf",
				// The bound rides with the tree: a client that receives a truncated tree must be
				// able to say so, and the snapshot may not restate the manager's numbers.
				bound: {
					entries: 3,
					returnedNodes: 1,
					omittedNodes: 2,
					maxDepth: SESSION_TREE_MAX_WIRE_DEPTH + 2,
					depthLimit: SESSION_TREE_MAX_WIRE_DEPTH,
					maxNodes: SESSION_TREE_MAX_WIRE_NODES,
					retainedFromDepth: 1,
					leafIncluded: true,
					truncated: true,
				},
			},
		});
		messages.push(userMessage("later context", 2));
		expect(snapshot.messages).toEqual([userMessage("snapshot context", 1)]);
	});

	it("emits replacement snapshots and rebinds events when the runtime replaces its session", async () => {
		const oldSession = createFakeSession("old", [userMessage("old", 1)]);
		const newSession = createFakeSession("new", [userMessage("new", 2)]);
		const runtime = new FakeRuntime(oldSession.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));
		const invalidations: string[] = [];
		const events: AgentConnectionEvent[] = [];

		connection.onBeforeSessionInvalidate(() => {
			invalidations.push("invalidated");
		});
		connection.subscribe((event) => {
			events.push(event);
		});

		expect(oldSession.listenerCount()).toBe(1);
		runtime.invalidateCurrentSession();

		await runtime.replaceSession(newSession.session);

		expect(invalidations).toEqual(["invalidated"]);
		expect(oldSession.listenerCount()).toBe(0);
		expect(oldSession.unsubscribeCount()).toBe(1);
		expect(newSession.listenerCount()).toBe(1);
		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					cwd: "/tmp/new",
					sessionId: "new",
					sessionName: "new name",
					messageCount: 1,
					leafId: "new-leaf",
					activeToolNames: ["ipython"],
				}),
				messages: [userMessage("new", 2)],
			},
		]);

		events.length = 0;
		oldSession.emit({ type: "session_action_update", actions: { queuedCount: 1, steering: ["old"], followUps: [] } });
		newSession.emit({
			type: "session_action_update",
			actions: { queuedCount: 2, steering: ["new"], followUps: ["later"] },
		});

		expect(events).toEqual([
			{
				type: "session_event",
				event: {
					type: "session_action_update",
					actions: { queuedCount: 2, steering: ["new"], followUps: ["later"] },
				},
			},
		]);

		await connection.dispose();

		expect(newSession.listenerCount()).toBe(0);
		expect(runtime.rebindSession).toBeUndefined();
		expect(runtime.beforeSessionInvalidate).toBeUndefined();
		expect(runtime.disposed).toBe(true);
	});
});

describe("initial snapshot quotaPark", () => {
	// Mirrors the daemon attach snapshot (rev 43): the in-process adapter never
	// emits quota_park_status events, so the initial snapshot is the only channel
	// through which an in-process client learns the session is parked.
	const resumeAt = new Date(Date.now() + 3_600_000).toISOString();

	function parkEntry(data: { resumeAt: string; parkCount: number; provider?: string }): CustomEntry {
		return {
			id: "park-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			type: "custom",
			customType: "provider_quota_park",
			data,
		};
	}

	function resumeEntry(): CustomEntry {
		return {
			id: "resume-1",
			parentId: "park-1",
			timestamp: new Date(2).toISOString(),
			type: "custom",
			customType: "provider_quota_resume",
			data: { outcome: "wake" },
		};
	}

	function parkedFakeSession(id: string, branch: SessionEntry[]): FakeSessionControl {
		const control = createFakeSession(id, [userMessage("parked", 1)]);
		Object.assign(control.session, { isQuotaParked: true });
		Object.assign(control.session.sessionManager, { getBranch: () => branch });
		return control;
	}

	it("seeds the snapshot quotaPark from the persisted park entry", async () => {
		const session = parkedFakeSession("parked", [parkEntry({ resumeAt, parkCount: 2, provider: "openai" })]);
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot.quotaPark).toMatchObject({ parked: true, resumeAt, parkCount: 2, provider: "openai" });
		expect(snapshot.quotaPark?.remainingMs).toBeGreaterThan(3_600_000 - 60_000);
		expect(snapshot.quotaPark?.remainingMs).toBeLessThanOrEqual(3_600_000);
	});

	it("omits quotaPark when the session is not parked, without walking the branch", async () => {
		const session = createFakeSession("idle", [userMessage("idle", 1)]);
		Object.assign(session.session, { isQuotaParked: false });
		Object.assign(session.session.sessionManager, {
			getBranch: () => {
				throw new Error("branch must not be walked for a session that is not parked");
			},
		});
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot.quotaPark).toBeUndefined();
		expect("quotaPark" in snapshot).toBe(false);
	});

	it("treats a resume entry newer than the park entry as a spent park", async () => {
		const session = parkedFakeSession("spent", [parkEntry({ resumeAt, parkCount: 1 }), resumeEntry()]);
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot.quotaPark).toBeUndefined();
		expect("quotaPark" in snapshot).toBe(false);
	});

	it("carries parked:true alone when the park has no persisted entry", async () => {
		const session = parkedFakeSession("in-memory", []);
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot.quotaPark).toEqual({ parked: true });
	});

	it("still returns the snapshot when the branch is unreadable mid-teardown", async () => {
		const session = createFakeSession("teardown", [userMessage("teardown", 1)]);
		Object.assign(session.session, { isQuotaParked: true });
		Object.assign(session.session.sessionManager, {
			getBranch: () => {
				throw new Error("session is mid-teardown");
			},
		});
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		const snapshot = await connection.getInitialSnapshot();

		expect(snapshot.quotaPark).toBeUndefined();
		expect("quotaPark" in snapshot).toBe(false);
		expect(snapshot.messages).toEqual([userMessage("teardown", 1)]);
	});

	it("writes the serving model's per-model entry when auto-compaction is toggled", async () => {
		const session = createFakeSession("per-model", [userMessage("hi", 1)], {
			model: { provider: "openai", id: "gpt-5.1" },
		});
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		await connection.setAutoCompactionEnabled(false);

		expect(session.compactionGlobalWrites).toEqual([]);
		expect(session.compactionPerModelWrites).toEqual([["openai/gpt-5.1", false]]);

		const state = await connection.getState();
		expect(state.autoCompactionEnabled).toBe(false);
	});

	it("defers to the settings side's bare default when the toggle fires with no model in service", async () => {
		const session = createFakeSession("no-model", [userMessage("hi", 1)]);
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));

		await connection.setAutoCompactionEnabled(false);

		// No model, no key: the settings manager owns the fallback to the bare default.
		expect(session.compactionPerModelWrites).toEqual([[undefined, false]]);
		expect(session.compactionGlobalWrites).toEqual([]);
	});
});
