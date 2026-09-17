import { describe, expect, test } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { deserializeSavedSessionInfo, serializeSavedSessionInfo } from "../src/modes/daemon/saved-session-info.js";

function makeSessionInfo(): SessionInfo {
	return {
		path: "/tmp/sessions/session.jsonl",
		id: "session-1",
		cwd: "/tmp/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-02T00:00:00Z"),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "hello",
		rlmDepth: 0,
	};
}

describe("saved session recorded model wire", () => {
	test("carries the recorded model across the wire and back", () => {
		const session = { ...makeSessionInfo(), model: { provider: "prime-inference", modelId: "glm-4.7" } };
		const wire = serializeSavedSessionInfo(session);
		expect(wire.model).toEqual({ provider: "prime-inference", modelId: "glm-4.7" });
		expect(deserializeSavedSessionInfo(wire).model).toEqual({ provider: "prime-inference", modelId: "glm-4.7" });
		// The row a client builds from the wire keeps it after a real round trip
		// through JSON, which is what the daemon socket does.
		expect(deserializeSavedSessionInfo(JSON.parse(JSON.stringify(wire))).model).toEqual({
			provider: "prime-inference",
			modelId: "glm-4.7",
		});
	});

	test("leaves the recorded model absent for a session that never ran one", () => {
		const wire = serializeSavedSessionInfo(makeSessionInfo());
		expect(wire.model).toBeUndefined();
		expect(deserializeSavedSessionInfo(wire).model).toBeUndefined();
		// Absent on the wire, not null: an unset model must not turn into a value a
		// client would render as a model name.
		expect(Object.keys(JSON.parse(JSON.stringify(wire)))).not.toContain("model");
	});
});
