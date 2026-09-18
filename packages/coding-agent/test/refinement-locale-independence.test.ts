import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessEntry, HarnessState } from "../src/core/refinement/index.js";
import {
	formatHarnessStateForPrompt,
	harnessDigestFingerprint,
	rankHarnessEntriesForQuery,
} from "../src/core/refinement/index.js";

/**
 * OBS-E1: the harness tie-breaks (`compareEntriesForInjection`'s id/scope keys,
 * the ranked-window tie-break in `rankHarnessEntriesWithRelevance`, and
 * `harnessDigestFingerprint`'s material sort) used `localeCompare` without an
 * explicit locale, so the collator resolved from the process environment and
 * non-ASCII ids re-ordered themselves per machine: same state, different
 * digest bytes and different fingerprint under different `LANG`.
 *
 * Pin A spawns real node children under three locales and requires identical
 * rendered bytes and identical fingerprints. Pin B nails the code-unit order
 * itself in-process (the pairs are chosen so a reverted `localeCompare` turns
 * them red under the default en collation).
 *
 * Pin A only proves locale independence when the runner actually owns a zh
 * collation: if the zh_CN child resolves to a non-zh collator, or the CJK
 * compare sign does not flip between the C and zh_CN children, this machine
 * cannot sort zh differently from C and the cross-locale equality below would
 * be vacuously green. That capability is decided from the children's own
 * self-reports and skips only for that reason.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_WORKDIR = mkdtempSync(join(tmpdir(), "refinement-locale-"));
const CHILD_SCRIPT = join(CHILD_WORKDIR, "locale-child.mts");

/** Leaked agent-session env must not reach test children (repo hygiene rule). */
function childEnv(locale: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(RLM_|PRIME_AGENT_|PI_)/.test(key)) continue;
		env[key] = value;
	}
	env.LC_ALL = locale;
	env.LANG = locale;
	return env;
}

/**
 * The child re-renders one CJK-heavy state under whatever locale it was
 * spawned with and self-reports the collator facts (resolved default locale
 * and the sign of a CJK `localeCompare`) so the parent test can decide
 * capability without trusting its own process.
 */
const CHILD_SOURCE = `
import { createHash } from "node:crypto";
import {
	formatHarnessStateForPrompt,
	harnessDigestFingerprint,
	rankHarnessEntriesForQuery,
} from ${JSON.stringify(join(PKG_ROOT, "src", "core", "refinement", "index.js"))};

const T = "2026-08-01T00:00:00.000Z";
const entry = (id, title, path) => ({
	id,
	kind: "memory",
	title,
	content: "locale probe shared content",
	path,
	scope: "global",
	reference: {},
	arguments: {},
	metadata: {},
	source: "probe",
	created_at: T,
	updated_at: T,
	version: 1,
});
const rows = [
	entry("Zeta", "Zeta title", "general"),
	entry("alpha", "alpha title", "general"),
	entry("修复登录", "修复登录 title", "general"),
	entry("登录故障", "登录故障 title", "general"),
];
const state = {
	schema: 1,
	entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
	refinements: [],
};
for (const row of rows) state.entries.memory[row.id] = row;
const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const rendered = formatHarnessStateForPrompt(state, { maxEntriesPerKind: 8 });
const ranked = rankHarnessEntriesForQuery(rows, new Map([["content", 1]]));
console.log(JSON.stringify({
	lcAll: process.env.LC_ALL ?? "(unset)",
	collatorLocale: new Intl.Collator().resolvedOptions().locale,
	cjkCompareSign: sign("修复".localeCompare("登录")),
	renderedSha256: createHash("sha256").update(rendered).digest("hex"),
	renderedIds: [...rendered.matchAll(/^- \\[(global|local):([^\\]]+)\\] /gm)].map((m) => m[1] + ":" + m[2]),
	rankedIds: ranked.map((r) => r.id),
	fingerprint: harnessDigestFingerprint(state, {
		includeIpythonExamples: true,
		includeShellExamples: true,
		includeRefineExamples: true,
	}),
}));
`;

type ChildReport = {
	lcAll: string;
	collatorLocale: string;
	cjkCompareSign: number;
	renderedSha256: string;
	renderedIds: string[];
	rankedIds: string[];
	fingerprint: string;
};

function runChild(locale: string): ChildReport {
	writeFileSync(CHILD_SCRIPT, CHILD_SOURCE);
	const result = spawnSync(process.execPath, ["--import", "tsx", CHILD_SCRIPT], {
		cwd: PKG_ROOT,
		env: childEnv(locale),
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	expect(result.status, `locale child ${locale} stderr: ${result.stderr ?? "(none)"}`).toBe(0);
	const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as ChildReport;
	return parsed;
}

const ARM_C = runChild("C");
const ARM_EN = runChild("en_US.UTF-8");
const ARM_ZH = runChild("zh_CN.UTF-8");

/**
 * Skip reason, kept decidable and visible: this runner has no zh collation
 * (the zh_CN child resolved a non-zh default locale, or its CJK compare sign
 * matches the C child's), so pin A could not observe a locale flip even if
 * one were reintroduced. The in-process collator control below still proves
 * the fixture is locale-sensitive where ICU knows zh.
 */
const zhCollationMissing =
	!ARM_ZH.collatorLocale.toLowerCase().startsWith("zh") || ARM_ZH.cjkCompareSign === ARM_C.cjkCompareSign;

afterAll(() => {
	rmSync(CHILD_WORKDIR, { recursive: true, force: true });
});

const inState = (ids: string[]): HarnessState => {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const id of ids) {
		state.entries.memory[id] = {
			id,
			kind: "memory",
			title: `${id} title`,
			content: "shared content",
			path: "general",
			scope: "global",
			reference: {},
			arguments: {},
			metadata: {},
			source: "test",
			created_at: "2026-08-01T00:00:00.000Z",
			updated_at: "2026-08-01T00:00:00.000Z",
			version: 1,
		};
	}
	return state;
};

const injectedIds = (state: HarnessState): string[] =>
	[...formatHarnessStateForPrompt(state, { maxEntriesPerKind: 8 }).matchAll(/^- \[(global|local):([^\]]+)\] /gm)].map(
		(m) => `${m[1]}:${m[2]}`,
	);

const equalScoreEntries = (ids: string[]): HarnessEntry[] =>
	ids.map((id) => ({
		id,
		kind: "memory" as const,
		title: `${id} title`,
		content: "shared content",
		path: "general",
		scope: "global" as const,
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-01T00:00:00.000Z",
		version: 1,
	}));

describe("harness tie-break locale independence (OBS-E1)", () => {
	it("fixture control: zh-CN and en-US collators disagree on the CJK pair", () => {
		// Positive control for the skip below: the pair the arms sort really is
		// collation-sensitive in this ICU, so a runner that cannot flip it in a
		// child is missing a capability, not proving stability.
		const zh = Math.sign(new Intl.Collator("zh-CN").compare("修复", "登录"));
		const en = Math.sign(new Intl.Collator("en-US").compare("修复", "登录"));
		expect(zh).not.toBe(0);
		expect(zh).toBe(-en);
	});

	it.skipIf(zhCollationMissing)(
		"renders byte-identical digests and identical fingerprints under C, en_US and zh_CN locales",
		() => {
			// Self-reports: every child must have been spawned under its own
			// locale (the zh child resolves a zh collator and flips the CJK
			// compare sign), otherwise the equality below would be vacuous.
			expect(ARM_C.collatorLocale.toLowerCase()).not.toContain("zh");
			expect(ARM_ZH.collatorLocale.toLowerCase().startsWith("zh")).toBe(true);
			expect(ARM_ZH.cjkCompareSign).toBe(-ARM_C.cjkCompareSign);

			expect(ARM_EN.renderedSha256).toBe(ARM_C.renderedSha256);
			expect(ARM_ZH.renderedSha256).toBe(ARM_C.renderedSha256);
			expect(ARM_ZH.fingerprint).toBe(ARM_C.fingerprint);
			expect(ARM_EN.fingerprint).toBe(ARM_C.fingerprint);
			// Code-unit order in every arm: "Zeta" (Z=0x5A) sorts before
			// "alpha" (a=0x61); 修复登录 (U+4FEE) sorts before 登录故障 (U+767B).
			for (const arm of [ARM_C, ARM_EN, ARM_ZH]) {
				expect(arm.renderedIds).toEqual(["global:Zeta", "global:alpha", "global:修复登录", "global:登录故障"]);
				expect(arm.rankedIds).toEqual(["Zeta", "alpha", "修复登录", "登录故障"]);
			}
		},
	);

	it("injection order breaks recency ties in code-unit order, not collation order", () => {
		// All timestamps equal, so only the id tie-break can decide. The pair
		// is chosen so the en collation would put "alpha" first: a reverted
		// localeCompare turns this red on every ASCII-default runner.
		expect(injectedIds(inState(["alpha", "Zeta", "登录故障", "修复登录"]))).toEqual([
			"global:Zeta",
			"global:alpha",
			"global:修复登录",
			"global:登录故障",
		]);
	});

	it("ranked window breaks score ties in code-unit identifier order", () => {
		// Equal scores for every entry (same content term), so the ranked
		// window order is purely the identifier tie-break.
		const ranked = rankHarnessEntriesForQuery(
			equalScoreEntries(["alpha", "Zeta", "登录故障", "修复登录"]),
			new Map([["shared", 1]]),
		);
		expect(ranked.map((entry) => entry.id)).toEqual(["Zeta", "alpha", "修复登录", "登录故障"]);
	});

	it("fingerprint ignores insertion order of CJK-id entries", () => {
		const FLAGS = {
			includeIpythonExamples: true,
			includeShellExamples: true,
			includeRefineExamples: true,
		};
		const forward = harnessDigestFingerprint(inState(["修复登录", "登录故障", "Zeta"]), FLAGS);
		expect(harnessDigestFingerprint(inState(["登录故障", "Zeta", "修复登录"]), FLAGS)).toBe(forward);
	});
});
