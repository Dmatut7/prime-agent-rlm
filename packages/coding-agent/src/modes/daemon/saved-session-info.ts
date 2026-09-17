import type { AgentStatus, SessionInfo } from "../../core/session-manager.js";
import type { AgentConnectionAgentStatus, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import type { DaemonSavedSessionInfo } from "./daemon-protocol.js";

/**
 * The wire half of upstream #2310: the error verdict crosses with its recap. The
 * downshift it replaces existed because `daemon-client` refused the value and a
 * client strict about the saved-session item dropped the whole row over it, which
 * is what the daemon protocol revision records; the client validator has accepted
 * `error` since 8f52777f2, so only this projection was still holding the verdict
 * back from the archived row whose recap is about exactly that failure.
 *
 * The projection stays field-by-field on purpose: the wire shape is this function's
 * output, not whatever AgentStatus grows next.
 */
function wireAgentStatus(status: AgentStatus | undefined): AgentConnectionAgentStatus | undefined {
	if (status === undefined) {
		return undefined;
	}
	return {
		summary: status.summary,
		...(status.taskState !== undefined ? { taskState: status.taskState } : {}),
		basedOnMessageCount: status.basedOnMessageCount,
	};
}

export function serializeSavedSessionInfo(session: SessionInfo): DaemonSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: wireAgentStatus(session.agentStatus),
		usage: session.usage,
		model: session.model,
	};
}

export function deserializeSavedSessionInfo(session: DaemonSavedSessionInfo): AgentConnectionSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		created: new Date(session.created),
		modified: new Date(session.modified),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: session.agentStatus,
		usage: session.usage,
		model: session.model,
	};
}
