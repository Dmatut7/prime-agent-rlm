import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { prepareBranchEntries } from "../../../src/core/compaction/branch-summarization.js";
import { collectUserRequests, isUserIntentMessage } from "../../../src/core/compaction/user-requests.js";
import {
	type CustomMessage,
	convertToLlm,
	createCompactionSummaryMessage,
	createHarnessDigestMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	HARNESS_DIGEST_PREFIX,
	HARNESS_DIGEST_SUFFIX,
} from "../../../src/core/messages.js";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	loadHarnessState,
	saveHarnessState,
} from "../../../src/core/refinement/index.js";
import type { CompactionEntry, SessionEntry } from "../../../src/core/session-manager.js";
import { selectHeadlessTerminalResult } from "../../../src/modes/headless-completion.js";
import { conversationMessages, createHarness, getMessageText, type Harness } from "../harness.js";

/**
 * RES-1318 / upstream #2098, fork side: the harness digest left the system prompt
 * and became boundary-injected context. Three things have to stay true together,
 * or the cut is a regression dressed as a saving:
 *
 * 1. the prompt a refinement used to rewrite is now byte-stable (the cache命题),
 * 2. harness state written mid-session still reaches the model at the next cold
 *    boundary (the效果护栏 in AGENTS.md: no frozen memory menu),
 * 3. a refused refinement entry stays model-visible (MV-5) even though the
 *    digest no longer carries harness state inside the prompt.
 *
 * Every "nothing changed / nothing leaked" claim below ships with a positive
 * control that can go red: the cache reading is paired with a deliberate prefix
 * break, the digest-free summarizer input is paired with a digest that is present
 * in the same call's persisted head, and the empty-session claim is paired with a
 * committed turn that does inject.
 */

/**
 * Two counters that make cost and mechanism claims observable without touching a
 * private member: how often a harness store file is read, and how often the system
 * prompt is rebuilt. Both wrap the real implementation and only count.
 */
const storeReads = vi.hoisted(() => ({ count: 0 }));
const promptBuilds = vi.hoisted(() => ({ count: 0 }));
/**
 * Perf seat C (2026-09-18): how often the digest text is actually rendered. The
 * ranked render is the expensive half of a moved stamp (~0.155 s mean at the
 * 48-term cap on the 1266-entry fixture, 0.66-0.70 s before a5f4868c0;
 * `scripts/perf/digest-rank.bench.ts`), and the delivery
 * decision only needs the state fingerprint - so a turn that appends no carrier
 * must not buy a render.
 */
const digestRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/utils/private-files.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/utils/private-files.js")>();
	return {
		...actual,
		readPrivateFile: (...args: Parameters<typeof actual.readPrivateFile>) => {
			if (String(args[0]).endsWith("harness_state.json")) storeReads.count += 1;
			return actual.readPrivateFile(...args);
		},
	};
});

vi.mock("../../../src/core/refinement/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/refinement/index.js")>();
	return {
		...actual,
		formatHarnessStateForPrompt: (...args: Parameters<typeof actual.formatHarnessStateForPrompt>) => {
			// Only the injected digest face is a render this counter owns; the refiner's
			// own overview goes through a different formatter.
			digestRenders.count += 1;
			return actual.formatHarnessStateForPrompt(...args);
		},
	};
});

vi.mock("../../../src/core/system-prompt.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/system-prompt.js")>();
	return {
		...actual,
		buildSystemPrompt: (...args: Parameters<typeof actual.buildSystemPrompt>) => {
			promptBuilds.count += 1;
			return actual.buildSystemPrompt(...args);
		},
	};
});

const READINGS_PATH = process.env.P2098_CACHE_READINGS ?? "/tmp/p2098/cache-readings.json";

interface CacheReading {
	label: string;
	/** Full-price prompt tokens the provider billed for this request. */
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Prompt tokens presented: input + cacheRead. (The faux provider also reports cacheWrite = input on a cold call, so it is recorded but not summed.) */
	promptTokens: number;
	systemPromptBytes: number;
	messageCount: number;
}

const readings: CacheReading[] = [];
const harnesses: Harness[] = [];
const tempDirs: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env[ENV_AGENT_DIR];
	const agentDir = mkdtempSync(join(tmpdir(), "p2098-agent-dir-"));
	tempDirs.push(agentDir);
	mkdirSync(join(agentDir, "harness"), { recursive: true });
	// Refinement writes land in the ambient agent dir; point it somewhere disposable
	// so no test in this file can touch the developer's real harness state.
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
});

afterAll(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	// The cost-side正控 has to leave a readable artifact, not just a green check.
	// Round 2 is the验收 reading (cacheRead ~= round 1's whole prefix); round 3 is
	// the positive control that proves the instrument can still see a broken prefix.
	const round1 = readings.find((reading) => reading.label === "round1-cold");
	const round2 = readings.find((reading) => reading.label === "round2-after-refine");
	const round3 = readings.find((reading) => reading.label === "round3-prefix-broken-positive-control");
	const payload = {
		generatedAt: new Date().toISOString(),
		baseSha: process.env.P2098_BASE_SHA ?? "unspecified",
		provider:
			"faux (packages/ai/src/providers/faux.ts withUsageEstimate: prefix-cache simulation keyed by stream sessionId, tokens = ceil(chars/4))",
		workload: "same session, same prompt text, one landed refinement between round 1 and round 2",
		verdict: {
			round2CacheReadCoversRound1Prefix:
				round1 !== undefined && round2 !== undefined && round2.cacheRead >= Math.floor(round1.input * 0.9),
			round2InputCollapsed: round1 !== undefined && round2 !== undefined && round2.input < round1.input * 0.25,
			positiveControlCollapses:
				round2 !== undefined && round3 !== undefined && round3.cacheRead < round2.cacheRead * 0.5,
		},
		readings,
	};
	mkdirSync(dirname(READINGS_PATH), { recursive: true });
	writeFileSync(READINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
});

function seedEntry(
	kind: "memory" | "skill" | "subagent",
	id: string,
	title: string,
	content: string,
	scope: "global" | "local" = "global",
	options: { expectApplied?: boolean } = {},
): void {
	const dir = getGlobalHarnessStateDir();
	const state = loadHarnessState(dir, scope);
	const result = applyRefinementProposal(
		state,
		{
			summary: `seed ${kind} ${id}`,
			rationale: "fixture seed",
			expectedOutcome: "the entry is readable from the digest",
			edits: [
				{
					action: "create",
					kind,
					id,
					title,
					content,
					// A skill entry is only valid with its call contract; seeding one
					// without it would be refused and the fixture would silently test
					// nothing (the proposal result is asserted below).
					...(kind === "skill"
						? {
								arguments: { target: "string" },
								reference: { type: "python", import: id, callable: "run" },
							}
						: {}),
				},
			],
		},
		{ id: `seed_${id}`, scope },
	);
	expect(result.appliedEdits.every((edit) => edit.applied)).toBe(options.expectApplied ?? true);
	saveHarnessState(dir, state);
	return;
}

/**
 * Another writer's edit to an entry that already exists: the id stays, the version
 * moves. This is the shape a sibling seat's refine leaves on a shared store.
 */
function bumpEntry(id: string, title: string, content: string): void {
	const dir = getGlobalHarnessStateDir();
	const state = loadHarnessState(dir, "global");
	const result = applyRefinementProposal(
		state,
		{
			summary: `external bump ${id}`,
			rationale: "a different writer",
			expectedOutcome: "the entry version moves",
			edits: [{ action: "update", kind: "memory", id, title, content }],
		},
		{ id: `bump_${id}`, scope: "global" },
	);
	// A refused bump would leave the menu unmoved and both pins below would test nothing.
	expect(result.appliedEdits.every((edit) => edit.applied)).toBe(true);
	saveHarnessState(dir, state);
}

function digestMessages(messages: readonly AgentMessage[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE,
	);
}

function digestEntries(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === HARNESS_DIGEST_CUSTOM_TYPE)
		.map((entry) => (entry.type === "custom_message" ? entry.content : ""))
		.map((content) => getMessageText({ content }));
}

function llmTexts(messages: readonly AgentMessage[]): string[] {
	return convertToLlm(messages as AgentMessage[]).map((message) => getMessageText(message));
}

function usageOf(message: AgentMessage | undefined): Usage {
	if (message?.role !== "assistant") throw new Error("expected an assistant message");
	return message.usage;
}

function lastAssistant(session: { messages: AgentMessage[] }): AssistantMessage {
	const assistants = session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
	const last = assistants.at(-1);
	if (!last) throw new Error("no assistant message");
	return last;
}

function record(label: string, harness: Harness, usage: Usage): CacheReading {
	const reading: CacheReading = {
		label,
		input: usage.input,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		promptTokens: usage.input + usage.cacheRead,
		systemPromptBytes: harness.session.agent.state.systemPrompt.length,
		messageCount: harness.session.messages.length,
	};
	readings.push(reading);
	return reading;
}

function refinePlanJson(summary: string, edits: unknown[]): string {
	return JSON.stringify({
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	});
}

describe("#2098 static system prompt with an in-context harness digest", () => {
	it("keeps an untouched session empty and delivers the digest on the first committed turn", async () => {
		seedEntry("memory", "seed_a", "Seed A", "First durable lesson.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		// Positive control for the emptiness claim: nothing was injected yet.
		expect(harness.session.messages).toEqual([]);
		expect(digestEntries(harness)).toEqual([]);

		harness.setResponses([fauxAssistantMessage("first reply")]);
		await harness.session.prompt("hello");

		const messages = harness.session.messages;
		expect(messages[0]?.role).toBe("custom");
		expect((messages[0] as CustomMessage).customType).toBe(HARNESS_DIGEST_CUSTOM_TYPE);
		expect(messages[0] && getMessageText(messages[0])).toContain("# Continual Harness State");
		expect(messages[0] && getMessageText(messages[0])).toContain("[global:seed_a] Seed A");
		// The conversation the pins assert is unchanged by the injection.
		expect(conversationMessages(harness.session).map((message) => message.role)).toEqual(["user", "assistant"]);
		// Durable: a rebuild of the context from the journal keeps the digest.
		expect(digestEntries(harness)).toHaveLength(1);
		// The digest reaches the model as a user-role message (convertToLlm is a
		// blacklist, so a new custom type passes through; this pins that negative).
		const llm = llmTexts(messages);
		// The framing has to keep declaring itself mechanical context: a custom message
		// reaches the provider as a user-role message, so without that line the menu
		// reads as a user instruction (same doctrine as REFINEMENT_OUTCOME_PREFIX).
		expect(HARNESS_DIGEST_PREFIX).toContain("not a message from the user");
		expect(HARNESS_DIGEST_PREFIX).toContain("not a new instruction");
		expect(llm[0]).toContain(HARNESS_DIGEST_PREFIX.trim());
		expect(llm[0]).toContain("# Continual Harness State");
		expect(llm[0]).toContain(HARNESS_DIGEST_SUFFIX.trim());
	});

	it("keeps the system prompt byte-identical across a refinement apply", async () => {
		seedEntry("memory", "seed_b", "Seed B", "Second durable lesson.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");

		const before = harness.session.agent.state.systemPrompt;
		expect(before).not.toContain("# Continual Harness State");

		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the cache lesson", [
					{ action: "create", kind: "memory", title: "Cache lesson", content: "Prefix cache survived." },
				]),
			),
		]);
		const result = await harness.session.refine({ instructions: "record the cache lesson" });
		expect(result.appliedEdits.some((edit) => edit.applied)).toBe(true);

		const after = harness.session.agent.state.systemPrompt;
		// The命题: a landed refinement no longer rewrites the cached prefix.
		expect(after).toBe(before);
		// The new entry is on disk (a /refine defaults to this session's local store)
		// but deliberately NOT in the prompt: it reaches the model through the
		// refinement receipt now, and through the digest at the next cold boundary.
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeTruthy();
		expect(loadHarnessState(localDir as string, "local").entries.memory.cache_lesson).toBeDefined();
		expect(after).not.toContain("Cache lesson");
	});

	it("keeps the provider prefix cached across a refinement, and the reading can go red", async () => {
		seedEntry("memory", "seed_c", "Seed C", "Third durable lesson.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		// The faux provider simulates prefix caching per stream sessionId; a session
		// that never sets one would report zeros and the reading would mean nothing.
		harness.session.agent.sessionId = harness.session.sessionId;

		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("same prompt");
		const round1 = record("round1-cold", harness, usageOf(lastAssistant(harness.session)));
		expect(round1.cacheRead).toBe(0);
		expect(round1.input).toBeGreaterThan(0);

		const promptBefore = harness.session.agent.state.systemPrompt;
		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the reading lesson", [
					{ action: "create", kind: "memory", title: "Reading lesson", content: "Cache read stays hot." },
				]),
			),
		]);
		await harness.session.refine({ instructions: "record the reading lesson" });
		expect(harness.session.agent.state.systemPrompt).toBe(promptBefore);

		harness.setResponses([fauxAssistantMessage("reply two")]);
		await harness.session.prompt("same prompt");
		const round2 = record("round2-after-refine", harness, usageOf(lastAssistant(harness.session)));

		// The验收: round two re-reads round one's prefix instead of repaying it. The
		// floor is 0.9 and not 1.0 because the faux serializer appends the tool
		// schema after the messages, so the tail of round one's text is by
		// construction not a prefix of round two's; a real provider caches tools as
		// part of the prefix. What must hold is the order of magnitude: the repaid
		// input collapses from the whole prefix to just this round's new tail.
		expect(round2.cacheRead).toBeGreaterThanOrEqual(Math.floor(round1.input * 0.9));
		expect(round2.input).toBeLessThan(round1.input * 0.25);

		// Positive control for the instrument: break the prefix on purpose the way a
		// digest inside the system prompt used to, and the same reading must collapse.
		const tools = harness.session.getActiveToolNames();
		harness.session.setActiveToolsByName([]);
		const brokenPrompt = harness.session.agent.state.systemPrompt;
		expect(brokenPrompt).not.toBe(promptBefore);
		harness.setResponses([fauxAssistantMessage("reply three")]);
		await harness.session.prompt("same prompt");
		const round3 = record("round3-prefix-broken-positive-control", harness, usageOf(lastAssistant(harness.session)));
		expect(round3.cacheRead).toBeLessThan(round2.cacheRead * 0.5);
		harness.session.setActiveToolsByName(tools);
		expect(harness.session.agent.state.systemPrompt).toBe(promptBefore);
	});

	it("carries a mid-session harness entry into the model's context at the next cold boundary", async () => {
		seedEntry("memory", "seed_d", "Seed D", "Present from the start.");
		const harness = await createHarness({ persistSession: true, settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");

		const firstDigest = digestMessages(harness.session.messages).at(-1);
		expect(firstDigest && getMessageText(firstDigest)).toContain("[global:seed_d] Seed D");

		// Three kinds of harness entry written after the last cold boundary: the
		// memory through a real refine, the skill and the subagent spec on disk the
		// way another seat's refine would leave them.
		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the frozen-menu lesson", [
					{ action: "create", kind: "memory", title: "Frozen menu lesson", content: "Visible after compaction." },
				]),
			),
		]);
		await harness.session.refine({ instructions: "record the frozen-menu lesson" });
		seedEntry("skill", "late_skill", "Late skill", "A skill written mid-session.");
		seedEntry("subagent", "late_subagent", "Late subagent", "A subagent spec written mid-session.");

		// 路 A (merge doc 12.2, boss constraint): the menu is not frozen until the next
		// cold boundary. The next committed turn re-injects it, append-only.
		const carriersBefore = digestMessages(harness.session.messages).length;
		harness.setResponses([fauxAssistantMessage("reply two")]);
		await harness.session.prompt("round two");
		const carriers = digestMessages(harness.session.messages);
		expect(carriers.length).toBe(carriersBefore + 1);
		const delta = getMessageText(carriers.at(-1) as CustomMessage);
		expect(delta).toContain("[local:frozen_menu_lesson] Frozen menu lesson");
		expect(delta).toContain("[global:late_skill] Late skill");
		expect(delta).toContain("[global:late_subagent] Late subagent");
		// Append-only: the carrier that was already in context is untouched, still
		// precedes the delta, and still shows the menu as of its own boundary.
		const firstCarrier = getMessageText(carriers[0] as CustomMessage);
		expect(firstCarrier).toContain("[global:seed_d] Seed D");
		expect(firstCarrier).not.toContain("Late skill");
		expect(harness.session.messages.indexOf(carriers[0] as CustomMessage)).toBeLessThan(
			harness.session.messages.indexOf(carriers.at(-1) as CustomMessage),
		);

		const summarizerContexts: Context[] = [];
		harness.setResponses([
			(context, _options, _state, _model) => {
				summarizerContexts.push(context);
				return fauxAssistantMessage("model-generated summary");
			},
			fauxAssistantMessage("still usable"),
		]);
		const result = await harness.session.compact();
		expect(result.summary).toContain("model-generated summary");

		// The compaction head carries a fresh digest: all three kinds are visible again.
		const head = harness.session.messages.find((message) => message.role === "compactionSummary") as AgentMessage & {
			role: "compactionSummary";
			harnessDigest?: string;
		};
		expect(head).toBeDefined();
		expect(head.harnessDigest).toContain("[local:frozen_menu_lesson] Frozen menu lesson");
		expect(head.harnessDigest).toContain("[global:late_skill] Late skill");
		expect(head.harnessDigest).toContain("[global:late_subagent] Late subagent");
		// ... and it reaches the model ahead of the summary text.
		const headText = llmTexts([head])[0] as string;
		expect(headText.indexOf("# Continual Harness State")).toBeGreaterThanOrEqual(0);
		expect(headText.indexOf("# Continual Harness State")).toBeLessThan(headText.indexOf("model-generated summary"));

		// The digest is attached mechanically, never summarized: the summarizer call
		// for this very compaction saw no digest text, while the persisted head does
		// carry one (that contrast is the positive control for this claim).
		expect(summarizerContexts.length).toBeGreaterThan(0);
		for (const context of summarizerContexts) {
			for (const message of context.messages) {
				expect(getMessageText(message)).not.toContain("# Continual Harness State");
			}
		}
		const compactionEntry = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "compaction")
			.at(-1);
		expect(compactionEntry?.harnessDigest).toContain("[global:late_skill] Late skill");

		// The session still works after the boundary (asserted on the turn completing,
		// not on a queued response text: the split-turn path may consume an extra one).
		const messagesBefore = harness.session.messages.length;
		// Appended rather than set: the split-turn path may have consumed a queued
		// response for the turn-prefix summary, and this pin is about the session
		// still completing a turn, not about the queue's bookkeeping.
		harness.appendResponses([fauxAssistantMessage("still usable"), fauxAssistantMessage("still usable")]);
		await harness.session.prompt("round three");
		expect(lastAssistant(harness.session).stopReason).toBe("stop");
		expect(getMessageText(lastAssistant(harness.session))).toBe("still usable");
		expect(harness.session.messages.length).toBeGreaterThan(messagesBefore);
	});

	it("keeps a refused refinement entry visible to the model (MV-5)", async () => {
		seedEntry("memory", "shared", "Shared", "Global content");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");

		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Update the shared memory", [
					{ action: "update", kind: "memory", id: "global:shared", title: "Shared", content: "Local rewrite" },
				]),
			),
		]);
		// A local-scoped request naming a global entry is refused, not silently applied.
		const result = await harness.session.refine({ instructions: "update local memory" });
		const refused = result.appliedEdits.filter((edit) => !edit.applied);
		expect(refused.length).toBeGreaterThan(0);

		const llm = llmTexts(harness.session.messages).join("\n");
		expect(llm).toContain("refused:");
		expect(llm).toContain("update memory:shared");
		// The refusal reason survives too, so the model can tell why nothing landed.
		// Asserted non-empty first: `toContain("")` passes on anything, which would
		// turn this half of the pin into posture instead of evidence.
		expect(refused[0]?.error).toBeTruthy();
		expect(llm).toContain(refused[0]?.error as string);
		// The digest itself never carries the refusal: it is the receipt's job.
		expect(
			digestMessages(harness.session.messages).at(-1) &&
				getMessageText(digestMessages(harness.session.messages).at(-1)!),
		).not.toContain("refused:");
	});

	it("re-injects when another writer bumps an entry this session already reported", async () => {
		seedEntry("memory", "reported_seed", "Reported seed", "Menu fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");
		expect(digestMessages(harness.session.messages)).toHaveLength(1);

		// This session's own refine: its receipt itemizes the entry, so the next turn owes
		// the model no digest delta for it (merge doc 14.2, no double delivery).
		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the reported lesson", [
					{
						action: "create",
						kind: "memory",
						id: "reported_entry",
						title: "Reported entry",
						content: "v1 written by this session",
					},
				]),
			),
		]);
		const refined = await harness.session.refine({ instructions: "record the reported lesson", global: true });
		expect(refined.appliedEdits.some((edit) => edit.applied)).toBe(true);

		// Another writer bumps the SAME entry afterwards. The receipt itemized version 1,
		// not version 2, so its exemption must not swallow this one: a long session that
		// went quiet here is exactly the frozen menu merge doc 12.2 forbids.
		bumpEntry("reported_entry", "Reported entry", "v2 written by another writer");

		const carriersBefore = digestMessages(harness.session.messages).length;
		harness.setResponses([fauxAssistantMessage("reply two")]);
		await harness.session.prompt("round two");
		const carriers = digestMessages(harness.session.messages);
		expect(carriers).toHaveLength(carriersBefore + 1);
		expect(getMessageText(carriers.at(-1) as CustomMessage)).toContain("v2 written by another writer");
	});

	it("does not double-deliver the entry its own receipt already itemized", async () => {
		seedEntry("memory", "own_seed", "Own seed", "Menu fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");
		const carriersBefore = digestMessages(harness.session.messages).length;

		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the own lesson", [
					{
						action: "create",
						kind: "memory",
						id: "own_entry",
						title: "Own entry",
						content: "written by this session",
					},
				]),
			),
		]);
		const refined = await harness.session.refine({ instructions: "record my own lesson", global: true });
		expect(refined.appliedEdits.some((edit) => edit.applied)).toBe(true);

		harness.setResponses([fauxAssistantMessage("reply two")]);
		await harness.session.prompt("round two");
		// The receipt already itemized this exact version, so the digest stays quiet. This
		// is the positive control for the exemption the pin above narrows: drop the
		// reported-entry check and this one goes red while the one above stays green.
		expect(digestMessages(harness.session.messages)).toHaveLength(carriersBefore);
	});

	it("re-arms injection when a failed delivery parks the digest it just rendered", async () => {
		seedEntry("memory", "park_seed", "Park seed", "Re-arm fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		// The digest is rendered into the turn's next-turn context before the agent is
		// asked to deliver it, so a delivery that throws leaves the session holding a
		// menu it never showed the model. `agent.prompt` is public, and this is the seam
		// the handoff-rollback pins already drive.
		vi.spyOn(harness.session.agent, "prompt").mockImplementationOnce(async () => {
			throw new Error("delivery failed before the digest landed");
		});
		await harness.session.prompt("round one").catch(() => {});
		await harness.session.waitForIdle();

		// Nothing reached the context and nothing durable reached the journal: the digest
		// left with the failed turn instead of being parked as stale pending context.
		expect(digestMessages(harness.session.messages)).toHaveLength(0);
		expect(digestEntries(harness)).toEqual([]);

		// Another writer moves the store while this session has no delivered digest. The
		// re-armed injection owes the model one freshly rendered menu - not the copy
		// rendered before the failure, and not both (that double delivery is exactly what
		// the park filter exists to prevent).
		seedEntry("memory", "late_entry", "Late entry", "Written while the turn was parked.");
		harness.setResponses([fauxAssistantMessage("reply two")]);
		await harness.session.prompt("round two");

		const carriers = digestMessages(harness.session.messages);
		expect(carriers).toHaveLength(1);
		expect(getMessageText(carriers[0] as CustomMessage)).toContain("[global:park_seed] Park seed");
		expect(getMessageText(carriers[0] as CustomMessage)).toContain("[global:late_entry] Late entry");
		expect(digestEntries(harness)).toHaveLength(1);
		expect(conversationMessages(harness.session).map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("appends a fresh digest on resume only when disk state moved", async () => {
		seedEntry("memory", "seed_e", "Seed E", "Resume fixture.");
		const first = await createHarness({ persistSession: true });
		harnesses.push(first);
		first.setResponses([fauxAssistantMessage("reply one")]);
		await first.session.prompt("round one");
		const sessionFile = first.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		expect(digestEntries(first)).toHaveLength(1);

		// Unchanged disk state: identity dedupe keeps the resumed context clean.
		const resumed = await createHarness({ existingSessionFile: sessionFile as string });
		harnesses.push(resumed);
		expect(digestMessages(resumed.session.messages)).toHaveLength(1);
		expect(readFileSync(sessionFile as string, "utf8").split(HARNESS_DIGEST_CUSTOM_TYPE).length - 1).toBe(1);

		// Moved disk state: exactly one fresh digest is appended at the tail.
		seedEntry("memory", "seed_f", "Seed F", "Written while the session was closed.");
		const resumedAgain = await createHarness({ existingSessionFile: sessionFile as string });
		harnesses.push(resumedAgain);
		const digests = digestMessages(resumedAgain.session.messages);
		expect(digests).toHaveLength(2);
		expect(getMessageText(digests[1] as CustomMessage)).toContain("[global:seed_f] Seed F");
		expect(resumedAgain.session.messages.at(-1)).toBe(digests[1]);
	});

	it("reads digest recency by timestamp, not by position", async () => {
		seedEntry("memory", "seed_g", "Seed G", "Recency fixture.");
		const donor = await createHarness({ persistSession: true });
		harnesses.push(donor);
		donor.setResponses([fauxAssistantMessage("reply one")]);
		await donor.session.prompt("round one");

		const journal = donor.sessionManager.getSessionFile() as string;
		const lines = readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const digestLine = lines.find(
			(entry) => entry.type === "custom_message" && entry.customType === HARNESS_DIGEST_CUSTOM_TYPE,
		);
		expect(digestLine).toBeDefined();
		const currentDigest = (digestLine?.details as { digest: string }).digest;
		const staleDigest = `${currentDigest}\n- [global:seed_stale] Stale (older than the newest carrier)`;
		const lastId = lines.at(-1)?.id as string;

		// Retained pre-compaction messages are presented after the compaction head
		// while being chronologically older, so "the last digest in the array" and
		// "the newest digest" are different carriers. Appending one digest entry with
		// a chosen timestamp reproduces exactly that disagreement on a real journal.
		const resumeOver = (name: string, timestamp: string): string => {
			const path = join(dirname(journal), `${name}.jsonl`);
			const appended = {
				...digestLine,
				id: `${name}_digest`,
				parentId: lastId,
				timestamp,
				content: HARNESS_DIGEST_PREFIX + staleDigest + HARNESS_DIGEST_SUFFIX,
				details: { digest: staleDigest },
			};
			writeFileSync(path, `${[...lines, appended].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			return path;
		};

		// The stale carrier sits last in position but is older in time: the newest
		// carrier still matches disk, so resume must not append a duplicate.
		const byTimestamp = await createHarness({
			existingSessionFile: resumeOver("resume-older-stale", "2026-01-01T00:00:00.000Z"),
		});
		harnesses.push(byTimestamp);
		const kept = digestMessages(byTimestamp.session.messages);
		expect(kept).toHaveLength(2);
		expect(kept.map((message) => getMessageText(message))).toEqual([
			HARNESS_DIGEST_PREFIX + currentDigest + HARNESS_DIGEST_SUFFIX,
			HARNESS_DIGEST_PREFIX + staleDigest + HARNESS_DIGEST_SUFFIX,
		]);

		// Positive control for the rule: the identical stale carrier with a future
		// timestamp IS the newest, so the same resume appends a fresh digest.
		const byFuture = await createHarness({
			existingSessionFile: resumeOver("resume-newer-stale", "2999-01-01T00:00:00.000Z"),
		});
		harnesses.push(byFuture);
		const appended = digestMessages(byFuture.session.messages);
		expect(appended).toHaveLength(3);
		expect(getMessageText(appended[2] as CustomMessage)).toContain("[global:seed_g] Seed G");
		expect(getMessageText(appended[2] as CustomMessage)).not.toContain("seed_stale");
	});

	it("keeps the digest out of the user-request ledger and out of headless terminal selection", async () => {
		const digest = createHarnessDigestMessage("# Continual Harness State\n\nmemory: 1");
		// The ledger gate is a whitelist: a boundary-injected digest is not the user's
		// words and must not become a pinned first request or a live obligation.
		expect(isUserIntentMessage(digest)).toBe(false);
		expect(collectUserRequests([digest], 1)).toEqual([]);

		const assistant = fauxAssistantMessage("final output");
		const selected = selectHeadlessTerminalResult([digest, assistant, digest]);
		expect(selected.primary).toBe(assistant);
	});

	it("reads no harness store on a turn whose stores did not move", async () => {
		seedEntry("memory", "seed_j", "Seed J", "Cost fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);

		await harness.session.prompt("round one");
		// Positive control: delivering the first digest really does read the store.
		expect(storeReads.count).toBeGreaterThan(0);

		storeReads.count = 0;
		await harness.session.prompt("round two");
		// The material-change gate is two lstat calls: an unmoved store buys no parse
		// and no render, which is the per-turn cost this whole cut exists to remove.
		expect(storeReads.count).toBe(0);
		expect(digestMessages(harness.session.messages)).toHaveLength(1);
	});

	it("buys no ranked render on a moved stamp that prints nothing new (perf seat C)", async () => {
		seedEntry("memory", "seed_perf", "Seed perf", "Render-cost fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("reply one"),
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
		]);

		await harness.session.prompt("round one");
		// Positive control: the first delivery really does render the digest face.
		expect(digestRenders.count).toBeGreaterThan(0);
		expect(digestMessages(harness.session.messages)).toHaveLength(1);

		// A touch moves the stamp exactly like another seat's rename-based write does,
		// while changing nothing the digest prints.
		digestRenders.count = 0;
		const statePath = join(getGlobalHarnessStateDir(), "harness_state.json");
		const touched = new Date(Date.now() + 60_000);
		utimesSync(statePath, touched, touched);
		await harness.session.prompt("round two");
		expect(digestMessages(harness.session.messages)).toHaveLength(1);
		// Freshness is the state fingerprint, so the turn pays the parse plus the
		// fingerprint and skips the ranked render entirely.
		expect(digestRenders.count).toBe(0);

		// Positive control on the same session: a real state change renders and delivers.
		seedEntry("memory", "seed_perf_two", "Seed perf two", "Second fixture.");
		await harness.session.prompt("round three");
		expect(digestRenders.count).toBeGreaterThan(0);
		expect(digestMessages(harness.session.messages)).toHaveLength(2);
	});

	it("renders once when a legacy carrier forces the text comparison", async () => {
		seedEntry("memory", "seed_legacy", "Seed legacy", "Legacy carrier fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one"), fauxAssistantMessage("reply two")]);
		await harness.session.prompt("round one");
		const carriers = digestMessages(harness.session.messages);
		expect(carriers).toHaveLength(1);

		// A carrier persisted before digests carried a state fingerprint reads back as
		// text only, so freshness has nothing to judge it by but the rendered digest:
		// this turn must render. It must also render exactly once, because the string
		// the comparison just built is the string the append delivers - the deferred
		// render memoizes, and dropping the memo would bill the same text twice.
		delete (carriers[0].details as { stateFingerprint?: string }).stateFingerprint;
		digestRenders.count = 0;
		seedEntry("memory", "seed_legacy_two", "Seed legacy two", "Second legacy fixture.");
		await harness.session.prompt("round two");
		expect(digestRenders.count).toBe(1);
		const after = digestMessages(harness.session.messages);
		expect(after).toHaveLength(2);
		// The delivered carrier is fingerprinted again, so the legacy branch is a
		// one-time cost and the next turn is back to comparing identities.
		expect((after[1].details as { stateFingerprint?: string }).stateFingerprint).toBeDefined();
	});

	it("re-renders the digest when the tool face moves mid-session", async () => {
		seedEntry("memory", "seed_tools", "Seed tools", "Tool-face fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("reply one"),
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
			fauxAssistantMessage("reply four"),
		]);
		await harness.session.prompt("round one");
		const first = digestMessages(harness.session.messages);
		expect(first).toHaveLength(1);
		// The delivered menu describes the tool face it was rendered for: this session
		// boots with the Python REPL, so the call contract teaches the REPL form.
		expect(getMessageText(first[0] as CustomMessage)).toContain(
			"read each installed Python skill's SKILL.md and call its documented module function in the Python REPL",
		);

		// Dropping the tools rebuilds the system prompt but moves neither store stamp,
		// so the material-change gate on its own would leave the model reading a call
		// contract for tools it no longer has until the next cold boundary.
		digestRenders.count = 0;
		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("round two");
		const second = digestMessages(harness.session.messages);
		expect(second).toHaveLength(2);
		expect(digestRenders.count).toBeGreaterThan(0);
		expect(getMessageText(second[1] as CustomMessage)).toContain(
			"routing/context hints only in sessions without the Python REPL or shell access",
		);

		// One move, one re-delivery: the tool face is quiet again, so is the digest.
		await harness.session.prompt("round three");
		expect(digestMessages(harness.session.messages)).toHaveLength(2);

		// Precision of the seam: a rebuild that moves no flag (the same empty tool set
		// again) must invalidate nothing, so the turn stays behind the two-lstat stamp
		// gate - no store parse, no fingerprint, no render. An unconditional
		// invalidate at every rebuild would read the store here and go red.
		storeReads.count = 0;
		digestRenders.count = 0;
		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("round four");
		expect(digestMessages(harness.session.messages)).toHaveLength(2);
		expect(storeReads.count).toBe(0);
		expect(digestRenders.count).toBe(0);
	});

	it("makes another seat's write visible on the next turn, exactly once", async () => {
		seedEntry("memory", "seed_k", "Seed K", "Menu fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("reply one"),
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
			fauxAssistantMessage("reply four"),
			fauxAssistantMessage("reply five"),
		]);
		await harness.session.prompt("round one");
		expect(digestMessages(harness.session.messages)).toHaveLength(1);

		// (a) Another seat writes the shared store: the next turn sees it. This is the
		// frozen-menu hazard the boss constraint names, so it is the主路径, not a boundary.
		seedEntry("memory", "other_seat", "Other seat", "Written by a different process.");
		await harness.session.prompt("round two");
		const afterWrite = digestMessages(harness.session.messages);
		expect(afterWrite).toHaveLength(2);
		expect(getMessageText(afterWrite[1] as CustomMessage)).toContain("[global:other_seat] Other seat");

		// (b) Nothing moved: no second delta for the same state.
		await harness.session.prompt("round three");
		expect(digestMessages(harness.session.messages)).toHaveLength(2);

		// (c) A touched file is not a material change: the criterion is the rendered
		// content, not the mtime, so a stamp move with identical bytes appends nothing.
		const statePath = join(getGlobalHarnessStateDir(), "harness_state.json");
		const touched = new Date(Date.now() + 60_000);
		utimesSync(statePath, touched, touched);
		await harness.session.prompt("round four");
		expect(digestMessages(harness.session.messages)).toHaveLength(2);

		// Writing the same entry again is likewise one delta, not two: a duplicate
		// create is refused, so the menu the model reads does not move.
		seedEntry("memory", "other_seat", "Other seat", "Written by a different process.", "global", {
			expectApplied: false,
		});
		await harness.session.prompt("round five");
		const afterRewrite = digestMessages(harness.session.messages);
		expect(afterRewrite.length).toBeLessThanOrEqual(3);
		expect(getMessageText(afterRewrite.at(-1) as CustomMessage)).toContain("[global:other_seat] Other seat");
		// And every carrier stays in context: the delta appends, it never replaces.
		expect(getMessageText(afterRewrite[0] as CustomMessage)).toContain("[global:seed_k] Seed K");
	});

	it("never rebuilds the system prompt at the refine apply seam", async () => {
		seedEntry("memory", "seed_l", "Seed L", "Prefix fixture.");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");

		const before = harness.session.agent.state.systemPrompt;
		const buildsBefore = promptBuilds.count;
		// Disk context a rebuild would pick up: an agents file and a skill the loader
		// could serve. Neither may reach the prefix through the apply seam, because the
		// seam no longer rebuilds at all - which is what the build counter below pins.
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "# rewritten during the refine\n");

		harness.setResponses([
			fauxAssistantMessage(
				refinePlanJson("Record the prefix lesson", [
					{ action: "create", kind: "memory", title: "Prefix lesson", content: "The prefix did not move." },
				]),
			),
		]);
		const result = await harness.session.refine({ instructions: "record the prefix lesson" });
		expect(result.appliedEdits.some((edit) => edit.applied)).toBe(true);

		expect(promptBuilds.count).toBe(buildsBefore);
		expect(harness.session.agent.state.systemPrompt).toBe(before);
		expect(harness.session.agent.state.systemPrompt).not.toContain("rewritten during the refine");
	});

	it("keeps the digest out of branch-summary input while convertToLlm still renders it", async () => {
		seedEntry("memory", "seed_m", "Seed M", "Branch fixture.");
		const digestText = formatHarnessStateForPrompt(loadHarnessState(getGlobalHarnessStateDir(), "global"));
		expect(digestText).toContain("# Continual Harness State");
		const timestamp = new Date().toISOString();
		const messageEntry: SessionEntry = {
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp,
			message: { role: "user", content: [{ type: "text", text: "the user asked for something" }], timestamp: 1 },
		};
		const headEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: "message-1",
			timestamp,
			summary: "The branch summary text.",
			firstKeptEntryId: "message-1",
			tokensBefore: 100,
			harnessDigest: digestText,
		};

		// A branch summary's messages are summarizer input only, never a live context,
		// so the head it rebuilds must not carry the snapshot into the model call.
		const prepared = prepareBranchEntries([messageEntry, headEntry], 100_000);
		// Read through convertToLlm because that is what generateBranchSummary
		// serializes into the summarizer prompt (branch-summarization.ts:377).
		const summarizerText = llmTexts(prepared.messages).join("\n");
		expect(summarizerText).not.toContain("# Continual Harness State");
		// The entry itself was consumed: only the snapshot is withheld.
		expect(summarizerText).toContain("The branch summary text.");
		expect(summarizerText).toContain("the user asked for something");

		// Two-sided control: the very same entry, on the path that does feed a live
		// context, renders the menu ahead of the summary.
		const head = createCompactionSummaryMessage(
			headEntry.summary,
			headEntry.tokensBefore,
			headEntry.timestamp,
			undefined,
			undefined,
			headEntry.harnessDigest,
		);
		const llmText = llmTexts([head])[0] as string;
		expect(llmText).toContain("# Continual Harness State");
		expect(llmText).toContain("The branch summary text.");
		expect(llmText.indexOf("# Continual Harness State")).toBeLessThan(llmText.indexOf("The branch summary text."));
	});

	it("ranks the digest window by relevance to the current wording (#2241 phase-2 wiring)", async () => {
		// The distinctive entry is seeded FIRST (oldest) and named to sort last, so
		// the no-query injection order (recency desc, then id) drops it from the
		// six-slot window: its appearance later can only be the ranking's doing.
		seedEntry("memory", "zz_distinctive", "Quantum annealing note", "Only quantum annealing matters.");
		for (let i = 0; i < 6; i += 1) {
			seedEntry("memory", `generic_${i}`, `Generic note ${i}`, "Neutral material about tea varieties.");
		}
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ack one")]);
		await harness.session.prompt("tell me about quantum annealing");
		const first = digestMessages(harness.session.messages);
		expect(first).toHaveLength(1);
		// The first turn's digest is built before the user message lands, so its
		// terms are empty and the window is the plain injection order.
		expect(getMessageText(first[0] as CustomMessage)).not.toContain("[global:zz_distinctive]");

		// A state change (another seat's write) triggers a material-change delta.
		// Its terms come from the committed conversation - the current turn's
		// wording lands too late, so turn one's quantum wording is what ranks
		// this window (same lag upstream #2241 accepted): the distinctive entry
		// enters and the overflow names the ranking.
		seedEntry("memory", "aa_new", "Fresh note", "Written mid-session.");
		harness.setResponses([fauxAssistantMessage("ack two")]);
		await harness.session.prompt("a follow-up about tea");
		const digests = digestMessages(harness.session.messages);
		expect(digests).toHaveLength(2);
		const delta = getMessageText(digests[1] as CustomMessage);
		expect(delta).toContain("[global:zz_distinctive]");
		expect(delta).toContain("(entries ranked by relevance to the current task; see harness.search)");
		// Append-only still holds: the first carrier is untouched.
		expect(getMessageText(first[0] as CustomMessage)).not.toContain("[global:zz_distinctive]");
	});

	it("does not re-deliver on a cold boundary when only the wording drifted, and re-delivers on a real state change", async () => {
		// Regression pin for the recursion-suite red ("falls through an invalid
		// global max depth..."): with the ranking wired, a cold boundary rendered
		// with drifted wording produced different bytes than the in-context
		// digest, and the text compare stacked a fresh carrier - moving the leaf
		// under a plain navigateTree. Freshness is the state fingerprint now.
		seedEntry("memory", "zz_distinctive", "Quantum annealing note", "Only quantum annealing matters.");
		for (let i = 0; i < 6; i += 1) {
			seedEntry("memory", `drift_${i}`, `Drift note ${i}`, "Neutral material about tea varieties.");
		}
		const first = await createHarness({ persistSession: true });
		harnesses.push(first);
		first.setResponses([fauxAssistantMessage("ack one")]);
		await first.session.prompt("hello there");
		first.setResponses([fauxAssistantMessage("ack two")]);
		await first.session.prompt("tell me about quantum annealing");
		// No harness write between turns: the material gate stays shut.
		const carriers = digestMessages(first.session.messages);
		expect(carriers).toHaveLength(1);
		const sessionFile = first.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();

		// Resume with unchanged state. The committed conversation now talks about
		// quantum annealing, so a fresh render would re-rank the window and the
		// bytes would differ (the ranking pin above proves these terms move the
		// render); only the state fingerprint can dedupe the delivery.
		const resumed = await createHarness({ existingSessionFile: sessionFile as string });
		harnesses.push(resumed);
		const afterResume = digestMessages(resumed.session.messages);
		expect(afterResume).toHaveLength(1);
		expect(getMessageText(afterResume[0] as CustomMessage)).toBe(getMessageText(carriers[0] as CustomMessage));

		// The interlocked other half: a real state change re-delivers exactly one
		// digest, ranked by the drifted wording.
		seedEntry("memory", "zz_new", "Newer note", "Written while the session was closed.");
		const resumedAgain = await createHarness({ existingSessionFile: sessionFile as string });
		harnesses.push(resumedAgain);
		const afterChange = digestMessages(resumedAgain.session.messages);
		expect(afterChange).toHaveLength(2);
		expect(getMessageText(afterChange[1] as CustomMessage)).toContain("[global:zz_distinctive]");
	});

	it("stamps every digest carrier with the state fingerprint, including the compaction head", async () => {
		seedEntry("memory", "seed_fp", "Seed FP", "Fingerprint carrier fixture.");
		const harness = await createHarness({ persistSession: true, settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply one")]);
		await harness.session.prompt("round one");
		const carrier = digestMessages(harness.session.messages).at(-1) as CustomMessage;
		const details = carrier.details as { digest?: string; stateFingerprint?: string } | undefined;
		expect(details?.digest).toBeTruthy();
		expect(details?.stateFingerprint).toMatch(/^[0-9a-f]{64}$/);

		harness.setResponses([fauxAssistantMessage("summary text"), fauxAssistantMessage("after compaction")]);
		await harness.session.compact();
		const head = harness.session.messages.find((message) => message.role === "compactionSummary");
		expect(head && head.role === "compactionSummary" ? head.harnessStateFingerprint : undefined).toMatch(
			/^[0-9a-f]{64}$/,
		);

		// The next cold boundary trusts the compaction head's fingerprint: resume
		// with unchanged state appends nothing.
		const carriersAfterCompact = digestMessages(harness.session.messages).length;
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const resumed = await createHarness({ existingSessionFile: sessionFile as string });
		harnesses.push(resumed);
		expect(digestMessages(resumed.session.messages)).toHaveLength(carriersAfterCompact);
	});

	it("renders the same harness state byte-identically on every call", async () => {
		seedEntry("memory", "seed_i", "Seed I", "Determinism fixture.");
		const options = { includeIpythonExamples: true, includeShellExamples: true, includeRefineExamples: true };
		const first = formatHarnessStateForPrompt(loadHarnessState(getGlobalHarnessStateDir(), "global"), options);
		const second = formatHarnessStateForPrompt(loadHarnessState(getGlobalHarnessStateDir(), "global"), options);
		// Delivery dedupe compares the state fingerprint over exactly these rendered
		// bytes; a drifting render would desynchronize the two and re-deliver an
		// unchanged digest at every cold boundary.
		expect(second).toBe(first);
		expect(first).toContain("[global:seed_i] Seed I");
	});
});
