import { describe, expect, test } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { deserializeSavedSessionInfo, serializeSavedSessionInfo } from "../src/modes/daemon/saved-session-info.js";

function makeSessionInfo(agentStatus: SessionInfo["agentStatus"]): SessionInfo {
	return {
		path: "/tmp/sessions/session.jsonl",
		id: "session-1",
		cwd: "/tmp/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-02T00:00:00Z"),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "hello",
		agentStatus,
		rlmDepth: 0,
	};
}

describe("saved session agent status wire serialization", () => {
	test("keeps a non-error verdict on the wire unchanged", () => {
		const status = {
			summary: "Asked which database to target",
			taskState: "needs_input" as const,
			basedOnMessageCount: 2,
		};
		const wire = serializeSavedSessionInfo(makeSessionInfo(status)).agentStatus;
		expect(wire).toEqual(status);
	});

	test("downshifts an error verdict: the recap crosses the wire, the enum does not", () => {
		// The saved-session wire still validates taskState against the pre-#2310
		// enum, and a strict old client meeting "error" rejects the whole session
		// item. The recap text still crosses so the row is not blanked; only the
		// verdict is held back until the wire enum widens.
		const wire = serializeSavedSessionInfo(
			makeSessionInfo({
				summary: "Model request failed: 400 bad request",
				taskState: "error",
				basedOnMessageCount: 2,
			}),
		).agentStatus;
		expect(wire).toEqual({ summary: "Model request failed: 400 bad request", basedOnMessageCount: 2 });
		expect(wire?.taskState).toBeUndefined();
	});

	test("round-trips through the client-side deserializer without an error taskState", () => {
		const wire = serializeSavedSessionInfo(
			makeSessionInfo({
				summary: "Model request failed: 400 bad request",
				taskState: "error",
				basedOnMessageCount: 2,
			}),
		);
		const saved = deserializeSavedSessionInfo(wire);
		expect(saved.agentStatus).toEqual({ summary: "Model request failed: 400 bad request", basedOnMessageCount: 2 });
	});
});
