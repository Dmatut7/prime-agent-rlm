/**
 * W18-D: a compaction summary must carry a structured handoff assembled by
 * program, not recalled by the summarizer model.
 *
 * Production evidence (/tmp/wave16/memory-failures.md, case 3b): 103 of 109
 * compaction summaries had both file lists empty - the fork's tool surface is
 * the ipython kernel, whose change tracker reports cell writes on the tool
 * result's `details.fileChanges`, a channel compaction never read. The same
 * timeline carries the in-flight subagent activities and the duty log's
 * decision_needed entries; none of it reached the summary.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "../src/core/agent-messages.js";
import {
	buildSessionHandoff,
	type CompactionDetails,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	extractFileOpsFromMessage,
	findMachineBlock,
	generateBranchSummary,
	parseSessionHandoff,
	prepareCompaction,
	renderSessionHandoff,
	sessionHandoffFromDetails,
} from "../src/core/compaction/index.js";
import { DUTY_EVENT_CUSTOM_TYPE } from "../src/core/duty-log.js";
import { RLM_CHILD_FAILURE_CUSTOM_TYPE, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
import { RLM_CHILD_SETTLED_CUSTOM_TYPE } from "../src/core/rlm-child-terminal.js";
import type {
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

function createUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

/** An ipython tool result carrying the kernel change tracker's records. */
function ipythonResult(details: Record<string, unknown>): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage as AgentMessage;
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
	completeSimpleMock.mockReset();
	completeSimpleMock.mockImplementation(async () => ({
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nan honest narrative" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}));
});

function link<T extends { id: string; parentId: string | null }>(entry: T): T {
	entry.parentId = lastId;
	lastId = entry.id;
	return entry;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return link({
		type: "message",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	});
}

function customMessageEntry(customType: string, content: string, details?: unknown): CustomMessageEntry {
	return link({
		type: "custom_message",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		content,
		display: true,
		details,
	});
}

function dutyEntry(question: string): CustomEntry {
	return link({
		type: "custom",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: DUTY_EVENT_CUSTOM_TYPE,
		data: { kind: "decision_needed", question },
	});
}

function customEntry(customType: string, data: unknown): CustomEntry {
	return link({
		type: "custom",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	});
}

function subagentActivity(id: string, label: string, status: string, detail?: string): Record<string, unknown> {
	return {
		id,
		kind: "subagent",
		label,
		status,
		...(detail !== undefined ? { detail } : {}),
		startedAt: 1_000,
		...(status !== "running" ? { endedAt: 2_000 } : {}),
	};
}

/** A finished spawn record as the post-R5-M7 kernel sends it: display label plus the exact session name. */
function namedSubagentActivity(id: string, label: string, name: string, detail?: string): Record<string, unknown> {
	return { ...subagentActivity(id, label, "ok", detail), name };
}

function backgroundCommand(id: string, label: string, status: string): Record<string, unknown> {
	return { id, kind: "command", label, status, background: true, startedAt: 3_000 };
}

describe("extractFileOpsFromMessage kernel change-tracker channel (W18-D)", () => {
	it("records fileChanges from the kernel change tracker, not only edit-skill diffs", () => {
		const ops = createFileOps();
		// A cell-side write (open(...,"w"), bash redirection): no diff channel record,
		// but the change tracker observed it. This was the 94.5%-empty hole.
		extractFileOpsFromMessage(
			ipythonResult({
				fileChanges: [
					{
						path: "src/written.py",
						kind: "created",
						scope: "project",
						added: 10,
						removed: 0,
						source: "python",
						at: 1,
					},
					{
						path: "src/touched.ts",
						kind: "modified",
						scope: "project",
						added: 2,
						removed: 1,
						source: "shell",
						at: 2,
					},
					{
						path: "src/moved.ts",
						kind: "renamed",
						oldPath: "src/old.ts",
						scope: "project",
						added: 0,
						removed: 0,
						source: "python",
						at: 3,
					},
					{
						path: "src/gone.ts",
						kind: "deleted",
						scope: "project",
						added: 0,
						removed: 40,
						source: "shell",
						at: 4,
					},
				],
			}),
			ops,
		);
		expect([...ops.written]).toEqual(["src/written.py"]);
		expect([...ops.edited].sort()).toEqual(["src/gone.ts", "src/moved.ts", "src/touched.ts"]);
	});

	it("unions fileChanges with the diff channel without double-listing", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			ipythonResult({
				diffs: [{ path: "src/edited.ts", oldStr: "a", newStr: "b" }],
				fileChanges: [
					{
						path: "src/edited.ts",
						kind: "modified",
						scope: "project",
						added: 1,
						removed: 1,
						source: "edit",
						at: 1,
					},
				],
			}),
			ops,
		);
		expect([...ops.edited]).toEqual(["src/edited.ts"]);
	});

	it("ignores malformed fileChanges records, non-ipython tools and non-array payloads", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				details: { fileChanges: [{ path: "src/no.ts", kind: "created" }] },
				isError: false,
				timestamp: 1,
			} as ToolResultMessage as AgentMessage,
			ops,
		);
		extractFileOpsFromMessage(ipythonResult({ fileChanges: "not-an-array" }), ops);
		extractFileOpsFromMessage(
			ipythonResult({
				fileChanges: [null, "x", { kind: "created" }, { path: 42, kind: "created" }, { path: "", kind: "created" }],
			}),
			ops,
		);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});
});

describe("buildSessionHandoff (W18-D)", () => {
	it("lists an admitted subagent with its model as in flight", () => {
		const ledger = buildSessionHandoff(
			[messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok", "faux-1")] }))],
			{ generation: 1 },
		);
		expect(ledger.subagents).toEqual([{ name: "worker-a", since: 1_000, model: "faux-1" }]);
	});

	it("lists a still-admitting spawn as in flight, and drops a failed admission", () => {
		const ledger = buildSessionHandoff(
			[
				messageEntry(
					ipythonResult({
						activities: [
							subagentActivity("s1", "调查压缩丢文件", "running"),
							subagentActivity("s2", "bad spawn", "error"),
						],
					}),
				),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents).toHaveLength(1);
		expect(ledger.subagents[0].name).toBe("调查压缩丢文件");
		expect(ledger.subagents[0].admitting).toBe(true);
	});

	it("keys the row by the record's exact name, so a collapsed-blank label no longer ghosts the child (R6-M8)", () => {
		// The kernel's display label collapses the blanks in "wide   spaced   worker",
		// while the lifecycle notice resolves against the exact session name. Keying the
		// row by the label left the notice naming a key that was never stored, and the
		// child was listed as in flight by every later compaction.
		const ledger = buildSessionHandoff(
			[
				messageEntry(
					ipythonResult({
						activities: [namedSubagentActivity("s1", "wide spaced worker", "wide   spaced   worker", "faux-1")],
					}),
				),
				customMessageEntry(RLM_CHILD_FAILURE_CUSTOM_TYPE, "RLM child wide   spaced   worker (c1) failed: boom", {
					childId: "c1",
					sessionName: "wide   spaced   worker",
					error: "boom",
					kind: "error",
				}),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents).toEqual([]);
	});

	it("resolves an exact-named child through a settle record, and falls back to the label when no name was recorded", () => {
		const settled = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [namedSubagentActivity("s1", "worker-a", "worker-a")] })),
				customEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, {
					childId: "c1",
					sessionName: "worker-a",
					settledAs: "replied",
				}),
			],
			{ generation: 1 },
		);
		expect(settled.subagents).toEqual([]);
		// A record from before the kernel sent the field keeps the label as its key.
		const legacy = buildSessionHandoff(
			[messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-b", "ok", "faux-1")] }))],
			{ generation: 1 },
		);
		expect(legacy.subagents).toEqual([{ name: "worker-b", since: 1_000, model: "faux-1" }]);
	});

	it("resolves a child when its failure notice lands later in the branch", () => {
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
				customMessageEntry(RLM_CHILD_FAILURE_CUSTOM_TYPE, "RLM child worker-a (c1) failed: boom", {
					childId: "c1",
					sessionName: "worker-a",
					error: "boom",
					kind: "error",
				}),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents).toEqual([]);
	});

	it("a terminal notice resolves a child, whether it was cancelled or completed without a reply", () => {
		const cancelled = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
				customMessageEntry(RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE, "RLM child worker-a (c1) was cancelled", {
					childId: "c1",
					sessionName: "worker-a",
					kind: "cancelled",
				}),
			],
			{ generation: 1 },
		);
		expect(cancelled.subagents).toEqual([]);
		// completed_without_reply is a terminal record too: the run is over and no reply
		// will arrive from it, so the child is not work in flight. Its session survives
		// for a follow-up, but availability is what rlm.list_subagents reports - this
		// block listing it as in flight would have the parent wait on a finished run.
		const silent = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-b", "ok")] })),
				customMessageEntry(
					RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
					"RLM child worker-b (c2) completed without sending a reply",
					{ childId: "c2", sessionName: "worker-b", kind: "completed_without_reply" },
				),
			],
			{ generation: 1 },
		);
		expect(silent.subagents).toEqual([]);
	});

	it("a settle record resolves a child whose run ended by replying", () => {
		// A child that ends by answering (its agent_message reply was delivered)
		// classifies as "none" by design: the parent already has the answer, so no
		// notice is published. Without a transcript record for that settle, every
		// later compaction kept listing the replied child as in flight forever.
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
				customEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, {
					childId: "c1",
					sessionName: "worker-a",
					settledAs: "replied",
				}),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents).toEqual([]);
	});

	it("a settle record in the new slice resolves a carried-forward child", () => {
		const previous = buildSessionHandoff(
			[messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] }))],
			{ generation: 1 },
		);
		const ledger = buildSessionHandoff(
			[customEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, { childId: "c1", sessionName: "worker-a", settledAs: "replied" })],
			{ generation: 2, previous },
		);
		expect(ledger.subagents).toEqual([]);
	});

	it("a bare child reply does not delist the child: a mid-run message is not a settlement", () => {
		// Listing is conservative on purpose: a child that messages its parent
		// mid-run (a question, a status note) is still working, and the handoff must
		// not drop live work. Only the settle record resolves a replied run.
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
				customMessageEntry(AGENT_MESSAGE_CUSTOM_TYPE, "question from the child", {
					id: "am-1",
					message: "question from the child",
					from: { sessionId: "child-session-1", sessionName: "worker-a" },
					fromRelationship: "child",
				}),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents.map((subagent) => subagent.name)).toEqual(["worker-a"]);
	});

	it("a settle record without a session name resolves nothing", () => {
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
				customEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, { childId: "c1", settledAs: "replied" }),
				customEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, "not-a-record"),
			],
			{ generation: 1 },
		);
		expect(ledger.subagents.map((subagent) => subagent.name)).toEqual(["worker-a"]);
	});

	it("tracks background commands by activity id until their outcome lands", () => {
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [backgroundCommand("b1", "npm run build", "running")] })),
				messageEntry(
					ipythonResult({
						activities: [
							backgroundCommand("b1", "npm run build", "ok"),
							backgroundCommand("b2", "pytest -x", "running"),
						],
					}),
				),
			],
			{ generation: 1 },
		);
		expect(ledger.backgroundCommands).toEqual([{ id: "b2", label: "pytest -x", since: 3_000 }]);
	});

	it("duty-log decision_needed entries stay out of the handoff: they address the owner, not the model", () => {
		// decision_needed is defined as "work that needs the owner" (duty-log.ts), and its
		// questions are written second-person to the owner ("结论待你核对", "请检查设置…").
		// Inside the model-facing summary that "你" binds to the model, and nothing ever
		// retires the question. The duty log remains the owner-facing surface for them.
		const ledger = buildSessionHandoff(
			[dutyEntry("push 前要不要先打 tag？"), dutyEntry("push 前要不要先打 tag？"), dutyEntry("退款口径用哪版？")],
			{ generation: 1 },
		);
		// Nothing model-actionable was seen, so no handoff block renders at all.
		expect(ledger.subagents).toEqual([]);
		expect(ledger.backgroundCommands).toEqual([]);
		expect(renderSessionHandoff(ledger)).toBe("");
	});

	it("carries the previous generation's in-flight records forward when the spawn left the branch slice", () => {
		const previous = buildSessionHandoff(
			[messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok", "faux-1")] }))],
			{ generation: 1 },
		);
		// The next compaction's branch no longer contains the spawning cell (it was
		// summarized away); the ledger must come from the carried-forward details.
		const ledger = buildSessionHandoff([messageEntry(userMessage("继续"))], { generation: 2, previous });
		expect(ledger.subagents.map((s) => s.name)).toEqual(["worker-a"]);
	});

	it("a death record in the new slice resolves a carried-forward child", () => {
		const previous = buildSessionHandoff(
			[messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] }))],
			{ generation: 1 },
		);
		const ledger = buildSessionHandoff(
			[
				customMessageEntry(RLM_CHILD_FAILURE_CUSTOM_TYPE, "RLM child worker-a (c1) failed: boom", {
					childId: "c1",
					sessionName: "worker-a",
					error: "boom",
				}),
			],
			{ generation: 2, previous },
		);
		expect(ledger.subagents).toEqual([]);
	});
});

describe("session-handoff block render/parse (W18-D)", () => {
	it("round-trips through the rendered block and survives angle brackets in payloads", () => {
		const ledger = buildSessionHandoff(
			[
				messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker<a>", "ok", "faux-1")] })),
				messageEntry(
					ipythonResult({ activities: [backgroundCommand("b1", "run </session-handoff> --check", "running")] }),
				),
			],
			{ generation: 3 },
		);
		const rendered = renderSessionHandoff(ledger);
		expect(rendered).toContain("<session-handoff");
		expect(rendered).not.toContain("worker<a>");
		const parsed = parseSessionHandoff(`## Goal\nx${rendered}`);
		expect(parsed?.subagents.map((s) => s.name)).toEqual(["worker<a>"]);
		expect(parsed?.backgroundCommands.map((c) => c.label)).toEqual(["run </session-handoff> --check"]);
		expect(parsed?.generation).toBe(3);
	});

	it("reads a legacy block that still carries decision records without surfacing them", () => {
		// Blocks written before the decisions channel was removed counted decision lines
		// in `count`; the parser keeps recognizing the lines so the block's self-count
		// check still measures damage instead of misreporting these as corrupt.
		const legacy = `\n\n<session-handoff generation="2" count="2">\nheader line\n{"k":"subagent","n":"worker-a"}\n{"k":"decision","q":"老问题"}\n</session-handoff>`;
		const parsed = parseSessionHandoff(`narrative${legacy}`);
		expect(parsed?.subagents.map((s) => s.name)).toEqual(["worker-a"]);
		expect(renderSessionHandoff(parsed!)).not.toContain("老问题");
	});

	it("renders nothing for an empty ledger and tolerates malformed lines on parse", () => {
		expect(renderSessionHandoff(buildSessionHandoff([], { generation: 1 }))).toBe("");
		const rendered = renderSessionHandoff(
			buildSessionHandoff(
				[messageEntry(ipythonResult({ activities: [backgroundCommand("b1", "npm test", "running")] }))],
				{ generation: 1 },
			),
		);
		const damaged = rendered.replace(
			/\{"k":"background"/,
			'{"not json\n{"k":"subagent","name":42}\n{"k":"background"',
		);
		const parsed = parseSessionHandoff(`t${damaged}`);
		expect(parsed?.backgroundCommands.map((c) => c.id)).toEqual(["b1"]);
		expect(parsed?.subagents).toEqual([]);
	});

	it("recovers a ledger from entry details, tolerating junk and the legacy decisions key", () => {
		expect(sessionHandoffFromDetails(undefined)).toBeUndefined();
		expect(sessionHandoffFromDetails({ handoff: "nope" })).toBeUndefined();
		const fromDetails = sessionHandoffFromDetails({
			handoff: {
				generation: 2,
				subagents: [{ name: "worker-a", since: 5 }, { nope: true }],
				backgroundCommands: [],
				// Written by a build that still carried the decisions channel: ignored, not read back.
				pendingDecisions: ["决定"],
			},
		});
		expect(fromDetails?.subagents).toEqual([{ name: "worker-a", since: 5 }]);
		expect(renderSessionHandoff(fromDetails!)).not.toContain("决定");
	});
});

/** Enough tail weight that prepareCompaction cuts before the slice. */
const TAIL_FILLER = "y".repeat(12000);
const settings = (): typeof DEFAULT_COMPACTION_SETTINGS => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2000 });

function compactionEntryFrom(summary: string, firstKeptEntryId: string, details?: CompactionDetails): CompactionEntry {
	return link({
		type: "compaction",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 100000,
		details,
	});
}

describe("compact() structured handoff pin (W18-D)", () => {
	it("the summary carries the handoff block and the kernel-tracked file list, assembled by program", async () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("把会话交接做进压缩摘要")),
			messageEntry(
				ipythonResult({
					fileChanges: [
						{
							path: "src/core/compaction/session-handoff.ts",
							kind: "created",
							scope: "project",
							added: 100,
							removed: 0,
							source: "python",
							at: 1,
						},
					],
					activities: [subagentActivity("s1", "worker-a", "ok", "faux-1")],
				}),
			),
			dutyEntry("交接块要不要进 branch summary？"),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const preparation = prepareCompaction(entries, settings());
		expect(preparation).toBeDefined();
		const result = await compact(preparation!, createModel(), "key");

		// The pin: the handoff section is present and machine-assembled.
		const block = findMachineBlock(result.summary, "session-handoff");
		expect(block).toBeDefined();
		expect(result.summary).toContain("worker-a");
		// Owner-directed duty-log hints are not the model's business: the question was
		// recorded for the duty log, so it must not leak into the model-facing summary.
		expect(result.summary).not.toContain("交接块要不要进 branch summary？");
		// The kernel change record reached the modified-files list without any model recall.
		expect(result.summary).toContain("<modified-files>");
		expect(result.summary).toContain("src/core/compaction/session-handoff.ts");

		const details = result.details as CompactionDetails;
		expect(details.handoff?.subagents.map((s) => s.name)).toEqual(["worker-a"]);
		expect(details.handoff).not.toHaveProperty("pendingDecisions");
		expect(details.modifiedFiles).toContain("src/core/compaction/session-handoff.ts");
	});

	it("strips the handoff block before the previous summary goes back to the summarizer", async () => {
		// Generation 1.
		const gen1Entries: SessionEntry[] = [
			messageEntry(userMessage("第一批工作")),
			messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok", "faux-1")] })),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const gen1 = await compact(prepareCompaction(gen1Entries, settings())!, createModel(), "key");
		expect(gen1.summary).toContain("worker-a");

		// Generation 2: the spawn cell is inside the summarized slice now. The branch
		// still contains generation 1's raw entries (sessionManager.getBranch walks
		// root-to-leaf through the compaction entry), so the handoff scan sees both
		// the old slice and the new one.
		const gen2Entries: SessionEntry[] = [
			...gen1Entries,
			compactionEntryFrom(gen1.summary, gen1.firstKeptEntryId, gen1.details as CompactionDetails),
			messageEntry(userMessage("第二批工作")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const gen2Preparation = prepareCompaction(gen2Entries, settings());
		expect(gen2Preparation).toBeDefined();
		// The summarizer input must not carry the machine block back (it would invite
		// restatement); the ledger flows through details instead.
		expect(gen2Preparation!.previousSummary ?? "").not.toContain("<session-handoff");
		const gen2 = await compact(gen2Preparation!, createModel(), "key");
		// Carry-forward: the child admitted before generation 1 is still named.
		const details = gen2.details as CompactionDetails;
		expect(details.handoff?.subagents.map((s) => s.name)).toEqual(["worker-a"]);
		expect(gen2.summary).toContain("worker-a");
	});

	it("a child whose death notice lands after generation 1 drops out of generation 2's handoff", async () => {
		const gen1Entries: SessionEntry[] = [
			messageEntry(userMessage("第一批工作")),
			messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a", "ok")] })),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const gen1 = await compact(prepareCompaction(gen1Entries, settings())!, createModel(), "key");
		const gen2Entries: SessionEntry[] = [
			...gen1Entries,
			compactionEntryFrom(gen1.summary, gen1.firstKeptEntryId, gen1.details as CompactionDetails),
			customMessageEntry(RLM_CHILD_FAILURE_CUSTOM_TYPE, "RLM child worker-a (c1) failed: boom", {
				childId: "c1",
				sessionName: "worker-a",
				error: "boom",
			}),
			messageEntry(userMessage("第二批工作")),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const gen2 = await compact(prepareCompaction(gen2Entries, settings())!, createModel(), "key");
		const details = gen2.details as CompactionDetails;
		expect(details.handoff?.subagents ?? []).toEqual([]);
		expect(findMachineBlock(gen2.summary, "session-handoff")).toBeUndefined();
	});
});

describe("branch summary handoff (W18-D)", () => {
	it("a branch summary names the children the abandoned branch admitted", async () => {
		// Navigating away strands a child the summary forgets: it keeps running with
		// nobody waiting for it. The branch slice carries the spawn record, so the
		// branch summary must carry the handoff too.
		const entries: SessionEntry[] = [
			messageEntry(userMessage("探索另一条线")),
			messageEntry(ipythonResult({ activities: [subagentActivity("s1", "branch-worker", "ok", "faux-1")] })),
			dutyEntry("这条线的结论要不要合并回主线？"),
			messageEntry(assistantMessage("探索中")),
		];
		const result = await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
		});
		expect(result.error).toBeUndefined();
		expect(result.summary).toBeDefined();
		const block = findMachineBlock(result.summary!, "session-handoff");
		expect(block).toBeDefined();
		expect(result.summary).toContain("branch-worker");
		// The duty-log question belongs to the owner-facing duty log, not to a summary
		// the model reads.
		expect(result.summary).not.toContain("这条线的结论要不要合并回主线？");
	});
});
