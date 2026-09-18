#!/usr/bin/env node
/**
 * Single source of truth for the CI job "Test (coding-agent process smoke)".
 *
 * Why this file exists
 * --------------------
 * That job's numbers used to live in two places at once: `.github/workflows/ci.yml` (the matrix
 * row CI actually runs) and `scripts/check-process-smoke.sh` (the local mirror of the same job),
 * which hand-copied `min_tests`/`min_ran_tests`/`max_nothing_files` and the whole tag-skip ledger
 * string verbatim. Nothing compared the two copies - the only protection was a sentence in
 * `docs/fork/merge-upstream-20260917.md` saying "改口径要同批改两处". A copy that no gate reads is
 * a copy that rots: the local mirror would keep gating at the old floors after CI moved, and both
 * would stay green while measuring different things.
 *
 * So the values live here once. `check-process-smoke.sh` reads them through `--shell`, and
 * `packages/coding-agent/test/ci-floor-policy.test.ts` parses the `ci.yml` matrix row and requires
 * it to be **strictly equal** to these exports (printing both sides when it is not). Changing a
 * floor or a declared skip is therefore a one-file change that reddens CI until `ci.yml` agrees.
 *
 * Where the numbers come from
 * ---------------------------
 * The floors are 90% of what the job really produced in CI run 35341768020 (head
 * 8ed6d73bc813891679dec7bd11f2160ff218abda): collected=24, ran=12, nothing-files=1. The reading
 * itself is recorded in `scripts/ci-floor-readings.json`, and that file - not this one - is where a
 * recompute starts (`node scripts/check-vitest-coverage.mjs <report> --recompute-floors`).
 *
 * Usage
 * -----
 *   node scripts/lib/ci-process-smoke.mjs --shell              # KEY=VALUE lines for bash
 *   node scripts/lib/ci-process-smoke.mjs --json               # the same values as JSON
 *   node scripts/lib/ci-process-smoke.mjs --field tag_skip_ledger
 *   node scripts/lib/ci-process-smoke.mjs --self-test          # prove the shape still holds
 *
 * Exit codes: 0 = printed, 1 = self-test mismatch, 2 = usage.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The floors `.github/workflows/ci.yml`'s matrix row "coding-agent process smoke" must carry.
 * Keys are spelled exactly like the matrix keys so a comparison against the parsed YAML is
 * key-for-key, with no translation layer to drift.
 */
export const PROCESS_SMOKE_FLOORS = Object.freeze({
	/** 24 tests collected in the pinned run; floor = ceil(0.9 * 24). */
	min_tests: 22,
	/**
	 * 12 tests ran in the pinned run (the other 12 carry the `process-stress` tag that
	 * `packages/coding-agent/vitest.config.ts` filters out); floor = ceil(0.9 * 12) = 11. The
	 * one test of slack is deliberate: the tag-skip ledger below pins all twelve skips exactly,
	 * so a skip that moves is named by the ledger gate rather than absorbed here.
	 */
	min_ran_tests: 11,
	/**
	 * `daemon-supervisor-crash-handlers-process.test.ts` is the one file allowed to run nothing
	 * here: all four of its tests are `process-stress`, and the nightly job is their face.
	 */
	max_nothing_files: 1,
});

/**
 * What this job deliberately does not run, one entry per file. `check-tag-skip-ledger.sh` fails
 * the job when the report disagrees with this list in either direction, so every entry needs a
 * reason that names where those tests do run.
 */
export const PROCESS_SMOKE_TAG_SKIP_ENTRIES = Object.freeze([
	Object.freeze({
		path: "packages/coding-agent/test/daemon-supervisor-process.test.ts",
		count: 8,
		reason: "process-stress tag-filtered by vitest.config.ts; nightly-process-stress.yml runs it",
	}),
	Object.freeze({
		path: "packages/coding-agent/test/daemon-supervisor-crash-handlers-process.test.ts",
		count: 4,
		reason: "process-stress tag-filtered by vitest.config.ts; nightly-process-stress.yml runs it",
	}),
]);

/** The entries as the one-line `--ledger` spec both `ci.yml` and the local mirror pass. */
export const PROCESS_SMOKE_TAG_SKIP_LEDGER = PROCESS_SMOKE_TAG_SKIP_ENTRIES.map(
	(entry) => `${entry.path}=${entry.count}:${entry.reason}`,
).join(";;");

/** The keys `--shell` prints, in order. */
const SHELL_KEYS = Object.freeze([
	["MIN_TESTS", () => PROCESS_SMOKE_FLOORS.min_tests],
	["MIN_RAN_TESTS", () => PROCESS_SMOKE_FLOORS.min_ran_tests],
	["MAX_NOTHING_FILES", () => PROCESS_SMOKE_FLOORS.max_nothing_files],
	["LEDGER", () => PROCESS_SMOKE_TAG_SKIP_LEDGER],
]);

const FIELD_ALIASES = Object.freeze({
	min_tests: () => PROCESS_SMOKE_FLOORS.min_tests,
	min_ran_tests: () => PROCESS_SMOKE_FLOORS.min_ran_tests,
	max_nothing_files: () => PROCESS_SMOKE_FLOORS.max_nothing_files,
	tag_skip_ledger: () => PROCESS_SMOKE_TAG_SKIP_LEDGER,
});

/** Everything, for a test that wants to compare the exports with a parsed `ci.yml` row. */
export function processSmokeConfig() {
	return {
		floors: { ...PROCESS_SMOKE_FLOORS },
		tag_skip_ledger: PROCESS_SMOKE_TAG_SKIP_LEDGER,
		tag_skip_entries: PROCESS_SMOKE_TAG_SKIP_ENTRIES.map((entry) => ({ ...entry })),
	};
}

/** `KEY=VALUE` lines. The ledger value contains `=`, so a consumer splits on the first one only. */
export function shellLines() {
	return SHELL_KEYS.map(([key, read]) => `${key}=${read()}`);
}

/**
 * Split a `--ledger` spec back into entries the same way `check-tag-skip-ledger.sh` does: `;;`
 * separates entries, a reason may contain single `;` and `:`.
 */
export function parseLedgerSpec(spec) {
	return String(spec)
		.split(";;")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const match = /^([^=]+)=(\d+)(?::(.*))?$/.exec(line);
			if (!match) return { line, path: null, count: null, reason: null };
			return { line, path: match[1], count: Number.parseInt(match[2], 10), reason: (match[3] ?? "").trim() };
		});
}

function selfTest() {
	const controls = [];
	const floors = PROCESS_SMOKE_FLOORS;

	controls.push({
		name: "the floors are positive integers with ran <= collected",
		ok: () =>
			[floors.min_tests, floors.min_ran_tests, floors.max_nothing_files].every(
				(value) => Number.isInteger(value) && value >= 0,
			) &&
			floors.min_tests > 0 &&
			floors.min_ran_tests > 0 &&
			floors.min_ran_tests <= floors.min_tests,
		detail: () => JSON.stringify(floors),
	});
	controls.push({
		name: "every declared skip carries a count and a reason",
		ok: () =>
			PROCESS_SMOKE_TAG_SKIP_ENTRIES.every(
				(entry) =>
					typeof entry.path === "string" &&
					entry.path.startsWith("packages/") &&
					Number.isInteger(entry.count) &&
					entry.count > 0 &&
					typeof entry.reason === "string" &&
					entry.reason.trim().length > 0,
			),
		detail: () => JSON.stringify(PROCESS_SMOKE_TAG_SKIP_ENTRIES),
	});
	controls.push({
		name: "the one-line ledger spec parses back into exactly the declared entries",
		ok: () => {
			const parsed = parseLedgerSpec(PROCESS_SMOKE_TAG_SKIP_LEDGER);
			return (
				parsed.length === PROCESS_SMOKE_TAG_SKIP_ENTRIES.length &&
				parsed.every(
					(entry, index) =>
						entry.path === PROCESS_SMOKE_TAG_SKIP_ENTRIES[index].path &&
						entry.count === PROCESS_SMOKE_TAG_SKIP_ENTRIES[index].count &&
						entry.reason === PROCESS_SMOKE_TAG_SKIP_ENTRIES[index].reason,
				)
			);
		},
		detail: () => PROCESS_SMOKE_TAG_SKIP_LEDGER,
	});
	controls.push({
		name: "a reason containing the `;;` separator would corrupt the spec (negative control)",
		ok: () => {
			// The round-trip above only means something if a broken entry actually breaks it.
			const broken = parseLedgerSpec("packages/x.test.ts=2:reason;; with a separator;;packages/y.test.ts=1:r");
			return broken.length === 3 && broken[1].path === null;
		},
		detail: () => JSON.stringify(parseLedgerSpec("packages/x.test.ts=2:a;;b")),
	});
	controls.push({
		name: "the shell surface carries all four keys and nothing else",
		ok: () => {
			const lines = shellLines();
			const keys = lines.map((line) => line.slice(0, line.indexOf("=")));
			return (
				lines.length === 4 &&
				keys.join(",") === "MIN_TESTS,MIN_RAN_TESTS,MAX_NOTHING_FILES,LEDGER" &&
				lines.every((line) => line.includes("=") && line.slice(line.indexOf("=") + 1).length > 0)
			);
		},
		detail: () => shellLines().join(" | "),
	});
	controls.push({
		name: "no file is declared twice and the declared total is a positive count",
		ok: () => {
			const paths = PROCESS_SMOKE_TAG_SKIP_ENTRIES.map((entry) => entry.path);
			const declared = PROCESS_SMOKE_TAG_SKIP_ENTRIES.reduce((sum, entry) => sum + entry.count, 0);
			return new Set(paths).size === paths.length && declared > 0;
		},
		detail: () => JSON.stringify(PROCESS_SMOKE_TAG_SKIP_ENTRIES.map((entry) => entry.path)),
	});

	let mismatches = 0;
	for (const control of controls) {
		let ok = false;
		let threw;
		try {
			ok = control.ok();
		} catch (error) {
			threw = error;
		}
		if (!ok) mismatches += 1;
		console.log(`${ok ? "ok  " : "FAIL"} ${control.name}${threw ? ` (threw ${threw.message})` : ""}`);
		if (!ok && !threw) console.log(`       ${control.detail()}`);
	}
	console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}

function main(argv) {
	const [command, rest] = [argv[0], argv.slice(1)];
	switch (command) {
		case "--shell":
			if (rest.length > 0) return usage(`--shell takes no argument (got ${rest.join(" ")})`);
			for (const line of shellLines()) console.log(line);
			return 0;
		case "--json":
			if (rest.length > 0) return usage(`--json takes no argument (got ${rest.join(" ")})`);
			console.log(JSON.stringify(processSmokeConfig(), null, "\t"));
			return 0;
		case "--field": {
			const name = rest[0];
			const read = name === undefined ? undefined : FIELD_ALIASES[name];
			if (read === undefined) {
				return usage(`--field needs one of ${Object.keys(FIELD_ALIASES).join(", ")}`);
			}
			if (rest.length > 1) return usage(`--field takes exactly one argument`);
			console.log(String(read()));
			return 0;
		}
		case "--self-test":
			if (rest.length > 0) return usage(`--self-test takes no argument`);
			return selfTest();
		case "-h":
		case "--help":
			console.log(usageText);
			return 0;
		default:
			return usage(`unknown command "${command ?? ""}"`);
	}
}

const usageText = `usage: node scripts/lib/ci-process-smoke.mjs --shell | --json | --field <name> | --self-test`;

function usage(message) {
	console.error(`ci-process-smoke: ${message}`);
	console.error(usageText);
	return 2;
}

// Runnable as a CLI (what `check-process-smoke.sh` calls) and importable as a module (what the
// ci-floor-policy pin compares `ci.yml` against). Only the former may exit the process.
//
// Both paths are canonicalised through `realpathSync` before they are compared: node resolves a
// module's own symlinks (so `import.meta.url` is the real path) while `process.argv[1]` is whatever
// the caller typed. On a checkout reached through a symlinked directory - `/tmp/x` on macOS is
// `/private/tmp/x`, and a linked workspace has the same shape on Linux - a raw comparison is false,
// the CLI prints nothing and `check-process-smoke.sh` aborts with "returned no MIN_TESTS" instead of
// gating. A path that cannot be canonicalised falls back to the literal comparison.
function invokedAsScript() {
	const invoked = process.argv[1];
	if (invoked === undefined) return false;
	const here = fileURLToPath(import.meta.url);
	const same = (a, b) => {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return a === b;
		}
	};
	return same(invoked, here);
}

const invokedDirectly = invokedAsScript();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
