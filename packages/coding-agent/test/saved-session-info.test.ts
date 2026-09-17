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

	test("carries an error verdict across the wire: the recap and the enum together", () => {
		// The wire half of upstream #2310. The downshift this replaces existed because
		// daemon-client refused "error" and a client strict about the saved-session item
		// dropped the whole row over it; the validator has accepted the value since
		// 8f52777f2, so holding the verdict back only hid the failure from every current
		// client - the row kept showing the terminal error text with no verdict on it.
		const status = {
			summary: "Model request failed: 400 bad request",
			taskState: "error" as const,
			basedOnMessageCount: 2,
		};
		const wire = serializeSavedSessionInfo(makeSessionInfo(status)).agentStatus;
		expect(wire).toEqual(status);
		expect(wire?.taskState).toBe("error");
	});

	test("keeps a completed verdict on the wire unchanged", () => {
		// Control for the same projection: opening the error verdict must not move the
		// verdicts that already crossed, or a row would read completed where it did.
		const status = {
			summary: "Wrote the migration and ran the suite",
			taskState: "completed" as const,
			basedOnMessageCount: 2,
		};
		const wire = serializeSavedSessionInfo(makeSessionInfo(status)).agentStatus;
		expect(wire).toEqual(status);
	});

	test("round-trips through the client-side deserializer with the error taskState", () => {
		const wire = serializeSavedSessionInfo(
			makeSessionInfo({
				summary: "Model request failed: 400 bad request",
				taskState: "error",
				basedOnMessageCount: 2,
			}),
		);
		const saved = deserializeSavedSessionInfo(wire);
		expect(saved.agentStatus).toEqual({
			summary: "Model request failed: 400 bad request",
			taskState: "error",
			basedOnMessageCount: 2,
		});
	});
});
