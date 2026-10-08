import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { formatStallDiagnosticsLines } from "../../core/stall-diagnostics-render.js";
import type { AgentConnectionEvent, AgentConnectionSessionEvent } from "../agent-connection/types.js";
import type { PrimeAgentIpythonMeta, PrimeAgentSessionMeta } from "./acp-meta.js";
import { primeAgentMeta } from "./acp-meta.js";

/**
 * Translate prime-agent session events into ACP `session/update` payloads.
 *
 * Kept as a pure function so the mapping is testable without a live ACP client
 * or a running agent. Returning an array lets one prime-agent event fan out to
 * several ACP updates (or none, for events ACP has no place for).
 */

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpSessionUpdate {
	sessionUpdate: string;
	[key: string]: unknown;
}

/** prime-agent's model-facing tool is the Python REPL; bash is the secondary escape hatch. */
export const IPYTHON_TOOL_NAME = "ipython";

export function acpToolKind(toolName: string): AcpToolKind {
	switch (toolName) {
		case IPYTHON_TOOL_NAME:
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		default:
			return "other";
	}
}

/** Decoded byte length of a base64 payload, without materializing it. */
function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Map one streaming assistant event to an ACP chunk.
 *
 * The delta discriminator lives on the event itself (`text_delta` /
 * `thinking_delta`) and carries a plain string, so reasoning and visible answer
 * text are distinct ACP update kinds a client can render or hide separately.
 */
function assistantDeltaUpdates(event: AssistantMessageEvent, messageId: string): AcpSessionUpdate[] {
	if (event.type === "thinking_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_thought_chunk", messageId, content: textContent(event.delta) }];
	}
	if (event.type === "text_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_message_chunk", messageId, content: textContent(event.delta) }];
	}
	return [];
}

/** Extract the Python cell source so a client can show what is executing. */
function ipythonCellSource(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return undefined;
	const output = (result as { output?: unknown }).output;
	if (typeof output === "string") return output;
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts = content
			.map((block) =>
				block && typeof block === "object" && (block as { type?: string }).type === "text"
					? ((block as { text?: string }).text ?? "")
					: "",
			)
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

/**
 * Rich kernel output that ACP has no native update kind for.
 *
 * The ipython tool reports media and diffs under `details`; this mapping mirrors
 * those fields (media as decoded byte sizes and paths, diffs as a count) rather
 * than inventing a MIME bundle the tool never produces. The image bytes
 * themselves travel as ACP image content blocks - see ipythonImageBlocks, which
 * is the only place a client can actually see them.
 */
function ipythonRichOutput(result: unknown): PrimeAgentIpythonMeta | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const { attachments, diffs } = details as { attachments?: unknown; diffs?: unknown };
	const meta: PrimeAgentIpythonMeta = {};
	if (Array.isArray(attachments) && attachments.length > 0) {
		meta.attachments = attachments.map((attachment) => {
			// KernelAttachment exposes mimeType, base64 `data`, and an optional path.
			// Report the decoded size rather than a `bytes` field the kernel never
			// sends, and keep the payload out of this list: the bytes ride along as
			// image content blocks on the same update (ipythonImageBlocks), so this
			// entry is the size/path index, not the delivery channel.
			const typed = (attachment ?? {}) as { mimeType?: unknown; path?: unknown; data?: unknown };
			return {
				...(typeof typed.mimeType === "string" ? { mimeType: typed.mimeType } : {}),
				...(typeof typed.path === "string" ? { path: typed.path } : {}),
				...(typeof typed.data === "string" ? { bytes: base64ByteLength(typed.data) } : {}),
			};
		});
	}
	if (Array.isArray(diffs) && diffs.length > 0) meta.diffCount = diffs.length;
	return meta.attachments || meta.diffCount !== undefined ? meta : undefined;
}

/**
 * Image content blocks for the media an ipython cell produced.
 *
 * The tool result's `content` array is the authoritative carrier (the tool
 * assembles `[text, ...images]` from the kernel attachments); dropping the
 * image blocks - which the old text-only mapping did - stripped the payload
 * with no way to recover it. ACP carries images as content blocks, so they are
 * forwarded here 1:1 (R5-M26).
 */
function ipythonImageBlocks(
	result: unknown,
): Array<{ type: "content"; content: { type: "image"; data: string; mimeType: string } }> {
	if (!result || typeof result !== "object") return [];
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const blocks: Array<{ type: "content"; content: { type: "image"; data: string; mimeType: string } }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
			blocks.push({ type: "content", content: { type: "image", data: typed.data, mimeType: typed.mimeType } });
		}
	}
	return blocks;
}

/** Correlates streamed bash output and assistant chunks with their owning run or message. */
export interface AcpEventMappingState {
	activeBashRunId?: string;
	/** Whether a bash run is open, tracked separately from the id: a run without a runId maps to the bare id. */
	bashRunOpen?: boolean;
	activeAssistantMessageId?: string;
	nextAssistantMessageSequence?: number;
}

function startAssistantMessage(state: AcpEventMappingState): string {
	const sequence = (state.nextAssistantMessageSequence ?? 0) + 1;
	state.nextAssistantMessageSequence = sequence;
	state.activeAssistantMessageId = `prime-agent-assistant-${sequence}`;
	return state.activeAssistantMessageId;
}

/**
 * Translate prime-agent *connection-level* events into ACP `session/update`
 * payloads (R5-M22).
 *
 * These events used to be dropped wholesale by the ACP subscription, which
 * left a client blind to a quota park (up to 24h) while its prompt hung, and
 * holding stale state after a daemon restart. They are connection-scoped like
 * heartbeat changes, so the mode layer publishes them at origin turn 0.
 */
export function acpUpdatesForConnectionEvent(event: AgentConnectionEvent): AcpSessionUpdate[] {
	switch (event.type) {
		case "quota_park_status":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						quotaPark: {
							parked: event.parked,
							...(event.resumeAt !== undefined ? { resumeAt: event.resumeAt } : {}),
							...(event.remainingMs !== undefined ? { remainingMs: event.remainingMs } : {}),
							...(event.parkCount !== undefined ? { parkCount: event.parkCount } : {}),
							...(event.provider !== undefined ? { provider: event.provider } : {}),
						},
					}),
				},
			];

		case "connection_status":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						connectionStatus: {
							status: event.status,
							...(event.error !== undefined ? { error: event.error } : {}),
							...(event.backgroundAttempt !== undefined ? { backgroundAttempt: event.backgroundAttempt } : {}),
							...(event.daemonVersion !== undefined ? { daemonVersion: event.daemonVersion } : {}),
						},
					}),
				},
			];

		case "session_status":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({ ...(event.recap !== undefined ? { recap: event.recap } : {}) }),
				},
			];

		case "session_replaced":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						sessionSync: {
							kind: "replaced",
							sessionId: event.state.sessionId,
							...(event.state.sessionFile !== undefined ? { sessionFile: event.state.sessionFile } : {}),
							messageCount: event.messages.length,
						},
					}),
				},
			];

		case "session_resynced":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						sessionSync: {
							kind: "resynced",
							sessionId: event.snapshot.state.sessionId,
							...(event.snapshot.state.sessionFile !== undefined
								? { sessionFile: event.snapshot.state.sessionFile }
								: {}),
							messageCount: event.snapshot.messages.length,
						},
					}),
				},
			];

		case "closed":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						connectionClosed: {
							...(event.error !== undefined ? { error: event.error } : {}),
							...(event.sessionClosedReason !== undefined
								? { sessionClosedReason: event.sessionClosedReason }
								: {}),
						},
					}),
				},
			];

		default:
			// session_event has a dedicated mapper; heartbeats_changed,
			// extension_error, and extension_ui_request have dedicated handlers in
			// the mode layer; side_question_event cannot fire on an ACP connection
			// (ACP exposes no side-question API, and the daemon routes side
			// questions only to the client that started them).
			return [];
	}
}

export function acpUpdatesForSessionEvent(
	event: AgentConnectionSessionEvent,
	state: AcpEventMappingState = {},
): AcpSessionUpdate[] {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") startAssistantMessage(state);
			return [];

		case "message_update":
			if (event.message.role !== "assistant") return [];
			return assistantDeltaUpdates(
				event.assistantMessageEvent,
				state.activeAssistantMessageId ?? startAssistantMessage(state),
			);

		case "message_end":
			if (event.message.role === "assistant") state.activeAssistantMessageId = undefined;
			return [];

		case "tool_execution_start": {
			const cell = event.toolName === IPYTHON_TOOL_NAME ? ipythonCellSource(event.args) : undefined;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName === IPYTHON_TOOL_NAME ? "Python cell" : event.toolName,
					kind: acpToolKind(event.toolName),
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: cell !== undefined ? { code: cell } : event.args,
				},
			];
		}

		case "tool_execution_end": {
			const text = toolResultText(event.result);
			const isIpython = event.toolName === IPYTHON_TOOL_NAME;
			const images = isIpython ? ipythonImageBlocks(event.result) : [];
			const rich = isIpython ? ipythonRichOutput(event.result) : undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: (event.isError ? "failed" : "completed") satisfies AcpToolStatus,
					...(text || images.length > 0
						? {
								content: [...(text ? [{ type: "content", content: textContent(text) }] : []), ...images],
							}
						: {}),
					...(rich ? { _meta: primeAgentMeta({ ipython: rich }) } : {}),
				},
			];
		}

		// Bash runs outside the tool-call lifecycle, so it gets a synthetic tool
		// call keyed by run id to keep incremental output addressable.
		case "bash_start":
			state.activeBashRunId = event.runId;
			state.bashRunOpen = true;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: bashToolCallId(event.runId),
					title: event.command,
					kind: "execute" satisfies AcpToolKind,
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: { command: event.command },
				},
			];

		case "bash_output":
			// A chunk for a run this client never saw open (resync mid-run) or one
			// already ended has no tool call to update; the bare fallback id would
			// invent one.
			if (!state.bashRunOpen) return [];
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(state.activeBashRunId),
					status: "in_progress" satisfies AcpToolStatus,
					content: [{ type: "content", content: textContent(event.chunk) }],
				},
			];

		case "bash_end":
			// Only the open run's own end closes it: overlapping runs must not let an
			// earlier end mute a later run's output.
			if (state.activeBashRunId === event.runId) {
				state.activeBashRunId = undefined;
				state.bashRunOpen = false;
			}
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(event.runId),
					status: (event.exitCode === 0 && !event.cancelled ? "completed" : "failed") satisfies AcpToolStatus,
				},
			];

		// Compaction, subagents, goals and recaps have no ACP equivalent: surface
		// them as namespaced metadata rather than distorting a standard update.
		case "compaction_end":
			// R5-M24: aborted/willRetry/errorMessage/errorSeverity travel with the
			// outcome - a failed compaction reported as an empty success payload
			// was indistinguishable from a completed one.
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						compaction: {
							tokensBefore: event.result?.tokensBefore,
							summary: event.result?.summary,
							aborted: event.aborted,
							willRetry: event.willRetry,
							...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
							...(event.errorSeverity !== undefined ? { errorSeverity: event.errorSeverity } : {}),
						},
					}),
				},
			];

		case "rlm_child_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						subagents: [
							{
								id: event.child.id,
								sessionName: event.child.sessionName,
								status: event.child.status,
								model: event.child.model,
								tokenCount: event.child.tokenCount,
								error: event.child.error,
								stall: event.child.stall
									? {
											silentMs: event.child.stall.silentMs,
											thresholdMs: event.child.stall.thresholdMs,
											inFlightTools: event.child.stall.inFlightTools,
											unsettled: event.child.stall.unsettled,
											excused: event.child.stall.excused,
											excusedReasons: event.child.stall.excusedReasons,
										}
									: undefined,
							},
						],
					}),
				},
			];

		// Goals, continual-harness refinement, and agent-to-agent messaging are
		// prime-agent concepts with no ACP counterpart. They are still part of a
		// turn's observable behavior, so they surface as namespaced metadata
		// instead of being dropped.
		case "goal_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						goal: {
							status: event.goal.status,
							objective: event.goal.objective,
							tokenBudget: event.goal.tokenBudget,
							tokensUsed: event.goal.tokensUsed,
						},
					}),
				},
			];

		case "refine_complete":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						refinement: {
							status: "complete",
							summary: event.result.summary,
							changes: event.result.appliedEdits
								?.filter((edit) => edit.applied)
								.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`),
						},
					}),
				},
			];

		case "refine_failed":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({ refinement: { status: "failed", error: event.error } }),
				},
			];

		case "session_persist_failed":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({ sessionPersistence: { status: "failed", error: event.error } }),
				},
			];

		case "stall_warning":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						stallWatchdog: {
							status: "warning",
							message: event.message,
							silentMs: event.silentMs,
							diagnostics: formatStallDiagnosticsLines(event.diagnostics),
						},
					}),
				},
			];

		case "stall_abort":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						stallWatchdog: {
							status: "aborted",
							message: event.message,
							silentMs: event.silentMs,
							diagnostics: formatStallDiagnosticsLines(event.diagnostics),
						},
					}),
				},
			];

		case "rlm_terminal_notice_abandoned":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						rlmTerminalNotices: {
							abandoned: event.abandoned,
							persistedToTranscript: event.persistedToTranscript,
							deferredMs: event.deferredMs,
						},
					}),
				},
			];

		case "stall_unsettled":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						stallWatchdog: { status: "unsettled", message: event.message, silentMs: event.silentMs },
					}),
				},
			];

		// The retry ladder's backoff: a parked turn (up to the full ladder delay)
		// would otherwise show the client nothing between the failure and the retry.
		case "auto_retry_start":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						autoRetry: {
							status: "waiting",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
							...(event.reason !== undefined ? { reason: event.reason } : {}),
							...(event.backupModel !== undefined ? { backupModel: event.backupModel } : {}),
						},
					}),
				},
			];

		case "auto_retry_end":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						autoRetry: {
							status: "finished",
							success: event.success,
							attempt: event.attempt,
							...(event.finalError !== undefined ? { finalError: event.finalError } : {}),
						},
					}),
				},
			];

		case "ipython_sent_agent_message":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						agentMessage: {
							toolCallId: event.toolCallId,
							target: event.message.target.sessionName ?? event.message.target.sessionId,
							deliveryStatus: event.message.deliveryStatus,
						},
					}),
				},
			];

		default:
			return [];
	}
}

const BASH_TOOL_CALL_PREFIX = "prime-agent-bash";

export function bashToolCallId(runId: string | undefined): string {
	return runId ? `${BASH_TOOL_CALL_PREFIX}-${runId}` : BASH_TOOL_CALL_PREFIX;
}

export type { PrimeAgentSessionMeta };
