import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	type CustomMessage,
	createRlmChildRecoveryActionMessage,
	formatRlmReDispatchLine,
	type RlmChildReDispatchFacts,
} from "../src/core/messages.js";

/**
 * The receipt's pasteable re-dispatch line is a Python expression by contract:
 * whatever the run's prompt, model, and session name contain, pasting the line
 * into the kernel must parse as exactly one `await rlm(...)` call. The r4-p2
 * blind review (blind-2 F3, blind-3 finding 6, blind-1 F4) demonstrated four
 * inputs that broke the contract - a token slot that closes its string and
 * chains a second statement, a prompt ending in a quote, a prompt ending in a
 * backslash, and the truncation marker appended after the closing paren (the
 * >800-char case real task prompts hit). Every form is pinned structurally
 * here and, where a CPython is on PATH, by a real `ast.parse`.
 */

/**
 * A real CPython is the only authority on "it parses". Every host the shipped
 * kernel runs on has one; where PATH lacks it the parse leg stands down as a
 * capability statement (skipIf) while the structural assertions still pin the
 * shape.
 */
const cpythonOnPath = spawnSync("python3", ["-c", "import ast"], { encoding: "utf8" }).status === 0;

/**
 * Runs in the child: one statement, one expression, one await, and no call
 * target other than `rlm` anywhere in the tree - a slot that closed its string
 * early would chain a second statement, and one that comments out the tail
 * would hide it.
 */
const singleRlmCallProbe = [
	"import ast, sys",
	"line = sys.argv[1]",
	"tree = ast.parse(line, mode='exec')",
	"assert len(tree.body) == 1, 'statements: %d' % len(tree.body)",
	"stmt = tree.body[0]",
	"assert isinstance(stmt, ast.Expr), 'statement: ' + type(stmt).__name__",
	"assert isinstance(stmt.value, ast.Await), 'value: ' + type(stmt.value).__name__",
	"assert isinstance(stmt.value.value, ast.Call), 'awaited: ' + type(stmt.value.value).__name__",
	"for node in ast.walk(tree):",
	"    if isinstance(node, ast.Call):",
	"        target = node.func",
	"        if isinstance(target, ast.Name):",
	"            assert target.id == 'rlm', 'call target: ' + target.id",
	"        elif isinstance(target, ast.Attribute):",
	"            assert target.attr == 'rlm', 'call target: .' + target.attr",
].join("\n");

/** Empty when the child accepted the line, else the child's own rejection. */
function pythonRejects(line: string): string {
	const run = spawnSync("python3", ["-c", singleRlmCallProbe, line], { encoding: "utf8" });
	if (run.status === 0) return "";
	return (run.stderr ?? "").trim() || `python3 exited with status ${String(run.status)}`;
}

/**
 * The grammar the line must fit with no Python in the room: one string literal
 * for the prompt (exactly two `"""` delimiters), token slots that cannot close
 * their strings or chain statements, and - when the prompt was capped - a
 * trailing comment rather than a bare suffix.
 */
const oneExpressionGrammar =
	/^await rlm\("""[\s\S]*""", name="[^"':;()#\\\x00-\x1f\x7f]*-retry", model="[^"':;()#\\\x00-\x1f\x7f]*"(?:, thinking="[^"':;()#\\\x00-\x1f\x7f]*")?\)(?: {2}# first 800 chars - restate the full task if this is truncated)?$/;

function reDispatchFacts(overrides: Partial<RlmChildReDispatchFacts> = {}): RlmChildReDispatchFacts {
	return { prompt: "restate the original task", model: "faux/mini", sessionName: "worker", ...overrides };
}

/** The dangerous forms the blind review demonstrated, plus their slot variants. */
const dangerousForms: ReadonlyArray<{ label: string; facts: RlmChildReDispatchFacts }> = [
	{
		label: "a name that closes its string and chains a second statement",
		facts: reDispatchFacts({ sessionName: 'x"); os.system("echo PWNED"); #' }),
	},
	{ label: "a model selector that closes its string", facts: reDispatchFacts({ model: 'm"); import os #' }) },
	{
		label: "a thinking level that closes its string",
		facts: reDispatchFacts({ thinkingLevel: 'h"; os.system("pwned"); #' }),
	},
	{ label: "a prompt ending in one quote", facts: reDispatchFacts({ prompt: 'say "' }) },
	{ label: "a prompt ending in two quotes", facts: reDispatchFacts({ prompt: 'say ""' }) },
	{ label: "a prompt ending in a backslash", facts: reDispatchFacts({ prompt: "do work \\" }) },
	{
		label: "a prompt past the truncation cap",
		facts: reDispatchFacts({ prompt: "restate the task in full detail. ".repeat(40) }),
	},
	{ label: "a prompt with embedded triple quotes", facts: reDispatchFacts({ prompt: 'do """things""" now' }) },
	{
		label: "a prompt with newlines and carriage returns",
		facts: reDispatchFacts({ prompt: "line one\nline two\rline three" }),
	},
];

/** A receipt whose run facts are the two injection forms at once. */
function receiptWithDangerousReDispatch() {
	return createRlmChildRecoveryActionMessage({
		childId: "child-1",
		sessionName: 'x"); os.system("echo PWNED"); #',
		executor: "daemon",
		action: "abort_and_send",
		at: 1_000,
		silentMs: 312_000,
		thresholdMs: 300_000,
		inFlightTools: [],
		escalateAfterMs: 15 * 60_000,
		reDispatch: {
			prompt: "do work \\",
			model: "faux/mini",
			sessionName: 'x"); os.system("echo PWNED"); #',
		},
	});
}

/** The indented line the receipt actually embeds, dedented for parsing. */
function embeddedReDispatchLine(receipt: CustomMessage): string {
	const content = typeof receipt.content === "string" ? receipt.content : "";
	const embedded = content.split("\n").find((line) => line.trimStart().startsWith("await rlm("));
	expect(embedded).toBeDefined();
	return embedded ? embedded.slice(2) : "<no embedded re-dispatch line>";
}

describe("the receipt's pasteable re-dispatch line", () => {
	it("fits the one-expression grammar for every dangerous form", () => {
		expect(dangerousForms.length).toBeGreaterThan(0);
		for (const { label, facts } of dangerousForms) {
			const line = formatRlmReDispatchLine(facts);
			expect(line, label).not.toMatch(/[\n\r]/);
			expect(line, label).toMatch(oneExpressionGrammar);
			const segments = line.split('"""');
			expect(segments, label).toHaveLength(3);
			// The literal closes exactly where the template says it does: the third
			// segment is the argument tail, not more prompt.
			expect(segments[2], label).toMatch(/^, name="/);
			// A trailing quote or backslash would escape into the closing delimiter.
			expect(segments[1], label).not.toMatch(/["\\]$/);
		}
	});

	it("carries the capped prompt, and the truncation marker is a trailing comment", () => {
		const line = formatRlmReDispatchLine(reDispatchFacts({ prompt: "x".repeat(900) }));
		expect(line.split('"""')[1]).toHaveLength(800);
		expect(line.endsWith(")  # first 800 chars - restate the full task if this is truncated")).toBe(true);
		expect(line).not.toContain(") (");
	});

	it("neutralizes embedded triple quotes inside the literal", () => {
		const line = formatRlmReDispatchLine(reDispatchFacts({ prompt: 'do """things""" now' }));
		expect(line).toContain("'''things'''");
	});

	it("hands the receipt the same hardened line", () => {
		const line = embeddedReDispatchLine(receiptWithDangerousReDispatch());
		expect(line).toMatch(oneExpressionGrammar);
	});
});

describe.skipIf(!cpythonOnPath)("parsed by a real CPython", () => {
	it("parses as exactly one await rlm(...) call for every dangerous form", () => {
		expect(dangerousForms.length).toBeGreaterThan(0);
		for (const { label, facts } of dangerousForms) {
			expect(pythonRejects(formatRlmReDispatchLine(facts)), label).toBe("");
		}
	});

	it("the line embedded in the receipt parses the same way", () => {
		expect(pythonRejects(embeddedReDispatchLine(receiptWithDangerousReDispatch()))).toBe("");
	});
});
