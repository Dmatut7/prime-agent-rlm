import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	COMPACTION_SUMMARY_PREFIX,
	convertToLlm,
	createCompactionSummaryMessage,
	HARNESS_DIGEST_PREFIX,
} from "../src/core/messages.js";
import type { HarnessEntry, HarnessRefinementEvent, HarnessState } from "../src/core/refinement/index.js";
import { formatHarnessStateForPrompt, harnessDigestFingerprint } from "../src/core/refinement/index.js";

/**
 * MEM-STABLE (wave-32): the harness digest and the memory segment of the
 * compaction handoff are part of the cached prompt prefix, so the same logical
 * state must serialize to byte-identical text on every render. The CC 2.1.275
 * regression this pins against: a recovered memory file whose rendered age note
 * moved between requests invalidated the whole prompt cache every turn.
 *
 * The render paths under test read only stored state (no wall clock, no
 * locale, no Map/Object iteration order), and these tests pin exactly that:
 * permuted insertion order, a real wall-clock gap between renders, a JSON
 * round-trip (the session-resume path), and a permuted query-terms Map must
 * all leave every output byte untouched.
 */

const T = "2026-09-01T00:00:00.000Z";

function entry(id: string, kind: HarnessEntry["kind"], overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind,
		title: `${id} title`,
		content: `content of ${id}: prompt cache stability note`,
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: T,
		updated_at: T,
		version: 1,
		...overrides,
	};
}

/**
 * One shared logical state, rich enough to reach every render branch: the
 * detail window, the byte-capped index layer, the omitted-tail line, a skill's
 * args/ref contract, a malformed-entry skip line, a malformed refinement-event
 * skip line, and the newest-tail refinement window.
 */
function fixtureEntries(): HarnessEntry[] {
	const memories: HarnessEntry[] = [];
	// 10 memories over a detail window of 4 force the stage-2 index layer; two
	// pairs share a timestamp so the id tie-break (not insertion order) decides.
	for (let i = 0; i < 10; i += 1) {
		const day = `0${(i % 5) + 1}`;
		memories.push(
			entry(`mem_${i}`, "memory", {
				title: `memory ${i} cache 缓存`,
				content: `memory ${i} body: prompt cache digest stability 缓存`,
				updated_at: `2026-09-${day}T00:00:00.000Z`,
				scope: i % 2 === 0 ? "global" : "local",
			}),
		);
	}
	// CJK ids: code-unit order must decide their placement, not collation.
	memories.push(entry("修复登录", "memory", { title: "修复登录 title", updated_at: T }));
	memories.push(entry("登录故障", "memory", { title: "登录故障 title", updated_at: T }));
	const skills = [
		entry("skill_review", "skill", {
			title: "review skill",
			content: "review a patch",
			// Multi-key objects: the render prints JSON.stringify of these, so a
			// key-order-dependent serializer would show up under permutation.
			reference: { type: "python", import: "agent_skills.review", callable: "run", call_pattern: "await run(...)" },
			arguments: { target: { type: "string", required: true }, mode: { type: "string" } },
		}),
		entry("skill_bench", "skill", {
			title: "bench skill",
			content: "run the benchmark",
			reference: { type: "python", import: "agent_skills.bench", callable: "run", call_pattern: "await run(...)" },
			arguments: { suite: { type: "string" } },
		}),
	];
	const others = [
		entry("prompt_tone", "prompt", { title: "tone note", content: "keep answers short" }),
		entry("sub scout", "subagent", { title: "scout spec", content: "explore the repo" }),
		entry("sub_runner", "subagent", { title: "runner spec", content: "run the suite" }),
		// Malformed detail-window entry: renders as a skip line, which must be
		// byte-stable too.
		// Newest timestamp so the skip line lands inside the detail window.
		entry("mem_broken", "memory", { title: null as unknown as string, updated_at: "2026-09-09T00:00:00.000Z" }),
	];
	return [...memories, ...skills, ...others];
}

function fixtureRefinements(): HarnessRefinementEvent[] {
	const events: HarnessRefinementEvent[] = [];
	for (let i = 0; i < 7; i += 1) {
		events.push({
			id: `refine_2026090${i}_000000_ab${i}`,
			trigger: `refinement ${i}: record the cache lesson`,
			changes: [`memory:mem_${i}`],
			evidence: "test",
			outcome: `outcome ${i}`,
			created_at: T,
		});
	}
	// Malformed event: renders as a skip line instead of its fields.
	events.push({
		id: "refine_broken",
		trigger: null as unknown as string,
		changes: [],
		evidence: "test",
		outcome: "broken",
		created_at: T,
	});
	return events;
}

/** Builds the same logical state with entries inserted in the given order. */
function stateWithInsertionOrder(ids: string[]): HarnessState {
	const byId = new Map(fixtureEntries().map((item) => [item.id, item]));
	expect(byId.size).toBe(fixtureEntries().length);
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: fixtureRefinements(),
	};
	for (const id of ids) {
		const item = byId.get(id);
		expect(item, `fixture id ${id}`).toBeDefined();
		state.entries[item!.kind][id] = item!;
	}
	return state;
}

const FORWARD_IDS = fixtureEntries().map((item) => item.id);
const REVERSED_IDS = [...FORWARD_IDS].reverse();
// A third order: interleave kinds so no kind's records are contiguous.
const INTERLEAVED_IDS = [...FORWARD_IDS].sort(
	(a, b) => (a.charCodeAt(a.length - 1) % 3) - (b.charCodeAt(b.length - 1) % 3),
);

const RENDER_OPTIONS = { maxEntriesPerKind: 4, indexMaxBytes: 600 };
const FINGERPRINT_FLAGS = {
	includeIpythonExamples: true,
	includeShellExamples: true,
	includeRefineExamples: true,
	indexMaxBytes: 600,
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("harness digest byte stability (MEM-STABLE)", () => {
	it("renders byte-identical text and fingerprint across entry insertion orders", () => {
		const forward = stateWithInsertionOrder(FORWARD_IDS);
		const reversed = stateWithInsertionOrder(REVERSED_IDS);
		const interleaved = stateWithInsertionOrder(INTERLEAVED_IDS);
		const renderedForward = formatHarnessStateForPrompt(forward, RENDER_OPTIONS);
		// The fixture really exercises the branches this pin exists for.
		expect(renderedForward).toContain("entries by id + title");
		expect(renderedForward).toContain("beyond the index byte cap");
		expect(renderedForward).toContain("skipped malformed entry mem_broken");
		expect(renderedForward).toContain("skipped malformed refinement event refine_broken");
		expect(renderedForward).toContain("older refinement events");
		expect(formatHarnessStateForPrompt(reversed, RENDER_OPTIONS)).toBe(renderedForward);
		expect(formatHarnessStateForPrompt(interleaved, RENDER_OPTIONS)).toBe(renderedForward);
		expect(harnessDigestFingerprint(reversed, FINGERPRINT_FLAGS)).toBe(
			harnessDigestFingerprint(forward, FINGERPRINT_FLAGS),
		);
		expect(harnessDigestFingerprint(interleaved, FINGERPRINT_FLAGS)).toBe(
			harnessDigestFingerprint(forward, FINGERPRINT_FLAGS),
		);
	});

	it("renders byte-identical text across a wall-clock gap (no render-time clock)", async () => {
		// The CC 2.1.275 failure class: a recovered memory's age note was
		// recomputed per request and invalidated the prompt cache every turn. The
		// digest must carry stored timestamps only, never a render-time clock.
		const state = stateWithInsertionOrder(FORWARD_IDS);
		const before = formatHarnessStateForPrompt(state, RENDER_OPTIONS);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const after = formatHarnessStateForPrompt(state, RENDER_OPTIONS);
		expect(after).toBe(before);
		expect(before).not.toMatch(/\b\d+\s+(second|minute|hour|day)s?\s+ago\b/i);
	});

	it("renders byte-identical text after a JSON round-trip (the session-resume path)", () => {
		// Resume restores the store through JSON.parse; the re-parsed state must
		// render the same bytes the live state rendered before the restart.
		const state = stateWithInsertionOrder(FORWARD_IDS);
		const restored = JSON.parse(JSON.stringify(state)) as HarnessState;
		const live = formatHarnessStateForPrompt(state, RENDER_OPTIONS);
		expect(formatHarnessStateForPrompt(restored, RENDER_OPTIONS)).toBe(live);
		expect(harnessDigestFingerprint(restored, FINGERPRINT_FLAGS)).toBe(
			harnessDigestFingerprint(state, FINGERPRINT_FLAGS),
		);
	});

	it("renders byte-identical text when the query-terms Map is built in a different order", () => {
		// Wave-29 ranked window: term weights arrive in a Map; insertion order of
		// that Map must not move a single rendered byte (scores are per-entry sums
		// over the entry's own hit set, ties break on the stable identifier).
		const terms: Array<[string, number]> = [
			["cache", 3],
			["缓存", 2],
			["digest", 2],
			["stability", 1],
		];
		const forward = new Map(terms);
		const reversed = new Map([...terms].reverse());
		const state = stateWithInsertionOrder(FORWARD_IDS);
		const rankedForward = formatHarnessStateForPrompt(state, { ...RENDER_OPTIONS, queryTerms: forward });
		expect(rankedForward).toContain("ranked by relevance");
		expect(formatHarnessStateForPrompt(state, { ...RENDER_OPTIONS, queryTerms: reversed })).toBe(rankedForward);
		// And the ranked render itself is repeatable.
		expect(formatHarnessStateForPrompt(state, { ...RENDER_OPTIONS, queryTerms: forward })).toBe(rankedForward);
	});

	it("compaction handoff: the memory segment assembles byte-identically on every conversion", () => {
		// The digest rides into the compacted transcript ahead of the summary
		// (messages.ts compactionSummary case); that assembly is what later
		// requests read from cache, so it must not drift between conversions.
		const digest = formatHarnessStateForPrompt(stateWithInsertionOrder(FORWARD_IDS), RENDER_OPTIONS);
		const build = (): string => {
			const message: AgentMessage = createCompactionSummaryMessage(
				"## Goal\nnarrative",
				100000,
				T,
				undefined,
				undefined,
				digest,
				"abc123",
			);
			const rendered = convertToLlm([message]);
			expect(rendered).toHaveLength(1);
			const content = rendered[0].content;
			expect(Array.isArray(content) && content[0]?.type === "text").toBe(true);
			return (content as Array<{ type: string; text: string }>)[0].text;
		};
		const first = build();
		expect(sha256(first)).toBe(sha256(build()));
		expect(first.startsWith(HARNESS_DIGEST_PREFIX)).toBe(true);
		expect(first.indexOf(HARNESS_DIGEST_PREFIX)).toBeLessThan(first.indexOf(COMPACTION_SUMMARY_PREFIX));
		expect(first).toContain(digest);
	});
});
