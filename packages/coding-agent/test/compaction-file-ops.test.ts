import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/index.js";

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("extractFileOpsFromMessage write-tool coverage (scan2 C5)", () => {
	const assistantWithCall = (name: string, args: Record<string, unknown>): AgentMessage =>
		({
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name, arguments: args }],
			usage: createMockUsage(10, 5),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "faux",
			provider: "faux",
			model: "faux-1",
		}) as AgentMessage;

	it("tracks write-style tools with path-like arguments", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(assistantWithCall("write", { path: "/tmp/new.py" }), ops);
		extractFileOpsFromMessage(assistantWithCall("edit", { path: "/tmp/edit.py" }), ops);
		extractFileOpsFromMessage(assistantWithCall("apply_patch", { file_path: "/tmp/patch.py" }), ops);
		expect([...ops.written]).toEqual(["/tmp/new.py"]);
		expect([...ops.edited].sort()).toEqual(["/tmp/edit.py", "/tmp/patch.py"]);
	});

	it("does not attribute bash or ipython tool calls", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(assistantWithCall("bash", { command: "echo hi > /tmp/x" }), ops);
		extractFileOpsFromMessage(assistantWithCall("ipython", { code: "open('/tmp/y','w').write('1')" }), ops);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});

	it("does not match extension tool names that merely contain 'patch' or 'str_replace'", () => {
		const ops = createFileOps();
		// "dispatch" contains "patch" as a substring; the unanchored pattern
		// previously matched it. "my_str_replace_v2" contains "str_replace".
		extractFileOpsFromMessage(assistantWithCall("dispatch", { path: "/tmp/d.txt" }), ops);
		extractFileOpsFromMessage(assistantWithCall("my_str_replace_v2", { path: "/tmp/s.txt" }), ops);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});
});
