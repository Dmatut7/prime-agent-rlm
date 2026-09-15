import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * ACP semantic-edges-v1 producer: a durable per-agent ledger of model-request
 * events plus a pure fold that derives sparse semantic edges between logical
 * request IDs (published downstream under ai.prime.acp/semantic-edges-v1).
 *
 * Ledger events are written before the effects they describe. Edges are
 * commit-gated: they materialize only when their target request finishes.
 * prime-agent has no prompt rollback (unlike nano-rlm's checkpoint/restore),
 * so a failed request simply returns its inbound edges to the session's
 * pending set and they attach to the next committed request in that session.
 * A request whose stream never completes (hard crash, torn tail) stays
 * in-flight and produces no edges.
 *
 * Divergence from nano-rlm: compaction summary requests claim no pending
 * edges (and no spawn). nano-rlm's single summary request can claim safely;
 * prime-agent's split turns run several racing slices, so pending edges would
 * land on whichever slice started first — a dead end when a different slice
 * commits last. Pending therefore defers past summary slices; a COMPLETED
 * compaction flushes it to its last-committed slice — the same request that
 * sources the compaction edge — so pending always lands on a committed
 * request even when the session never runs another turn. Failed or cancelled
 * compactions leave pending for the next turn.
 */

export const MODEL_REQUEST_ID_HEADER = "X-ACP-Model-Request-ID";
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const SEMANTIC_EDGES_LEDGER_FILENAME = "semantic-edges.jsonl";

export type SemanticEdgeType = "continuation" | "subagent_call" | "subagent_return" | "compaction";
export type CompactionStatus = "completed" | "failed" | "cancelled";

export interface SessionRegisteredEvent {
	type: "session_registered";
	session_id: string;
	parent_session_id?: string;
	spawned_by_request_id?: string;
}

export interface RequestStartedEvent {
	type: "request_started";
	request_id: string;
	session_id: string;
	compaction_id?: string;
}

export interface RequestFinishedEvent {
	type: "request_finished";
	request_id: string;
}

export interface RequestFailedEvent {
	type: "request_failed";
	request_id: string;
}

export interface CompactionBegunEvent {
	type: "compaction_begun";
	compaction_id: string;
	session_id: string;
}

export interface CompactionFinishedEvent {
	type: "compaction_finished";
	compaction_id: string;
	status: CompactionStatus;
}

export interface ChildReturnedEvent {
	type: "child_returned";
	/** The session whose ledger this is: the parent claiming the return. */
	session_id: string;
	child_session_id: string;
	/** The child's last committed request, captured at the success point. */
	request_id: string;
}

export type SemanticEdgeLedgerEvent =
	| SessionRegisteredEvent
	| RequestStartedEvent
	| RequestFinishedEvent
	| RequestFailedEvent
	| CompactionBegunEvent
	| CompactionFinishedEvent
	| ChildReturnedEvent;

export interface SemanticEdge {
	source_request_id: string;
	target_request_id: string;
	type: SemanticEdgeType;
}

/** The one derivation of where a session's ledger lives; recorder and outbox must agree. */
export function semanticEdgeLedgerPath(options: {
	rlmSessionDir?: string;
	sessionArtifactDir?: string;
}): string | undefined {
	const dir = options.rlmSessionDir ?? options.sessionArtifactDir;
	return dir ? join(dir, SEMANTIC_EDGES_LEDGER_FILENAME) : undefined;
}

export function modelRequestHeaders(requestId: string): Record<string, string> {
	return {
		[MODEL_REQUEST_ID_HEADER]: requestId,
		[IDEMPOTENCY_KEY_HEADER]: requestId,
	};
}

function mintId(): string {
	return randomUUID().replaceAll("-", "");
}

/** Content hash of one turn call body; Idempotency-Key reuse is only safe for a byte-identical retry. */
export function hashTurnBody(
	model: { provider: string; id: string },
	context: {
		systemPrompt?: string;
		messages: unknown[];
		tools?: unknown[];
	},
	options?: {
		reasoning?: unknown;
		thinkingBudgets?: unknown;
		temperature?: number;
		maxTokens?: number;
		serviceTier?: unknown;
	},
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				provider: model.provider,
				model: model.id,
				systemPrompt: context.systemPrompt,
				messages: context.messages,
				tools: context.tools,
				reasoning: options?.reasoning,
				thinkingBudgets: options?.thinkingBudgets,
				temperature: options?.temperature,
				maxTokens: options?.maxTokens,
				serviceTier: options?.serviceTier,
			}),
		)
		.digest("hex");
}

/**
 * The shape one captured message takes in a {@link TurnBodyCache}: the object
 * identity plus the primitive fields and content-block identities the body hash
 * was derived from. Reading these back and comparing with `===` is O(messages),
 * not O(bytes) - a few pointer compares per message instead of a full re-serialize.
 */
interface CapturedBlock {
	ref: unknown;
	type: unknown;
	text: unknown;
	name: unknown;
	id: unknown;
}

interface CapturedMessage {
	ref: unknown;
	role: unknown;
	content: unknown;
	blocks: ReadonlyArray<CapturedBlock> | undefined;
}

interface CapturedTool {
	ref: unknown;
	name: unknown;
	description: unknown;
}

interface TurnBodyCache {
	provider: string;
	modelId: string;
	systemPrompt: string | undefined;
	messages: ReadonlyArray<CapturedMessage>;
	tools: ReadonlyArray<CapturedTool> | undefined;
	optionsKey: string;
	hash: string;
}

function captureBlock(block: unknown): CapturedBlock {
	const b = block as { type?: unknown; text?: unknown; name?: unknown; id?: unknown };
	return { ref: block, type: b.type, text: b.text, name: b.name, id: b.id };
}

function blockMatches(captured: CapturedBlock, block: unknown): boolean {
	if (captured.ref !== block) return false;
	const b = block as { type?: unknown; text?: unknown; name?: unknown; id?: unknown };
	return captured.type === b.type && captured.text === b.text && captured.name === b.name && captured.id === b.id;
}

function captureMessage(message: unknown): CapturedMessage {
	const m = message as { role?: unknown; content?: unknown };
	const content = m.content;
	const blocks = Array.isArray(content) ? content.map(captureBlock) : undefined;
	return { ref: message, role: m.role, content, blocks };
}

function messageMatches(captured: CapturedMessage, message: unknown): boolean {
	if (captured.ref !== message) return false;
	const m = message as { role?: unknown; content?: unknown };
	if (captured.role !== m.role) return false;
	const content = m.content;
	if (captured.content !== content) return false;
	if (captured.blocks === undefined) return true;
	if (!Array.isArray(content) || content.length !== captured.blocks.length) return false;
	for (let index = 0; index < captured.blocks.length; index++) {
		if (!blockMatches(captured.blocks[index]!, content[index])) return false;
	}
	return true;
}

function captureTool(tool: unknown): CapturedTool {
	const t = tool as { name?: unknown; description?: unknown };
	return { ref: tool, name: t.name, description: t.description };
}

function toolMatches(captured: CapturedTool, tool: unknown): boolean {
	if (captured.ref !== tool) return false;
	const t = tool as { name?: unknown; description?: unknown };
	return captured.name === t.name && captured.description === t.description;
}

/**
 * A one-entry memo over {@link hashTurnBody} for the stream wrap. The first call
 * with a given (model, context, options) pays the full stringify+sha256; a call
 * that arrives with the very same objects - an SDK-level retry re-issuing the
 * failed call - reuses the cached hash after an O(messages) identity check
 * instead of re-serializing the whole conversation. Any identity, length, role,
 * or text/name change falls back to a fresh full hash, so a body that grew or
 * mutated in place is still re-derived byte-exactly. In-place mutation of fields
 * deeper than a content block's primitives (nested objects) is the one residual
 * the check cannot see; the pure hashTurnBody stays the byte-exact derivation.
 */
export function createTurnBodyHashMemo(): (
	model: { provider: string; id: string },
	context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
	options?: {
		reasoning?: unknown;
		thinkingBudgets?: unknown;
		temperature?: number;
		maxTokens?: number;
		serviceTier?: unknown;
	},
) => string {
	let cache: TurnBodyCache | undefined;
	return (model, context, options) => {
		const optionsKey = JSON.stringify({
			reasoning: options?.reasoning,
			thinkingBudgets: options?.thinkingBudgets,
			temperature: options?.temperature,
			maxTokens: options?.maxTokens,
			serviceTier: options?.serviceTier,
		});
		if (
			cache !== undefined &&
			cache.provider === model.provider &&
			cache.modelId === model.id &&
			cache.systemPrompt === context.systemPrompt &&
			cache.messages.length === context.messages.length &&
			cache.optionsKey === optionsKey &&
			cache.messages.every((captured, index) => messageMatches(captured, context.messages[index])) &&
			toolsMatch(cache.tools, context.tools)
		) {
			return cache.hash;
		}
		const hash = hashTurnBody(model, context, options);
		cache = {
			provider: model.provider,
			modelId: model.id,
			systemPrompt: context.systemPrompt,
			messages: context.messages.map(captureMessage),
			tools: context.tools?.map(captureTool),
			optionsKey,
			hash,
		};
		return hash;
	};
}

function toolsMatch(captured: ReadonlyArray<CapturedTool> | undefined, tools: unknown[] | undefined): boolean {
	if (captured === undefined || tools === undefined) return captured === undefined && tools === undefined;
	if (captured.length !== tools.length) return false;
	return captured.every((entry, index) => toolMatches(entry, tools[index]));
}

/**
 * Append-only semantic-edge recorder for one agent session. It only WRITES
 * events; edge semantics live in the pure {@link deriveSemanticEdges} fold.
 *
 * Constructing a recorder over an existing ledger replays it; registration is
 * idempotent across resumes.
 */
export class SemanticEdgeRecorder {
	readonly sessionId: string;
	private readonly _ledgerPath?: string;
	private _pendingRepair?: { truncateToBytes: number } | { terminateLine: true };
	private _disabled = false;
	private _epoch = 0;
	private _lastTurn?: { requestId: string; epoch: number; bodyHash?: string };
	private _parkedRetry?: { requestId: string; epoch: number; bodyHash?: string };
	private _lastCommittedRequestId?: string;
	private _openCompactions = new Set<string>();

	constructor(options: {
		ledgerPath?: string;
		sessionId: string;
		parentSessionId?: string;
		spawnedByRequestId?: string;
	}) {
		this.sessionId = options.sessionId;
		this._ledgerPath = options.ledgerPath;

		let existing: SemanticEdgeLedgerEvent[] = [];
		try {
			existing = this._loadExisting();
		} catch (error) {
			this._disable(error);
			return;
		}
		const registered = existing.some(
			(event) => event.type === "session_registered" && event.session_id === this.sessionId,
		);
		if (registered) {
			for (const event of existing) {
				this._replay(event);
			}
			return;
		}

		this._append({
			type: "session_registered",
			session_id: this.sessionId,
			...(options.parentSessionId !== undefined ? { parent_session_id: options.parentSessionId } : {}),
			...(options.spawnedByRequestId !== undefined ? { spawned_by_request_id: options.spawnedByRequestId } : {}),
		});
	}

	// Provenance is best-effort: the first ledger failure permanently disables all
	// writes (one warning), and callers stop emitting request IDs on the wire so
	// the ledger-before-wire invariant is preserved rather than weakened.
	private _disable(error: unknown): void {
		if (this._disabled) return;
		this._disabled = true;
		console.warn(
			`semantic-edge ledger disabled at ${this._ledgerPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	/** False once the ledger has failed; callers skip per-request work (e.g. body hashing) when set. */
	get enabled(): boolean {
		return !this._disabled;
	}

	/**
	 * True while calls are recorded to a ledger. The body hash exists to key the
	 * parked auto-retry's Idempotency-Key reuse, and only a ledger-backed session
	 * mints those; an in-memory session therefore never pays the stringify.
	 */
	get hasLedger(): boolean {
		return this._ledgerPath !== undefined;
	}

	get lastTurnRequestId(): string | undefined {
		return this._lastTurn?.requestId;
	}

	get lastCommittedRequestId(): string | undefined {
		return this._lastCommittedRequestId;
	}

	/**
	 * Mint (or, for a body-identical retry, reuse) the request ID for one turn
	 * call. The body hash is captured eagerly, before the wire call, so a later
	 * mutation of the live message objects can never alias two different bodies
	 * under one parked Idempotency-Key. A reused retry re-logs request_started
	 * so the fold re-claims the failed attempt's returned pending edges.
	 */
	startTurnRequest(bodyHash?: string): string | undefined {
		const parked = this._parkedRetry;
		const requestId =
			parked && parked.epoch === this._epoch && parked.bodyHash !== undefined && parked.bodyHash === bodyHash
				? parked.requestId
				: mintId();
		if (requestId === parked?.requestId) {
			this._parkedRetry = undefined;
		}
		const recorded = this._append({
			type: "request_started",
			request_id: requestId,
			session_id: this.sessionId,
		});
		if (!recorded) {
			return undefined;
		}
		this._lastTurn = { requestId, epoch: this._epoch, bodyHash };
		return requestId;
	}

	/** Park the last turn request so the upcoming auto-retry reuses its ID. */
	prepareTurnRetry(): void {
		this._parkedRetry = this._lastTurn;
	}

	clearTurnRetry(): void {
		this._parkedRetry = undefined;
	}

	finishRequest(requestId: string | undefined): void {
		if (requestId === undefined) return;
		this._append({ type: "request_finished", request_id: requestId });
	}

	failRequest(requestId: string | undefined): void {
		if (requestId === undefined) return;
		this._append({ type: "request_failed", request_id: requestId });
	}

	beginCompaction(): { compactionId: string } {
		const compactionId = mintId();
		this._append({ type: "compaction_begun", compaction_id: compactionId, session_id: this.sessionId });
		return { compactionId };
	}

	/** Mint the summary request for a wire compaction; extension-supplied summaries make no request. */
	startCompactionRequest(compactionId: string): string | undefined {
		const requestId = mintId();
		const recorded = this._append({
			type: "request_started",
			request_id: requestId,
			session_id: this.sessionId,
			compaction_id: compactionId,
		});
		return recorded ? requestId : undefined;
	}

	finishCompaction(compactionId: string, status: CompactionStatus): void {
		if (this._disabled) return;
		if (!this._openCompactions.has(compactionId)) {
			throw new Error(`unknown semantic-edge compaction: ${compactionId}`);
		}
		this._append({ type: "compaction_finished", compaction_id: compactionId, status });
	}

	/** The parent claims a successfully returned child; failed or cancelled children never return. */
	recordChildReturned(childSessionId: string, childLastCommittedRequestId: string | undefined): void {
		if (childLastCommittedRequestId === undefined) return;
		this._append({
			type: "child_returned",
			session_id: this.sessionId,
			child_session_id: childSessionId,
			request_id: childLastCommittedRequestId,
		});
	}

	private _replay(event: SemanticEdgeLedgerEvent): void {
		switch (event.type) {
			case "request_started":
				// Restores spawn attribution after resume; the body hash is unknowable, so
				// a parked retry from a replayed request can never be reused.
				if (event.session_id === this.sessionId && event.compaction_id === undefined) {
					this._lastTurn = { requestId: event.request_id, epoch: this._epoch };
				}
				break;
			case "request_finished":
				this._lastCommittedRequestId = event.request_id;
				break;
			case "compaction_begun":
				if (event.session_id === this.sessionId) {
					this._openCompactions.add(event.compaction_id);
				}
				break;
			case "compaction_finished":
				if (this._openCompactions.delete(event.compaction_id) && event.status === "completed") {
					this._epoch += 1;
				}
				break;
			default:
				break;
		}
	}

	// Construction never mutates the file: a viewer may be reading a live
	// writer's ledger. Torn-tail repair is deferred to this recorder's first append.
	private _loadExisting(): SemanticEdgeLedgerEvent[] {
		if (!this._ledgerPath || !existsSync(this._ledgerPath)) {
			return [];
		}
		const raw = readFileSync(this._ledgerPath, "utf8");
		const parsed = parseLedgerContent(raw);
		if (parsed.validLength < raw.length) {
			this._pendingRepair = { truncateToBytes: Buffer.byteLength(raw.slice(0, parsed.validLength)) };
		} else if (raw.length > 0 && !raw.endsWith("\n")) {
			this._pendingRepair = { terminateLine: true };
		}
		return parsed.events;
	}

	// Durable append first, in-memory state second: a failed write must not leave
	// commit state pointing at events that never reached the ledger.
	private _append(event: SemanticEdgeLedgerEvent): boolean {
		if (this._disabled) {
			return false;
		}
		if (this._ledgerPath) {
			try {
				mkdirSync(dirname(this._ledgerPath), { recursive: true });
				if (this._pendingRepair) {
					if ("truncateToBytes" in this._pendingRepair) {
						// Discard the torn tail line so it never becomes mid-file corruption.
						truncateSync(this._ledgerPath, this._pendingRepair.truncateToBytes);
					} else {
						appendFileSync(this._ledgerPath, "\n");
					}
					this._pendingRepair = undefined;
				}
				appendFileSync(this._ledgerPath, `${JSON.stringify(event)}\n`);
			} catch (error) {
				this._disable(error);
				return false;
			}
		}
		this._replay(event);
		return true;
	}
}

/**
 * Parse a ledger, tolerating only a torn final line: malformed AND
 * unterminated (a killed mid-append). A newline-terminated malformed line is
 * real corruption anywhere in the file and throws.
 */
function parseLedgerContent(raw: string): { events: SemanticEdgeLedgerEvent[]; validLength: number } {
	const events: SemanticEdgeLedgerEvent[] = [];
	let offset = 0;
	let validLength = 0;
	let lineNumber = 0;
	while (offset < raw.length) {
		const newlineIndex = raw.indexOf("\n", offset);
		const end = newlineIndex === -1 ? raw.length : newlineIndex + 1;
		const line = raw.slice(offset, end);
		lineNumber += 1;
		if (line.trim().length > 0) {
			try {
				events.push(JSON.parse(line) as SemanticEdgeLedgerEvent);
			} catch (error) {
				if (newlineIndex === -1) {
					return { events, validLength };
				}
				throw new Error(`corrupt semantic-edge ledger line ${lineNumber}: ${String(error)}`);
			}
		}
		offset = end;
		validLength = end;
	}
	return { events, validLength };
}

export function readSemanticEdgeLedger(path: string): SemanticEdgeLedgerEvent[] {
	return parseLedgerContent(readFileSync(path, "utf8")).events;
}

interface FoldSession {
	spawnedByRequestId?: string;
	spawnClaimed: boolean;
	lastRequestId?: string;
	pending: Array<{ source: string; type: SemanticEdgeType }>;
}

/**
 * Pure fold from one-or-more ledgers to the semantic edge set. Each event
 * carries the session it acts on, and child returns are recorded in the
 * parent's ledger with the child's last committed request, so ledgers can be
 * folded in any order without cross-ledger sequencing.
 */
export function deriveSemanticEdges(ledgers: SemanticEdgeLedgerEvent[][]): { edges: SemanticEdge[] } {
	const sessions = new Map<string, FoldSession>();
	const inFlight = new Map<
		string,
		{ sessionId: string; summary: boolean; inbound: Array<{ source: string; type: SemanticEdgeType }> }
	>();
	const compactions = new Map<string, { sessionId: string; summaryRequestIds: Set<string> }>();
	const returnedChildren = new Set<string>();
	const edges: SemanticEdge[] = [];

	const session = (sessionId: string): FoldSession => {
		let state = sessions.get(sessionId);
		if (!state) {
			state = { spawnClaimed: false, pending: [] };
			sessions.set(sessionId, state);
		}
		return state;
	};

	for (const event of ledgers.flat()) {
		switch (event.type) {
			case "session_registered": {
				if (!sessions.has(event.session_id)) {
					sessions.set(event.session_id, {
						spawnedByRequestId: event.spawned_by_request_id,
						spawnClaimed: false,
						pending: [],
					});
				}
				break;
			}
			case "request_started": {
				const state = session(event.session_id);
				const isSummary = event.compaction_id !== undefined;
				// Summary slices claim no pending edges and no spawn: pending defers to
				// the post-compaction turn, the request that actually consumes it.
				const inbound = isSummary ? [] : state.pending;
				if (!isSummary) {
					state.pending = [];
					if (!state.spawnClaimed && state.spawnedByRequestId !== undefined) {
						inbound.push({ source: state.spawnedByRequestId, type: "subagent_call" });
						state.spawnClaimed = true;
					}
				}
				if (state.lastRequestId !== undefined && !inbound.some((edge) => edge.source === state.lastRequestId)) {
					inbound.push({ source: state.lastRequestId, type: "continuation" });
				}
				inFlight.set(event.request_id, { sessionId: event.session_id, summary: isSummary, inbound });
				if (isSummary && event.compaction_id !== undefined) {
					const compaction = compactions.get(event.compaction_id);
					// A split-turn compaction sends several summary slices; all belong to it.
					if (compaction && compaction.sessionId === event.session_id) {
						compaction.summaryRequestIds.add(event.request_id);
					}
				}
				break;
			}
			case "request_finished": {
				const request = inFlight.get(event.request_id);
				if (!request) {
					break;
				}
				inFlight.delete(event.request_id);
				for (const inbound of request.inbound) {
					edges.push({
						source_request_id: inbound.source,
						target_request_id: event.request_id,
						type: inbound.type,
					});
				}
				session(request.sessionId).lastRequestId = event.request_id;
				break;
			}
			case "request_failed": {
				const request = inFlight.get(event.request_id);
				if (!request) {
					break;
				}
				inFlight.delete(event.request_id);
				// A failed summary slice returns nothing: it claimed nothing, and its
				// continuation regenerates from the unchanged last commit (several
				// failed slices would otherwise requeue duplicate continuations).
				if (!request.summary) {
					const state = session(request.sessionId);
					state.pending = [...request.inbound, ...state.pending];
				}
				break;
			}
			case "compaction_begun":
				compactions.set(event.compaction_id, { sessionId: event.session_id, summaryRequestIds: new Set() });
				break;
			case "compaction_finished": {
				const compaction = compactions.get(event.compaction_id);
				compactions.delete(event.compaction_id);
				if (event.status !== "completed" || !compaction) {
					break;
				}
				const state = session(compaction.sessionId);
				// The session's last commit must be one of the compaction's summary slices;
				// an interrupted or extension-supplied compaction produces no edge.
				if (state.lastRequestId !== undefined && compaction.summaryRequestIds.has(state.lastRequestId)) {
					const slice = state.lastRequestId;
					// nano's source-only suppression, applied at flush time: a pending edge
					// from X replaces the slice's generated continuation from X, whatever
					// the pending edge's type, so the flush can never emit a duplicate.
					for (const source of new Set(state.pending.map((edge) => edge.source))) {
						const generated = edges.findIndex(
							(edge) =>
								edge.source_request_id === source &&
								edge.target_request_id === slice &&
								edge.type === "continuation",
						);
						if (generated !== -1) {
							edges.splice(generated, 1);
						}
					}
					// Terminal flush: deliver deferred pending edges to the committed slice
					// now, so they survive even when the session never runs another turn.
					for (const pending of state.pending) {
						edges.push({
							source_request_id: pending.source,
							target_request_id: slice,
							type: pending.type,
						});
					}
					state.pending = [{ source: slice, type: "compaction" }];
				}
				break;
			}
			case "child_returned": {
				if (returnedChildren.has(event.child_session_id)) {
					break;
				}
				returnedChildren.add(event.child_session_id);
				session(event.session_id).pending.push({ source: event.request_id, type: "subagent_return" });
				break;
			}
			default:
				break;
		}
	}

	return { edges };
}

const SEMANTIC_INNER_STREAM_FN = Symbol.for("prime-agent.semantic-edges.inner-stream-fn");

/** Unwrap a semantic-edge-bound stream function; aux calls outside session history use this. */
export function unwrapSemanticEdgeStreamFn(streamFn: StreamFn): StreamFn {
	return ((streamFn as { [SEMANTIC_INNER_STREAM_FN]?: StreamFn })[SEMANTIC_INNER_STREAM_FN] ?? streamFn) as StreamFn;
}

/**
 * Bind a stream function to one session's recorder. Re-wrapping an already
 * wrapped function rebinds the original, so a child session that inherits its
 * parent's streamFn attributes calls to its own ledger. request_started is
 * appended before the wire call; the request commits or fails when its stream
 * resolves (an error/aborted final message is a failure). When the recorder is
 * disabled (its ledger failed), calls carry no request ID at all.
 */
export function wrapStreamFnWithSemanticEdges(streamFn: StreamFn, recorder: SemanticEdgeRecorder): StreamFn {
	const inner = unwrapSemanticEdgeStreamFn(streamFn);
	const bodyHashOf = createTurnBodyHashMemo();
	const wrapped: StreamFn = (model, context, options) => {
		// A disabled recorder never returns a request ID, and a session with no
		// ledger has no parked-retry identity to key, so neither ever pays the
		// stringify. A ledger-backed repeat call with the same objects reuses the
		// memoized hash instead of re-serializing the conversation.
		const bodyHash = recorder.enabled && recorder.hasLedger ? bodyHashOf(model, context, options) : undefined;
		const requestId = recorder.enabled ? recorder.startTurnRequest(bodyHash) : undefined;
		if (requestId === undefined) {
			return inner(model, context, options);
		}
		const observe = (stream: Awaited<ReturnType<StreamFn>>) => {
			void stream.result().then(
				(message) => {
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						recorder.failRequest(requestId);
					} else {
						recorder.finishRequest(requestId);
					}
				},
				() => recorder.failRequest(requestId),
			);
			return stream;
		};
		let result: ReturnType<StreamFn>;
		try {
			result = inner(model, context, {
				...options,
				headers: { ...options?.headers, ...modelRequestHeaders(requestId) },
			});
		} catch (error) {
			recorder.failRequest(requestId);
			throw error;
		}
		if (result instanceof Promise) {
			return result.then(observe, (error) => {
				recorder.failRequest(requestId);
				throw error;
			});
		}
		return observe(result);
	};
	(wrapped as { [SEMANTIC_INNER_STREAM_FN]?: StreamFn })[SEMANTIC_INNER_STREAM_FN] = inner;
	return wrapped;
}
