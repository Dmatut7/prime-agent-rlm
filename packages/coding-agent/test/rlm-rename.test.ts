import { describe, expect, it, vi } from "vitest";
import { resolveRlmRenameChildId } from "../src/core/rlm-child-rename.js";
import { createRlmRenameHostHandler } from "../src/core/rlm-runtime.js";

describe("rlm.rename host handler", () => {
	it("passes the name and selector through and echoes the accepted name", async () => {
		const handler = vi.fn(async (name: string, sessionId?: string) => ({ name: `${name}:${sessionId ?? "-"}` }));
		const host = createRlmRenameHostHandler(handler);

		await expect(host({ name: "bench-runner" })).resolves.toEqual({ name: "bench-runner:-" });
		await expect(host({ name: "bench-runner", session_id: "sub-abc" })).resolves.toEqual({
			name: "bench-runner:sub-abc",
		});
		expect(handler).toHaveBeenNthCalledWith(1, "bench-runner", undefined);
		expect(handler).toHaveBeenNthCalledWith(2, "bench-runner", "sub-abc");
	});

	it("rejects a non-string name or session_id", async () => {
		const host = createRlmRenameHostHandler(async (name) => ({ name }));
		await expect(host({ name: 5 })).rejects.toThrow("rlm.rename name must be a string");
		await expect(host({ name: "ok", session_id: 3 })).rejects.toThrow("rlm.rename session_id must be a string");
	});
});

describe("resolveRlmRenameChildId", () => {
	const candidates = [
		{ rlm_child_id: "sub-1", session_id: "sess-1" },
		{ rlm_child_id: "sub-2", session_id: "sess-2" },
	];

	it("resolves a child id or a session id, trimming the selector", () => {
		expect(resolveRlmRenameChildId("sub-1", candidates)).toBe("sub-1");
		expect(resolveRlmRenameChildId("sess-2", candidates)).toBe("sub-2");
		expect(resolveRlmRenameChildId("  sub-2  ", candidates)).toBe("sub-2");
	});

	it("never resolves a session name", () => {
		// A name is what the rename changes; after drift it can collide, so it is
		// never a selector.
		expect(() => resolveRlmRenameChildId("worker-a", candidates)).toThrow("not a session name or id suffix");
	});

	it("rejects blank and ambiguous selectors", () => {
		expect(() => resolveRlmRenameChildId("   ", candidates)).toThrow("must be a non-empty string");
		expect(() =>
			resolveRlmRenameChildId("dup", [
				{ rlm_child_id: "sub-1", session_id: "dup" },
				{ rlm_child_id: "sub-2", session_id: "dup" },
			]),
		).toThrow("more than one direct child");
	});
});
