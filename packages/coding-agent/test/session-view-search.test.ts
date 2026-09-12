import { describe, expect, it } from "vitest";
import {
	createSearchTextMatcher,
	createSessionSearchText,
	matchesSearchText,
} from "../src/modes/agents-view/session-view-search.js";

describe("session view search", () => {
	it("matches fuzzy tokens, normalized phrases, and case-insensitive regexes", () => {
		const text = createSessionSearchText(["Release Planner", "/work/widget", "fixed the node\n  CVE"]);
		expect(matchesSearchText(text, "rls plnr")).toBe(true);
		expect(matchesSearchText(text, '"node cve"')).toBe(true);
		expect(matchesSearchText(text, "re:/WORK/\\w+")).toBe(true);
		expect(matchesSearchText(text, "re:(")).toBe(false);
	});

	it("rejects noisy fuzzy matches that only scatter across the corpus", () => {
		const text = createSessionSearchText(["Release Planner", "/work/widget", "fixed the node\n  CVE"]);
		expect(matchesSearchText(text, "planner")).toBe(true);
		expect(matchesSearchText(text, "rwfxce")).toBe(false);
	});

	it("reuses one parsed query across a catalog pass without carrying state", () => {
		const queries = ["rls plnr", '"node cve"', "re:/WORK/\\w+", "re:(", "planner", ""];
		expect(queries.length).toBeGreaterThan(0);
		const text = createSessionSearchText(["Release Planner", "/work/widget", "fixed the node\n  CVE"]);
		const other = createSessionSearchText(["unrelated session"]);
		for (const query of queries) {
			const matches = createSearchTextMatcher(query);
			expect(matches(text)).toBe(matchesSearchText(text, query));
			expect(matches(other)).toBe(matchesSearchText(other, query));
			// The matcher is reused per row: an earlier row must not change the next verdict.
			expect(matches(text)).toBe(matchesSearchText(text, query));
		}
	});
});
