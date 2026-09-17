import type { AgentStatus, SessionInfo } from "../../core/session-manager.js";
import type { AgentConnectionAgentStatus, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import type { DaemonSavedSessionInfo } from "./daemon-protocol.js";

/**
 * The saved-session wire still validates taskState against the pre-#2310 enum,
 * and a strict old client meeting `error` rejects the whole session item. Error
 * verdicts therefore cross with their recap only; the enum widens when the
 * daemon protocol takes that change (the wire half of upstream #2310, deferred).
 */
function wireAgentStatus(status: AgentStatus | undefined): AgentConnectionAgentStatus | undefined {
	if (status === undefined) {
		return undefined;
	}
	if (status.taskState === "error") {
		return { summary: status.summary, basedOnMessageCount: status.basedOnMessageCount };
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
	};
}
