import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildFactLedger,
	emptyFactLedger,
	extractFacts,
	extractFactsFromText,
	FACT_APPENDIX_BUDGET_CEILING,
	FACT_APPENDIX_BUDGET_FLOOR,
	FACT_APPENDIX_BUDGET_MINIMUM,
	FACT_APPENDIX_TOKEN_BUDGET,
	FACT_CONTEXT_MAX_CHARS,
	FACT_KIND_LIMITS,
	FACT_KINDS,
	type FactKind,
	type FactLedger,
	type FactRecord,
	factAppendixTokenBudget,
	factKey,
	factLedgerFromDetails,
	factScore,
	mergeFactLedger,
	parseFactAppendix,
	pruneFactLedger,
	renderFactAppendix,
} from "../src/core/compaction/index.js";

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string, thinking?: string): AgentMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking } as AssistantMessage["content"][number]);
	content.push({ type: "text", text } as AssistantMessage["content"][number]);
	return {
		role: "assistant",
		content,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function assistantToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc1", name, arguments: args }],
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function customMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "refinement_outcome",
		content,
		display: true,
		timestamp: Date.now(),
	} as AgentMessage;
}

function bashMessage(command: string, output: string): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function compactionSummaryMessage(summary: string): AgentMessage {
	return { role: "compactionSummary", summary, tokensBefore: 100, timestamp: Date.now() } as AgentMessage;
}

function valuesOf(messages: readonly AgentMessage[], kind?: FactKind): string[] {
	const found = extractFacts(messages);
	return [...found.values()]
		.filter((record) => kind === undefined || record.kind === kind)
		.map((record) => record.value);
}

function recordOf(ledger: FactLedger, kind: FactKind, value: string): FactRecord | undefined {
	return ledger.records.find((record) => record.kind === kind && record.value === value);
}

const HEAD_SHA = "bda4b7d92bac88ac6da9796f4b0c4d33b7566178";

/** The rendered header has to fit inside the smallest budget with room for records. */
const APPENDIX_HEADER_CHARS = 320;

describe("fact extraction: commit SHAs", () => {
	it("keeps a full 40-hex SHA verbatim, from any source", () => {
		const values = valuesOf([toolResultMessage(`git show ${HEAD_SHA} --stat`)], "sha");
		expect(values).toContain(HEAD_SHA);
	});

	it("keeps an abbreviated SHA only where the line is about git", () => {
		const gitLine = valuesOf([toolResultMessage("commit 10b6b4e55 is the rollback anchor")], "sha");
		const plainLine = valuesOf([toolResultMessage("the value 10b6b4e55 means nothing here")], "sha");
		expect(gitLine).toContain("10b6b4e55");
		expect(plainLine).not.toContain("10b6b4e55");
	});

	it("does not read hex-shaped words or UUID segments as SHAs", () => {
		const values = valuesOf(
			[toolResultMessage("feedback deadline\nsession 01a08c40-d1d3-7422-ac09-3dc6fd008fb7 opened")],
			"sha",
		);
		expect(values).not.toContain("feedbac");
		expect(values).not.toContain("01a08c40");
		expect(values).not.toContain("3dc6fd008fb7");
	});

	it("reads an abbreviated SHA in prose without needing a git word on the line", () => {
		expect(valuesOf([userMessage("roll back to bda4b7d92 if it breaks")], "sha")).toContain("bda4b7d92");
		expect(valuesOf([toolResultMessage("roll back to bda4b7d92 if it breaks")], "sha")).not.toContain("bda4b7d92");
	});

	it("folds an abbreviated SHA into the full one so one anchor keeps one slot and one weight", () => {
		const found = extractFacts([
			toolResultMessage(`git show ${HEAD_SHA}`),
			userMessage("roll back to commit bda4b7d92 if it breaks"),
		]);
		const shas = [...found.values()].filter((record) => record.kind === "sha");

		expect(shas).toHaveLength(1);
		expect(shas[0].value).toBe(HEAD_SHA);
		// tool result weight 1 + user weight 3.
		expect(shas[0].weight).toBe(4);
	});
});

describe("fact extraction: paths", () => {
	it("keeps absolute, home-relative and repo-relative paths", () => {
		const values = valuesOf(
			[
				userMessage(
					"see /Users/a1/.prime/agent/bailian.key, ~/Desktop/notes.md and packages/coding-agent/src/core/compaction/compaction.ts",
				),
			],
			"path",
		);
		expect(values).toContain("/Users/a1/.prime/agent/bailian.key");
		expect(values).toContain("~/Desktop/notes.md");
		expect(values).toContain("packages/coding-agent/src/core/compaction/compaction.ts");
	});

	it("needs an extension or three segments for a relative path, so branch names are not paths", () => {
		const values = valuesOf([userMessage("pushed to origin/merge/repl-kernel and docs/compaction.md")], "path");
		expect(values).not.toContain("merge/repl-kernel");
		expect(values).toContain("docs/compaction.md");
	});

	it("does not read a URL as a filesystem path, and drops dependency noise", () => {
		const values = valuesOf(
			[
				userMessage(
					"https://github.com/PrimeIntellect-ai/prime-agent/issues/4603 and /repo/node_modules/x/y.js and /repo/.git/HEAD",
				),
			],
			"path",
		);
		expect(values.some((value) => value.includes("github.com"))).toBe(false);
		expect(values.some((value) => value.includes("node_modules"))).toBe(false);
		expect(values.some((value) => value.includes(".git/"))).toBe(false);
	});

	it("strips trailing sentence punctuation from a path", () => {
		const values = valuesOf([userMessage("the budget lives in /tmp/ma_audit/build.md.")], "path");
		expect(values).toContain("/tmp/ma_audit/build.md");
	});
});

describe("fact extraction: threshold numbers", () => {
	it("keeps quoted JSON keys, which is how settings reach a transcript", () => {
		const values = valuesOf([toolResultMessage('{"reserveTokens": 16384, "keepRecentTokens": 20000}')], "number");
		expect(values).toContain("reserveTokens=16384");
		expect(values).toContain("keepRecentTokens=20000");
	});

	it("keeps prose keyword numbers and unit numbers", () => {
		const values = valuesOf([userMessage("exit code 2 at line 22, after 900s and 523MB, ratio 1.41x")], "number");
		expect(values).toContain("exit code=2");
		expect(values).toContain("line=22");
		expect(values).toContain("900s");
		expect(values).toContain("523MB");
		expect(values).toContain("1.41x");
	});

	it("does not read a model name or a UUID segment as a number", () => {
		const values = valuesOf(
			[userMessage("bailian/qwen3.8-max-0902 on 01a07767-0a8e-719d-9367-43295443473e")],
			"number",
		);
		expect(values).not.toContain("max=-0902");
		expect(values).not.toContain("719d");
	});

	it("drops a zero-valued measurement and non-config identifiers", () => {
		const values = valuesOf([toolResultMessage("waited 0ms; Actions: 1; Plan = 2; idleMinutes: 90")], "number");
		expect(values).not.toContain("0ms");
		expect(values).not.toContain("Actions=1");
		expect(values).not.toContain("Plan=2");
		expect(values).toContain("idleMinutes=90");
	});

	it("carries the verbatim line a number came from, because a bare number is not a fact", () => {
		const found = extractFacts([userMessage("set compaction.keepRecentTokens: 20000 in settings.jsonl")]);
		const record = [...found.values()].find((candidate) => candidate.value === "keepRecentTokens=20000");
		expect(record?.context).toContain("settings.jsonl");
	});
});

describe("fact extraction: error signatures", () => {
	it("keeps the error a user pasted, verbatim", () => {
		const values = valuesOf(
			[
				userMessage(
					'Error: Failed to resolve API key for provider "bailian" from shell command: cat /Users/a1/.prime/agent/bailian.key',
				),
			],
			"error",
		);
		expect(values.some((value) => value.includes("Failed to resolve API key"))).toBe(true);
	});

	it("keeps a report whose prose contains code keywords", () => {
		// "did not return valid JSON" contains `return`; it is a report, not source.
		const values = valuesOf(
			[
				userMessage(
					"Error: Refinement failed: the model did not return valid JSON: Bad control character in string literal",
				),
			],
			"error",
		);
		expect(values.some((value) => value.includes("Bad control character"))).toBe(true);
	});

	it("does not keep source lines, diff hunks or serialized tool calls that mention an error type", () => {
		const values = valuesOf(
			[
				toolResultMessage(
					'except Exception: pass\n+  throw new Error(\'nope\');\n@@ -1,3 +1,4 @@\nipython {"code":"raise ValueError(1)"}',
				),
				assistantToolCall("ipython", { code: "if x: raise TypeError('bad')" }),
			],
			"error",
		);
		expect(values.some((value) => value.includes("except Exception"))).toBe(false);
		expect(values.some((value) => value.includes("throw new Error"))).toBe(false);
		expect(values.some((value) => value.includes("ValueError"))).toBe(false);
	});

	it("groups re-runs of one failure by signature, digits aside", () => {
		expect(factKey("error", "Error: bad JSON at position 1871")).toBe(
			factKey("error", "Error: bad JSON at position 2044"),
		);
		const found = extractFacts([
			toolResultMessage("Error: bad JSON at position 1871"),
			toolResultMessage("Error: bad JSON at position 2044"),
		]);
		const errors = [...found.values()].filter((record) => record.kind === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].weight).toBe(2);
	});

	it("keys a decision the same way the extraction and the merge do, case aside", () => {
		// One key derivation, not two. extractDecisions used to lowercase while
		// mergeFactLedger re-keyed on the raw value, so a decision retyped with
		// different capitalisation in a later generation became a second record:
		// one authoritative anchor in two slots, with its mention weight split.
		expect(factKey("decision", "We Decided to use Redis for cache.")).toBe(
			factKey("decision", "we decided to use redis for cache."),
		);
		expect(factKey("decision", "结论是   先回滚")).toBe(factKey("decision", "结论是 先回滚"));
		const found = extractFacts([assistantMessage("We Decided to use Redis for cache.")]);
		const decisions = [...found.values()].filter((record) => record.kind === "decision");
		expect(decisions).toHaveLength(1);

		const first = buildFactLedger({
			messages: [assistantMessage("We Decided to use Redis for cache.")],
			generation: 1,
		});
		const second = buildFactLedger({
			messages: [assistantMessage("we decided to use redis for cache.")],
			generation: 2,
			previous: first,
		});
		const carried = second.records.filter((record) => record.kind === "decision");
		expect(carried).toHaveLength(1);
		// The retyped sentence folds into the record that already carried it, so the
		// weight accumulates instead of being split, and the first spelling survives.
		expect(carried[0].value).toBe("We Decided to use Redis for cache.");
		expect(carried[0].weight).toBe(6);
		expect(carried[0].firstGeneration).toBe(1);
		expect(carried[0].lastGeneration).toBe(2);
	});
});

describe("fact extraction: issue references", () => {
	it("keeps issue and pull references from both spellings", () => {
		const values = valuesOf(
			[userMessage("fixes #4603, see https://github.com/PrimeIntellect-ai/prime-agent/issues/4599")],
			"issue",
		);
		expect(values).toContain("#4603");
		expect(values).toContain("#4599");
	});

	it("does not read a markdown heading as an issue reference", () => {
		expect(valuesOf([assistantMessage("# 1 Introduction\n## 2 Plan")], "issue")).toEqual([]);
	});

	it("takes the prose flag from the caller for text that has no message around it", () => {
		const line = "roll back to bda4b7d92";
		expect(extractFactsFromText(line, { prose: true }).some((fact) => fact.value === "bda4b7d92")).toBe(true);
		expect(extractFactsFromText(line).some((fact) => fact.value === "bda4b7d92")).toBe(false);
		expect(extractFactsFromText("")).toEqual([]);
	});
});

describe("fact weighting", () => {
	it("counts a message once however often the value repeats inside it", () => {
		const spam = `path /tmp/ma_audit/out/a.json ${"/tmp/ma_audit/out/a.json\n".repeat(50)}`;
		const found = extractFacts([toolResultMessage(spam)]);
		const record = [...found.values()].find((candidate) => candidate.value === "/tmp/ma_audit/out/a.json");
		expect(record?.weight).toBe(1);
	});

	it("weighs what the user said above what a log printed", () => {
		const fromUser = extractFacts([userMessage("the anchor is /tmp/rollback/anchor.txt")]);
		const fromLog = extractFacts([toolResultMessage("the anchor is /tmp/rollback/anchor.txt")]);
		const userWeight = [...fromUser.values()].find((record) => record.kind === "path")?.weight ?? 0;
		const logWeight = [...fromLog.values()].find((record) => record.kind === "path")?.weight ?? 0;
		expect(userWeight).toBeGreaterThan(logWeight);
	});

	it("does not re-extract its own appendix out of a summary message", () => {
		const previous = renderFactAppendix(
			buildFactLedger({ messages: [userMessage(`rolled back to ${HEAD_SHA}`)], generation: 1 }),
		);
		expect(previous).toContain("<fact-appendix");
		expect(extractFacts([compactionSummaryMessage(previous)]).size).toBe(0);
	});

	it("does not backtrack quadratically on a long run without a slash", () => {
		// A path regex shaped `segment(?:/segment)+` backtracks over every prefix of an
		// 800k-character run and hung a compaction for minutes; the linear scan does not.
		const blob = "x".repeat(800_000);
		const started = performance.now();
		const found = extractFacts([toolResultMessage(blob)]);
		const elapsed = performance.now() - started;

		expect(found.size).toBe(0);
		expect(elapsed).toBeLessThan(5000);
	});

	it("stays linear on a log dense with numbers and paths", () => {
		const lines = Array.from(
			{ length: 8000 },
			(_, i) => `worker ${i} exited 0 after ${i % 900}s using ${i % 500}MB at /var/log/app/${i % 97}/shard-${i}.log`,
		);
		const started = performance.now();
		const found = extractFacts([toolResultMessage(lines.join("\n"))]);
		const elapsed = performance.now() - started;

		expect(found.size).toBeGreaterThan(1000);
		expect(elapsed).toBeLessThan(5000);
	});

	it("reads custom messages, which convertToLlm drops, and bash commands", () => {
		const values = valuesOf(
			[
				customMessage("lesson: the daemon journal lives at /tmp/journal/a.jsonl"),
				bashMessage("cat /tmp/journal/b.jsonl", "ok"),
			],
			"path",
		);
		expect(values).toContain("/tmp/journal/a.jsonl");
		expect(values).toContain("/tmp/journal/b.jsonl");
	});
});

describe("fact ledger carry-forward", () => {
	it("keeps a fact the new slice never mentions", () => {
		const first = buildFactLedger({ messages: [userMessage(`anchor ${HEAD_SHA} at /tmp/anchor.md`)], generation: 1 });
		const second = buildFactLedger({ messages: [userMessage("now the tests pass")], generation: 2, previous: first });

		expect(recordOf(second, "sha", HEAD_SHA)?.weight).toBe(recordOf(first, "sha", HEAD_SHA)?.weight);
		expect(recordOf(second, "sha", HEAD_SHA)?.firstGeneration).toBe(1);
		expect(recordOf(second, "sha", HEAD_SHA)?.lastGeneration).toBe(1);
		expect(second.generation).toBe(2);
	});

	it("adds weight and moves the generation stamp when a fact is mentioned again", () => {
		const first = buildFactLedger({ messages: [toolResultMessage(`git show ${HEAD_SHA}`)], generation: 1 });
		const second = buildFactLedger({ messages: [userMessage(`revert ${HEAD_SHA}`)], generation: 2, previous: first });
		const record = recordOf(second, "sha", HEAD_SHA);

		expect(record?.weight).toBe((recordOf(first, "sha", HEAD_SHA)?.weight ?? 0) + 3);
		expect(record?.firstGeneration).toBe(1);
		expect(record?.lastGeneration).toBe(2);
	});

	it("folds an abbreviated SHA from a later generation into the full one already carried", () => {
		const first = buildFactLedger({ messages: [toolResultMessage(`git show ${HEAD_SHA}`)], generation: 1 });
		const second = buildFactLedger({
			messages: [userMessage("revert bda4b7d92 now")],
			generation: 2,
			previous: first,
		});
		const shas = second.records.filter((record) => record.kind === "sha");

		expect(shas).toHaveLength(1);
		expect(shas[0].value).toBe(HEAD_SHA);
		expect(shas[0].lastGeneration).toBe(2);
	});

	it("ranks a freshly mentioned fact above an equally weighted stale one", () => {
		const stale: FactRecord = {
			kind: "path",
			value: "/tmp/stale.md",
			weight: 5,
			firstGeneration: 1,
			lastGeneration: 1,
		};
		const fresh: FactRecord = {
			kind: "path",
			value: "/tmp/fresh.md",
			weight: 5,
			firstGeneration: 2,
			lastGeneration: 2,
		};
		expect(factScore(fresh, 2)).toBeGreaterThan(factScore(stale, 2));
	});

	it("merges into an empty ledger without a previous generation", () => {
		const merged = mergeFactLedger(undefined, extractFacts([userMessage("see /tmp/a.md")]), 1);
		expect(merged.generation).toBe(1);
		expect(merged.records.length).toBeGreaterThan(0);
		expect(emptyFactLedger(1).records).toEqual([]);
	});
});

describe("fact ledger budget", () => {
	it("never renders more than its token budget", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 400; i++) {
			messages.push(
				toolResultMessage(
					`commit ${i.toString(16).padStart(7, "0")}a1 touched /tmp/dir${i}/file${i}.md with limit: ${i}`,
				),
			);
		}
		expect(messages.length).toBe(400);
		const ledger = buildFactLedger({ messages, generation: 1, tokenBudget: 800 });
		const rendered = renderFactAppendix(ledger);
		expect(ledger.records.length).toBeGreaterThan(0);
		expect(rendered.length).toBeLessThanOrEqual(800 * 4);
	});

	it("keeps every kind represented when one kind dominates the transcript", () => {
		const messages: AgentMessage[] = [userMessage(`anchor ${HEAD_SHA}, fixes #4603, Error: boom happened here`)];
		for (let i = 0; i < 300; i++) messages.push(toolResultMessage(`wrote /tmp/dir${i}/file${i}.md`));
		expect(messages.length).toBe(301);
		const ledger = buildFactLedger({ messages, generation: 1, tokenBudget: 1200 });
		const kinds = new Set(ledger.records.map((record) => record.kind));

		expect(kinds.has("sha")).toBe(true);
		expect(kinds.has("error")).toBe(true);
		expect(kinds.has("issue")).toBe(true);
		expect(kinds.has("path")).toBe(true);
	});

	it("keeps a low-weight kind alive when a high-weight kind would take the whole budget", () => {
		// Every path is mentioned by five messages; the rollback SHA only once, by the user.
		const messages: AgentMessage[] = [userMessage(`anchor ${HEAD_SHA}`)];
		for (let i = 0; i < 40; i++) {
			for (let repeat = 0; repeat < 5; repeat++) {
				messages.push(toolResultMessage(`wrote /tmp/dir${i}/file${i}.md`));
			}
		}
		expect(messages.length).toBe(201);
		// A budget that fits only a handful of records.
		const ledger = buildFactLedger({ messages, generation: 1, tokenBudget: 260 });
		const kinds = new Set(ledger.records.map((record) => record.kind));

		expect(ledger.records.length).toBeGreaterThan(0);
		expect(ledger.records.length).toBeLessThan(15);
		expect(kinds.has("sha")).toBe(true);
		expect(recordOf(ledger, "sha", HEAD_SHA)?.weight).toBe(3);
	});

	it("takes the strongest source inside one message, not the last one", () => {
		// One assistant message: the fact appears in its text (weight 3) and in a tool
		// call (weight 2). The message counts once, at its strongest source.
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "writing /tmp/strong-source/a.md now" },
				{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "/tmp/strong-source/a.md" } },
			],
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "faux",
			provider: "faux",
			model: "faux-1",
		} as AssistantMessage as AgentMessage;
		const found = extractFacts([message]);
		const record = [...found.values()].find((candidate) => candidate.value === "/tmp/strong-source/a.md");

		expect(record?.weight).toBe(3);
	});

	it("bounds a context snippet to a window around the match, not the whole enclosing line", () => {
		// 70 padding characters then a sentinel: far enough past the match that only an
		// unbounded scan would pull it into the snippet.
		const text = `keepRecentTokens: 20000 ${"y".repeat(70)}${"Z".repeat(30)}`;
		const found = extractFacts([userMessage(text)]);
		const record = [...found.values()].find((candidate) => candidate.value === "keepRecentTokens=20000");

		expect(record?.context).toContain("keepRecentTokens: 20000");
		expect(record?.context).not.toContain("Z".repeat(10));
		expect(record?.context?.length).toBeLessThanOrEqual(FACT_CONTEXT_MAX_CHARS);
	});

	it("keeps a context snippet short enough to be a snippet", () => {
		const longLine = `${"prefix noise ".repeat(40)}keepRecentTokens: 20000${" suffix noise".repeat(40)}`;
		const found = extractFacts([userMessage(longLine)]);
		const record = [...found.values()].find((candidate) => candidate.value === "keepRecentTokens=20000");

		expect(record?.context).toBeDefined();
		expect(record?.context?.length).toBeLessThanOrEqual(FACT_CONTEXT_MAX_CHARS);
		expect(record?.context).toContain("keepRecentTokens: 20000");
	});

	it("reports what it dropped instead of implying completeness", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < FACT_KIND_LIMITS.path + 10; i++) messages.push(userMessage(`wrote /tmp/dir${i}/file${i}.md`));
		// A budget wide enough that the per-kind cap is what binds, not the budget.
		const ledger = buildFactLedger({ messages, generation: 1, tokenBudget: 100_000 });

		expect(ledger.records.filter((record) => record.kind === "path")).toHaveLength(FACT_KIND_LIMITS.path);
		expect(ledger.elided.path).toBe(10);
		expect(renderFactAppendix(ledger)).toContain('elided="10"');
		expect(renderFactAppendix(ledger)).toContain("path:10");
	});

	it("keeps the same set for the same input, which is what makes decay impossible", () => {
		const messages = [
			userMessage(`anchor ${HEAD_SHA} and /tmp/ma_audit/build.md with reserveTokens: 16384`),
			toolResultMessage("Error: something failed at line 12\nfixes #4601"),
		];
		const first = renderFactAppendix(buildFactLedger({ messages, generation: 1 }));
		const second = renderFactAppendix(buildFactLedger({ messages, generation: 1 }));
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(0);
	});

	it("sizes itself from the slice it replaces and the context it lands in", () => {
		expect(factAppendixTokenBudget(20000, 490000)).toBe(Math.round(490000 * 0.03));
		expect(factAppendixTokenBudget(20000, 1000)).toBe(Math.round(20000 * 0.25));
		// A tiny window cannot be swamped: the floor never exceeds half of keepRecentTokens.
		expect(factAppendixTokenBudget(2000, 0)).toBe(1000);
		expect(factAppendixTokenBudget(20000, 10_000_000)).toBe(Math.min(FACT_APPENDIX_BUDGET_CEILING, 20000));
		// Degenerate windows still get an appendix that can hold its header plus a few facts.
		expect(factAppendixTokenBudget(0, 0)).toBe(FACT_APPENDIX_BUDGET_MINIMUM);
		expect(factAppendixTokenBudget(200, 500)).toBe(FACT_APPENDIX_BUDGET_MINIMUM);
		expect(FACT_APPENDIX_BUDGET_MINIMUM * 4).toBeGreaterThan(APPENDIX_HEADER_CHARS);
		expect(FACT_APPENDIX_TOKEN_BUDGET).toBe(4000);
		expect(FACT_APPENDIX_BUDGET_FLOOR).toBe(2500);
		expect(FACT_KINDS).toEqual(["sha", "path", "number", "error", "issue", "decision"]);
	});

	it("trims to the global ranking when even the protected minimum does not fit", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 60; i++)
			messages.push(userMessage(`Error: failure number ${i} happened while writing /tmp/dir${i}/f.md`));
		const wide = buildFactLedger({ messages, generation: 1, tokenBudget: 100_000 });
		expect(wide.records.length).toBeGreaterThan(20);
		const starved = pruneFactLedger(wide, 200);
		const desperate = pruneFactLedger(wide, 40);

		expect(starved.records.length).toBeGreaterThan(0);
		expect(starved.records.length).toBeLessThan(wide.records.length);
		expect(renderFactAppendix(starved).length).toBeLessThanOrEqual(200 * 4);
		// A budget that cannot even hold the header degrades to no block, not to an overrun.
		expect(desperate.records).toEqual([]);
		expect(renderFactAppendix(desperate)).toBe("");
	});
});

describe("fact appendix round trip", () => {
	const ledger = buildFactLedger({
		messages: [
			userMessage(`roll back to ${HEAD_SHA} if /tmp/ma_audit/build.md breaks, reserveTokens: 16384, fixes #4603`),
			toolResultMessage('Error: Failed to resolve API key for provider "bailian"'),
		],
		generation: 3,
	});

	it("renders every kind and parses back to the same records", () => {
		const rendered = renderFactAppendix(ledger);
		const parsed = parseFactAppendix(rendered);

		expect(ledger.records.length).toBeGreaterThan(0);
		expect(parsed?.generation).toBe(3);
		expect(parsed?.records).toEqual(ledger.records);
		expect(parsed?.elided).toEqual(ledger.elided);
	});

	it("survives five more generations with nothing new to summarize", () => {
		const rendered = renderFactAppendix(ledger);
		let carried = ledger;
		let carriedText = rendered;
		for (let generation = 4; generation <= 8; generation++) {
			carried = buildFactLedger({ messages: [], generation, previous: carried });
			carriedText = renderFactAppendix(
				parseFactAppendix(renderFactAppendix(carried)) ?? emptyFactLedger(generation),
			);
			const survivors = ledger.records.filter((record) =>
				carried.records.some((candidate) => candidate.kind === record.kind && candidate.value === record.value),
			);
			expect(survivors).toHaveLength(ledger.records.length);
		}
		// The block that reaches generation 8 still carries every generation-3 value byte-exactly.
		// Compared through the parser rather than as a raw JSON substring: a value containing `<`
		// is JSON-escaped on the wire, so a substring check would be pinned to one spelling.
		const reparsed = parseFactAppendix(carriedText);
		expect(ledger.records.length).toBeGreaterThan(0);
		for (const record of ledger.records) {
			expect(
				reparsed?.records.some((candidate) => candidate.value === record.value && candidate.kind === record.kind),
			).toBe(true);
		}
		expect(parseFactAppendix(carriedText)?.generation).toBe(8);
	});

	it("renders nothing for an empty ledger", () => {
		expect(renderFactAppendix(emptyFactLedger(1))).toBe("");
	});

	it("skips malformed lines instead of failing a compaction", () => {
		const rendered = renderFactAppendix(ledger);
		const corrupted = rendered.replace(
			"</fact-appendix>",
			'{"k":"sha","v":broken json}\n{"k":"nope","v":"x"}\n{"v":"no kind"}\n</fact-appendix>',
		);
		const parsed = parseFactAppendix(corrupted);

		expect(parsed).toBeDefined();
		expect(parsed?.records).toEqual(ledger.records);
	});

	it("returns undefined for a summary with no appendix", () => {
		expect(parseFactAppendix("## Goal\nnothing machine-generated here")).toBeUndefined();
	});

	it("recovers a ledger from entry details, and refuses a malformed one", () => {
		const details = { readFiles: [], modifiedFiles: [], facts: ledger };
		expect(factLedgerFromDetails(details, 9)?.records).toEqual(ledger.records);
		expect(factLedgerFromDetails({ readFiles: [], modifiedFiles: [] }, 9)).toBeUndefined();
		expect(factLedgerFromDetails({ facts: { records: "not an array" } }, 9)).toBeUndefined();
		expect(factLedgerFromDetails(undefined, 9)).toBeUndefined();
		expect(
			factLedgerFromDetails({ facts: { generation: 4, records: [{ kind: "sha", value: "abc1234", weight: 2 }] } }, 9)
				?.records,
		).toEqual([
			{ kind: "sha", value: "abc1234", weight: 2, firstGeneration: 4, lastGeneration: 4, context: undefined },
		]);
	});
});
