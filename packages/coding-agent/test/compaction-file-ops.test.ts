import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "../src/core/compaction/index.js";

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

/** A tool result carrying the payload shape the ipython tool reports. */
function toolResultWithDetails(details: unknown, toolName = "ipython"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage as AgentMessage;
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

	it("attributes kernel edits from ipython tool results, not bash or cell-side writes", () => {
		const ops = createFileOps();
		// Cell-side writes (redirections, open(..., "w")) carry no path argument on
		// the call, so the assistant side still cannot attribute them.
		extractFileOpsFromMessage(assistantWithCall("bash", { command: "echo hi > /tmp/x" }), ops);
		extractFileOpsFromMessage(assistantWithCall("ipython", { code: "open('/tmp/y','w').write('1')" }), ops);
		// The kernel edit skill reports its edits structurally on the ipython tool
		// result's details; that diff channel is the one kernel signal a summary can
		// trust, so it must reach <modified-files>.
		extractFileOpsFromMessage(
			toolResultWithDetails({ diffs: [{ path: "/tmp/z.ts", oldStr: "a", newStr: "b" }] }),
			ops,
		);
		expect(ops.written.size).toBe(0);
		expect([...ops.edited]).toEqual(["/tmp/z.ts"]);
	});

	it("ignores diffs from non-ipython tools and malformed diff payloads", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(toolResultWithDetails({ diffs: [{ path: "/tmp/c.ts" }] }, "bash"), ops);
		extractFileOpsFromMessage(toolResultWithDetails("details-as-string"), ops);
		extractFileOpsFromMessage(toolResultWithDetails({ diffs: "not-an-array" }), ops);
		extractFileOpsFromMessage(toolResultWithDetails({ diffs: [{ noPath: true }, { path: 42 }, null, "x"] }), ops);
		extractFileOpsFromMessage(toolResultWithDetails(undefined), ops);
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

	it("caps the file lists a bulk kernel edit can produce", () => {
		const ops = createFileOps();
		const diffs = Array.from({ length: 250 }, (_, i) => ({
			path: `pkg/file-${String(i).padStart(3, "0")}.ts`,
			oldStr: "a",
			newStr: "b",
		}));
		extractFileOpsFromMessage(toolResultWithDetails({ diffs }), ops);
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		// Sorted, then truncated: the block and the details that re-seed the next
		// compaction stay bounded no matter how many diffs one result carries.
		expect(modifiedFiles).toHaveLength(200);
		expect(modifiedFiles[0]).toBe("pkg/file-000.ts");
		expect(modifiedFiles[199]).toBe("pkg/file-199.ts");
		const summary = formatFileOperations(readFiles, modifiedFiles);
		expect(summary).not.toContain("pkg/file-249.ts");
	});

	it("renders kernel edits in the <modified-files> summary block", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			toolResultWithDetails({ diffs: [{ path: "src/kernel-edit.ts", oldStr: "a", newStr: "b" }] }),
			ops,
		);
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/kernel-edit.ts"]);
		expect(formatFileOperations(readFiles, modifiedFiles)).toContain(
			"<modified-files>\nsrc/kernel-edit.ts\n</modified-files>",
		);
	});
});
