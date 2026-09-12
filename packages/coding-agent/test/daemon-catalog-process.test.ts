import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { resolveCatalogSessionMatch } from "../src/modes/daemon/daemon-catalog-process.js";

function session(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("daemon catalog selector resolution", () => {
	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});

	it("never resolves an empty selector, not even to the only saved session", () => {
		const only = [session("the-only-session-id", "only", "/tmp/only.jsonl")];
		const many = [only[0]!, session("another-session-id", "another", "/tmp/another.jsonl")];

		// `"".startsWith` is true for every id, so without the gate a single-session
		// cwd silently retargeted the caller's message to that session while a
		// multi-session one reported ambiguity: the same command, two outcomes.
		expect(resolveCatalogSessionMatch(only, "")).toBeUndefined();
		expect(resolveCatalogSessionMatch(only, "   ")).toBeUndefined();
		expect(resolveCatalogSessionMatch(many, "")).toBeUndefined();
		// Positive control: a real prefix and a real name still resolve.
		expect(resolveCatalogSessionMatch(only, "the-only")?.path).toBe("/tmp/only.jsonl");
		expect(resolveCatalogSessionMatch(many, "another")?.path).toBe("/tmp/another.jsonl");
	});
});
