import type { Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_DIGEST_PREFIX } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * A refinement result is a fact about what the continual harness recorded (or
 * refused to record). The model that triggered the refinement has to be able to
 * read it on its next turn, or it can never tell a recorded lesson from a
 * silently dropped one.
 *
 * These tests drive the public entry points only: `session.refine()` and
 * `session.prompt()`. The assertion is on the payload the provider actually
 * receives, not on an internal conversion helper, so a filter re-added anywhere
 * in the pipeline shows up here.
 */

function refinePlanJson(summary: string, edits: unknown[] = []): string {
	return JSON.stringify({
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	});
}

function memoryEdit(id: string, title: string, content: string) {
	return { action: "create", kind: "memory", id, title, content, path: "notes" };
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * The conversation面 the provider receives. The boundary-injected harness digest is
 * excluded by its own framing prefix: these pins are about refinement receipts, and
 * the digest is a different面 that lists recent refinement summaries of its own - it
 * did so while it still lived in the system prompt too, so folding it in here would
 * quietly widen every assertion below (#2098).
 */
function userTextIn(context: Context | undefined): string {
	if (!context) return "";
	return context.messages
		.filter((message) => message.role === "user" && !messageText(message).startsWith(HARNESS_DIGEST_PREFIX))
		.map((message) => messageText(message))
		.join("\n");
}

describe("model visibility of refinement outcomes", () => {
	const harnesses: Harness[] = [];
	const previousAgentDirs: Array<string | undefined> = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (previousAgentDirs.length > 0) {
			const previousAgentDir = previousAgentDirs.pop();
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	async function createRefineHarness(): Promise<Harness> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		// Point the global harness store at the temp dir so a global refinement
		// can never touch the developer's real ~/.prime/agent state.
		previousAgentDirs.push(process.env.PRIME_AGENT_CODING_AGENT_DIR);
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		return harness;
	}

	it("shows a successful refinement result to the model on its next turn", async () => {
		const harness = await createRefineHarness();
		const contexts: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage("noted"),
			fauxAssistantMessage(
				refinePlanJson("Record the kv-cache lesson", [
					memoryEdit("kv-cache-lesson", "KV cache lesson", "Warm the cache once."),
				]),
			),
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("next turn reply");
			},
		]);

		await harness.session.prompt("please remember the kv cache lesson");
		const result = await harness.session.refine({ instructions: "record the kv cache lesson" });
		expect(result.appliedEdits.filter((edit) => edit.applied)).toHaveLength(1);

		await harness.session.prompt("what did you record?");

		const nextTurn = userTextIn(contexts.at(-1));
		expect(nextTurn).toContain("kv-cache-lesson");
		expect(nextTurn).toContain("Record the kv-cache lesson");
	});

	it("labels the result as a system receipt rather than a user instruction", async () => {
		const harness = await createRefineHarness();
		const contexts: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage("noted"),
			fauxAssistantMessage(
				refinePlanJson("Record a lesson", [memoryEdit("receipt-lesson", "Receipt lesson", "Body.")]),
			),
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("next turn reply");
			},
		]);

		await harness.session.prompt("prompt one");
		await harness.session.refine({ instructions: "record it" });
		await harness.session.prompt("prompt two");

		const nextTurn = userTextIn(contexts.at(-1));
		expect(nextTurn).toMatch(/system receipt|not a new instruction/i);
	});

	it("surfaces why an edit was refused", async () => {
		const harness = await createRefineHarness();
		const contexts: Context[] = [];
		const edit = memoryEdit("duplicate-lesson", "Duplicate lesson", "Body.");
		harness.setResponses([
			fauxAssistantMessage("noted"),
			fauxAssistantMessage(refinePlanJson("Record a lesson", [edit])),
			fauxAssistantMessage(refinePlanJson("Record the same lesson again", [edit])),
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("next turn reply");
			},
		]);

		await harness.session.prompt("prompt one");
		await harness.session.refine({ instructions: "record it" });
		const second = await harness.session.refine({ instructions: "record it again" });
		expect(second.appliedEdits[0]?.applied).toBe(false);
		expect(second.appliedEdits[0]?.error).toBe("entry already exists");

		await harness.session.prompt("prompt two");

		const nextTurn = userTextIn(contexts.at(-1));
		expect(nextTurn).toContain("entry already exists");
		expect(nextTurn).toContain("duplicate-lesson");
	});

	it("keeps a result that recorded nothing out of the model context", async () => {
		const harness = await createRefineHarness();
		const contexts: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage("noted"),
			fauxAssistantMessage(refinePlanJson("Nothing worth recording")),
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("next turn reply");
			},
		]);

		await harness.session.prompt("prompt one");
		const result = await harness.session.refine({ instructions: "review the session" });
		expect(result.appliedEdits).toHaveLength(0);

		await harness.session.prompt("prompt two");

		const nextTurn = userTextIn(contexts.at(-1));
		expect(nextTurn).not.toContain("Nothing worth recording");
	});
});
