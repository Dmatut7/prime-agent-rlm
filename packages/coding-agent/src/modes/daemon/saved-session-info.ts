import type { AgentStatus, SessionInfo } from "../../core/session-manager.js";
import type { AgentConnectionAgentStatus, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import type { DaemonSavedSessionInfo } from "./daemon-protocol.js";

/**
 * The wire half of upstream #2310: the error verdict crosses with its recap.
 *
 * The downshift this replaces existed because a client strict about the saved-session item dropped
 * the whole row over a taskState it did not know. Which client that was is a lineage question, and
 * the answer on this branch is ours, not upstream's: this fork's own pre-merge build (0.9.1,
 * e744cfbf4) validated `undefined | "needs_input" | "completed"` and so refused `error`. Upstream's
 * validator has accepted the value since 8f52777f2, but that commit is not an ancestor of
 * e744cfbf4 (`git merge-base --is-ancestor 8f52777f2 e744cfbf4` exits 1), so it is evidence about
 * upstream clients only - citing it here used to argue our own compatibility from somebody else's
 * history (final-review seat B, B3-05). On this branch the value has been acceptable since the merge
 * commit 67334bf1a, which is where the four-value validator entered our first-parent history.
 *
 * Dropping the downshift is safe between same-identity pairs: `judgeDaemonReuse`
 * (src/cli/daemon-launch.ts) requires protocol version, schema id and app version to match and
 * otherwise replaces or refuses the daemon, so a pre-merge client never reads this build's wire on a
 * gated path, and a client that strict about the item is a client that also refuses to talk to us.
 * What the identity gate does not cover is the disk face: `agent_status.taskState` is appended to
 * the session JSONL (core/session-manager.ts, appendAgentStatus), so a build older than fb15fa08d -
 * the commit that added the downshift - reading a row written here re-serializes `error` onto its
 * own wire, where its own validator drops that progressive row (daemon-client.ts: a progress frame
 * that fails validation never reaches onProgress and nothing logs). The loss is transient, because
 * the final catalog response is not validated and maps straight through deserializeSavedSessionInfo,
 * and until it lands a build that old also mislabels the verdict - its agents-view state has no
 * "error" branch, so the row reads "needs input".
 *
 * The projection stays field-by-field on purpose: the wire shape is this function's output, not
 * whatever AgentStatus grows next.
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
