#!/usr/bin/env node
/**
 * Test hygiene gate: block NEW private-member probes in package tests.
 *
 * Why this exists
 * ---------------
 * Tests that reach into `_`-prefixed members through `as unknown as { _foo: ... }` casts or
 * `vi.spyOn(session, "_foo")` make refactoring invisible to the type system: renaming or moving a
 * private member breaks no compile step, it only breaks the probe. The fork already carries a large
 * frozen stock of these probes (see the baseline file next to this script), so a whole-repository
 * gate would be permanently red. This gate is therefore diff-scoped and baseline-frozen:
 *
 *   - Only `packages/<pkg>/test/**` is scanned. Nothing else, ever.
 *   - Symlinks are never followed and any directory named `node_modules` is skipped, so the scan
 *     cannot wander into installed dependencies (the monorepo has nested `node_modules` trees and
 *     absolute symlinks that point outside the checkout).
 *   - Violations already recorded in `scripts/test-private-probe-baseline.json` are frozen: they
 *     report as info, never as failures.
 *   - Everything else fails: a new probe in a new file, a new probe in a file that already has
 *     frozen probes, or an extra copy of a frozen probe beyond its frozen count.
 *   - With `--base <ref>` the added/changed lines of the diff are computed and used to label each
 *     new violation, and `--strict-diff` additionally fails when a frozen probe sits on a changed
 *     line. Note that a line-based diff cannot see a pure move of byte-identical lines: such lines
 *     stay in the longest common subsequence and are never reported as added. The end-to-end
 *     controls below assert that behaviour instead of pretending otherwise.
 *
 * Deliberate non-goals
 * --------------------
 *   - Not wired into `npm run check` / the pre-commit hook: that would block every lane (including
 *     upstream merge-backs) on frozen stock. It runs in CI and on demand.
 *   - Cross-file alias resolution: `as unknown as SomeInternals` is only flagged when
 *     `SomeInternals` is declared as a brace-form `type`/`interface` in the same file.
 *   - Computed probe targets (`vi.spyOn(obj, name)` where `name` is a variable) cannot be seen
 *     statically and are not flagged.
 *
 * Escape hatch
 * ------------
 * A line carrying `test-hygiene-allow: <reason>` (on the violation line or the line directly above
 * it) suppresses that violation. The reason is mandatory; suppressions are counted and printed so
 * they stay visible in review.
 *
 * Usage
 * -----
 *   node scripts/check-test-private-probes.mjs                 # gate (baseline-frozen)
 *   node scripts/check-test-private-probes.mjs --base <ref>    # gate + diff labelling
 *   node scripts/check-test-private-probes.mjs --strict-diff --base <ref>
 *   node scripts/check-test-private-probes.mjs --self-test     # scanner + decision controls
 *   node scripts/check-test-private-probes.mjs --list          # print every current violation
 *   node scripts/check-test-private-probes.mjs --update-baseline   # re-freeze current stock
 *   node scripts/check-test-private-probes.mjs --json          # machine-readable report
 */

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "test-private-probe-baseline.json");
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ALLOW_MARKER = "test-hygiene-allow:";
const HARD_TIMEOUT_MS = 120_000;

const RULE_PRIVATE_CAST = "private-cast";
const RULE_PRIVATE_CAST_ALIAS = "private-cast-alias";
const RULE_PRIVATE_SPY = "private-spyon";
const RULES = [RULE_PRIVATE_CAST, RULE_PRIVATE_CAST_ALIAS, RULE_PRIVATE_SPY];

const RULE_HELP = {
	[RULE_PRIVATE_CAST]:
		"`as unknown as { _member: ... }` probes a private member through a cast. Use a public seam (an exported helper, an injectable option, or an observable event) instead.",
	[RULE_PRIVATE_CAST_ALIAS]:
		"`as unknown as <Shadow>` casts to a locally declared shadow type that describes private members. Give the class a real, narrow interface (or a test-only seam) instead of re-declaring its internals.",
	[RULE_PRIVATE_SPY]:
		'`vi.spyOn(target, "_member")` spies on a private member. Drive the public entry point and assert on observable output instead.',
};

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const options = {
		base: undefined,
		strictDiff: false,
		selfTest: false,
		list: false,
		updateBaseline: false,
		json: false,
		baselinePath: BASELINE_PATH,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--base") {
			const value = argv[++index];
			if (value === undefined) {
				throw new Error("--base requires a git ref");
			}
			options.base = value;
		} else if (arg === "--strict-diff") {
			options.strictDiff = true;
		} else if (arg === "--self-test") {
			options.selfTest = true;
		} else if (arg === "--list") {
			options.list = true;
		} else if (arg === "--update-baseline") {
			options.updateBaseline = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--baseline") {
			const value = argv[++index];
			if (value === undefined) {
				throw new Error("--baseline requires a path");
			}
			options.baselinePath = resolve(REPO_ROOT, value);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

// ---------------------------------------------------------------------------
// scanning: file discovery
// ---------------------------------------------------------------------------

/**
 * Collect the test files in scope: `packages/<pkg>/test/**` only.
 * Symlinks are never followed, `node_modules` is never entered.
 */
function collectTestFiles(packagesDir = PACKAGES_DIR) {
	const files = [];
	let packageDirs;
	try {
		packageDirs = readdirSync(packagesDir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of packageDirs) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") {
			continue;
		}
		walkTestDir(join(packagesDir, entry.name, "test"), files);
	}
	return files.sort();
}

function walkTestDir(dir, files) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// `withFileTypes` reports symlinks as symlinks, so this never follows one.
		if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.startsWith(".")) {
			continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkTestDir(full, files);
			continue;
		}
		if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) {
			files.push(full);
		}
	}
}

// ---------------------------------------------------------------------------
// scanning: source masking
// ---------------------------------------------------------------------------

/**
 * Blank out comments while preserving every offset and newline, so line numbers computed on the
 * masked copy match the original file. String literals are preserved on purpose: the
 * `vi.spyOn(target, "_member")` rule has to see the quoted member name.
 */
function maskComments(source) {
	const out = source.split("");
	let index = 0;
	const blank = (from, to) => {
		for (let cursor = from; cursor < to; cursor++) {
			if (out[cursor] !== "\n") {
				out[cursor] = " ";
			}
		}
	};
	while (index < source.length) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipString(source, index) + 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			let end = source.indexOf("\n", index);
			if (end === -1) {
				end = source.length;
			}
			blank(index, end);
			index = end;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			let end = source.indexOf("*/", index + 2);
			end = end === -1 ? source.length : end + 2;
			blank(index, end);
			index = end;
			continue;
		}
		index++;
	}
	return out.join("");
}

/** Returns the index of the closing quote of the string literal that starts at `start`. */
function skipString(source, start) {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) {
			return index;
		}
		if (quote === "`" && char === "$" && source[index + 1] === "{") {
			const close = matchBracket(source, index + 1);
			index = close === -1 ? index + 2 : close + 1;
			continue;
		}
		index++;
	}
	return source.length - 1;
}

/** Returns the index of the bracket closing the one at `openIndex`, or -1. */
function matchBracket(source, openIndex) {
	const open = source[openIndex];
	const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : null;
	if (close === null) {
		return -1;
	}
	let depth = 0;
	for (let index = openIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipString(source, index);
			continue;
		}
		if (char === open) {
			depth++;
		} else if (char === close) {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

// ---------------------------------------------------------------------------
// scanning: rules
// ---------------------------------------------------------------------------

const PRIVATE_MEMBER_RE = /(?:^|[\s{;,])_[A-Za-z0-9$]+\s*\??\s*[:;(]/;
const CAST_HEAD_RE = /as\s+unknown\s+as\s+/g;
const SPY_HEAD_RE = /(^|[^A-Za-z0-9_$])spyOn\s*\(/g;
const IDENTIFIER_RE = /^[A-Za-z0-9_$]+/;
const DECLARATION_START_RE = /^(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_$]+)/;

function lineIndexOf(source, offset) {
	let line = 1;
	for (let index = 0; index < offset && index < source.length; index++) {
		if (source[index] === "\n") {
			line++;
		}
	}
	return line;
}

function normalize(text) {
	return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Map every same-file `type X = { ... }` / `interface X { ... }` declaration to whether its body
 * declares a `_`-prefixed member. Union/intersection aliases are not resolved (documented gap).
 */
function collectShadowAliases(masked) {
	const aliases = new Map();
	const lines = masked.split("\n");
	let offset = 0;
	for (const line of lines) {
		const match = DECLARATION_START_RE.exec(line.trimStart());
		if (match) {
			const name = match[1];
			const brace = masked.indexOf("{", offset + line.indexOf(match[0]));
			if (brace !== -1) {
				const close = matchBracket(masked, brace);
				if (close !== -1) {
					aliases.set(name, PRIVATE_MEMBER_RE.test(masked.slice(brace, close + 1)));
				}
			}
		}
		offset += line.length + 1;
	}
	return aliases;
}

function hasSuppression(rawLines, line) {
	const candidates = [rawLines[line - 1], rawLines[line - 2]];
	for (const candidate of candidates) {
		if (candidate === undefined) {
			continue;
		}
		const at = candidate.indexOf(ALLOW_MARKER);
		if (at === -1) {
			continue;
		}
		if (candidate.slice(at + ALLOW_MARKER.length).trim().length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Find every private-member probe in one file.
 * Returns violations with 1-based line numbers, rule ids, fingerprints and the matched text.
 */
function scanSource(rawSource, relPath) {
	const masked = maskComments(rawSource);
	const rawLines = rawSource.split("\n");
	const aliases = collectShadowAliases(masked);
	const violations = [];

	const push = (rule, startOffset, endOffset, memberHint) => {
		const text = rawSource.slice(startOffset, endOffset);
		const line = lineIndexOf(rawSource, startOffset);
		const suppressed = hasSuppression(rawLines, line);
		violations.push({
			file: relPath,
			line,
			rule,
			text: normalize(text),
			fingerprint: normalize(text),
			member: memberHint,
			suppressed,
		});
	};

	// rule 1 + 2: `as unknown as { _foo: ... }` and `as unknown as <ShadowAlias>`
	CAST_HEAD_RE.lastIndex = 0;
	for (let match = CAST_HEAD_RE.exec(masked); match !== null; match = CAST_HEAD_RE.exec(masked)) {
		const after = match.index + match[0].length;
		if (masked[after] === "{") {
			const close = matchBracket(masked, after);
			if (close === -1) {
				continue;
			}
			const body = masked.slice(after, close + 1);
			const member = PRIVATE_MEMBER_RE.exec(body);
			if (member) {
				push(RULE_PRIVATE_CAST, match.index, close + 1, member[0].replace(/[\s:;(]/g, ""));
			}
			continue;
		}
		const identifier = IDENTIFIER_RE.exec(masked.slice(after, after + 200));
		if (identifier && aliases.get(identifier[0]) === true) {
			push(
				RULE_PRIVATE_CAST_ALIAS,
				match.index,
				after + identifier[0].length,
				identifier[0],
			);
		}
	}

	// rule 3: `vi.spyOn(target, "_member")` (also wrapped `vi\n.spyOn(` and a bare imported `spyOn(`)
	SPY_HEAD_RE.lastIndex = 0;
	for (let match = SPY_HEAD_RE.exec(masked); match !== null; match = SPY_HEAD_RE.exec(masked)) {
		const open = masked.indexOf("(", match.index + match[0].length - 1);
		if (open === -1) {
			continue;
		}
		const close = matchBracket(masked, open);
		if (close === -1) {
			continue;
		}
		const args = splitTopLevel(masked.slice(open + 1, close));
		const second = args[1]?.trim();
		if (second === undefined) {
			continue;
		}
		const quote = second[0];
		if ((quote === '"' || quote === "'" || quote === "`") && second[1] === "_") {
			push(RULE_PRIVATE_SPY, match.index + match[1].length, close + 1, second.slice(0, 40));
		}
	}

	return violations;
}

/** Split on commas that are not nested inside brackets or strings. */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipString(text, index);
			continue;
		}
		if (char === "{" || char === "(" || char === "[") {
			depth++;
		} else if (char === "}" || char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function scanFiles(files) {
	const violations = [];
	for (const file of files) {
		const relPath = relative(REPO_ROOT, file).split("\\").join("/");
		let source;
		try {
			source = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		violations.push(...scanSource(source, relPath));
	}
	return violations;
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

function baselineFromViolations(violations) {
	const files = {};
	for (const violation of violations) {
		if (violation.suppressed) {
			continue;
		}
		const perFile = (files[violation.file] ??= {});
		const perRule = (perFile[violation.rule] ??= {});
		perRule[violation.fingerprint] = (perRule[violation.fingerprint] ?? 0) + 1;
	}
	for (const file of Object.keys(files)) {
		for (const rule of Object.keys(files[file])) {
			const fingerprints = files[file][rule];
			for (const key of Object.keys(fingerprints).sort()) {
				const value = fingerprints[key];
				delete fingerprints[key];
				fingerprints[key] = value;
			}
		}
	}
	return {
		$comment:
			"Frozen stock of private-member probes in packages/*/test/**. Generated by scripts/check-test-private-probes.mjs --update-baseline. Do not edit by hand: a new probe must be removed from the test, not added here.",
		rules: RULES,
		files: Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file]])),
	};
}

function loadBaseline(path) {
	if (!existsSync(path)) {
		return { present: false, files: {} };
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	return { present: true, files: parsed.files ?? {}, raw: parsed };
}

/**
 * Decide the gate outcome. Pure function so --self-test can exercise it without touching git.
 *
 * frozen     : baseline files map
 * violations : current scan (each with file/rule/fingerprint/suppressed)
 * addedLines : Map<file, Set<line>> of diff-added lines (may be empty)
 */
function evaluate(violations, frozen, addedLines, options = {}) {
	const counts = new Map();
	for (const file of Object.keys(frozen)) {
		for (const rule of Object.keys(frozen[file])) {
			for (const fingerprint of Object.keys(frozen[file][rule])) {
				counts.set(key(file, rule, fingerprint), frozen[file][rule][fingerprint]);
			}
		}
	}
	const seen = new Map();
	const failing = [];
	const frozenHits = [];
	const suppressed = [];
	const strictDiffHits = [];
	for (const violation of violations) {
		if (violation.suppressed) {
			suppressed.push(violation);
			continue;
		}
		const id = key(violation.file, violation.rule, violation.fingerprint);
		const occurrence = (seen.get(id) ?? 0) + 1;
		seen.set(id, occurrence);
		const frozenCount = counts.get(id) ?? 0;
		const onAddedLine = (addedLines.get(violation.file) ?? new Set()).has(violation.line);
		if (occurrence <= frozenCount) {
			frozenHits.push({ ...violation, onAddedLine });
			if (onAddedLine && options.strictDiff) {
				strictDiffHits.push({ ...violation, onAddedLine });
			}
			continue;
		}
		failing.push({ ...violation, onAddedLine, frozenCopies: frozenCount });
	}
	const stale = [];
	for (const [id, count] of counts) {
		if ((seen.get(id) ?? 0) < count) {
			stale.push({ id, frozen: count, now: seen.get(id) ?? 0 });
		}
	}
	return { failing, frozenHits, suppressed, strictDiffHits, stale };
}

const key = (file, rule, fingerprint) => `${file}\u0000${rule}\u0000${fingerprint}`;

// ---------------------------------------------------------------------------
// diff scoping
// ---------------------------------------------------------------------------

function resolveBaseRef(base) {
	if (!base || /^0+$/.test(base)) {
		return undefined;
	}
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
	return base;
}

/** Map<relative file, Set<added line numbers>> from `git diff --unified=0 base...HEAD`. */
function addedLinesFor(base) {
	const added = new Map();
	let output;
	try {
		output = execFileSync("git", ["diff", "--unified=0", "--no-color", `${base}...HEAD`, "--", "packages"], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			maxBuffer: 256 * 1024 * 1024,
		});
	} catch (error) {
		return { added, error: error instanceof Error ? error.message : String(error) };
	}
	let current;
	for (const line of output.split("\n")) {
		if (line.startsWith("+++ b/")) {
			current = line.slice("+++ b/".length);
			continue;
		}
		if (line.startsWith("@@") && current) {
			const match = /\+(\d+)(?:,(\d+))?/.exec(line);
			if (!match) {
				continue;
			}
			const start = Number(match[1]);
			const count = match[2] === undefined ? 1 : Number(match[2]);
			if (count === 0) {
				continue;
			}
			const set = added.get(current) ?? new Set();
			for (let lineNumber = start; lineNumber < start + count; lineNumber++) {
				set.add(lineNumber);
			}
			added.set(current, set);
		}
	}
	return { added, error: undefined };
}

// ---------------------------------------------------------------------------
// self-test: scanner controls and decision controls
// ---------------------------------------------------------------------------

const SCANNER_CONTROLS = [
	{
		name: "inline cast to a private member",
		expect: [{ rule: RULE_PRIVATE_CAST, line: 1 }],
		source: 'const internals = session as unknown as { _planRefine(options: unknown): Promise<unknown> };\n',
	},
	{
		name: "multi-line cast to a private member",
		// the violation is reported at the line the cast starts on, not the line the member sits on
		expect: [{ rule: RULE_PRIVATE_CAST, line: 1 }],
		source:
			"const internals = session as unknown as {\n\t_drainPendingRefinementForDisposal: () => Promise<void>;\n};\n",
	},
	{
		name: "optional private member",
		expect: [{ rule: RULE_PRIVATE_CAST, line: 1 }],
		source: 'const state = session as unknown as { _autonomousState?: { running: boolean } };\n',
	},
	{
		name: "cast to a same-file shadow alias",
		expect: [{ rule: RULE_PRIVATE_CAST_ALIAS, line: 2 }],
		source:
			"type SupervisorInternals = { _pendingFlush: number };\nconst internals = supervisor as unknown as SupervisorInternals;\n",
	},
	{
		name: "cast to a same-file shadow interface",
		expect: [{ rule: RULE_PRIVATE_CAST_ALIAS, line: 4 }],
		source:
			"interface ReplInternals {\n\t_shutdown(): Promise<void>;\n}\nconst internals = manager as unknown as ReplInternals;\n",
	},
	{
		name: "vi.spyOn with a private member",
		expect: [{ rule: RULE_PRIVATE_SPY, line: 1 }],
		source: 'vi.spyOn(session, "_planRefine").mockResolvedValue({ refined: false });\n',
	},
	{
		name: "wrapped vi.spyOn whose target is itself a private cast",
		expect: [
			{ rule: RULE_PRIVATE_CAST, line: 2 },
			{ rule: RULE_PRIVATE_SPY, line: 2 },
		],
		source:
			"const spy = vi\n\t.spyOn(root as unknown as { _scheduleSessionInputPump(): void }, \"_scheduleSessionInputPump\")\n\t.mockReturnValue();\n",
	},
	{
		name: "cast head split across lines and tabs",
		expect: [{ rule: RULE_PRIVATE_CAST, line: 1 }],
		source: "const internals = session as\n\tunknown as\n\t{ _oddWhitespace(): void };\n",
	},
	{
		name: "spyOn call split across lines",
		expect: [{ rule: RULE_PRIVATE_SPY, line: 1 }],
		source: 'vi.spyOn(\n\tsession,\n\t"_splitAcrossLines",\n).mockResolvedValue(undefined);\n',
	},
	{
		name: "bare imported spyOn with single quotes",
		expect: [{ rule: RULE_PRIVATE_SPY, line: 1 }],
		source: "spyOn(internals, '_applyRefine').mockResolvedValue(undefined);\n",
	},
	{
		name: "spyOn target containing a nested call",
		expect: [{ rule: RULE_PRIVATE_SPY, line: 1 }],
		source: 'vi.spyOn(getSession(1, 2), "_runAutoCompaction").mockResolvedValue(undefined);\n',
	},
];

const SCANNER_NEGATIVE_CONTROLS = [
	{
		name: "cast to a public shape is not a probe",
		source: 'const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;\n',
	},
	{
		name: "cast to an unrelated public alias is not a probe",
		source: "type PublicView = { label: string };\nconst view = node as unknown as PublicView;\n",
	},
	{
		name: "spyOn on a public member is not a probe",
		source: 'vi.spyOn(session, "prompt").mockResolvedValue(undefined);\n',
	},
	{
		name: "shadow alias declared but never cast to is not a probe",
		source: "type UnusedInternals = { _pending: number };\nconst value = 1;\n",
	},
	{
		name: "pattern inside a comment is not a probe",
		source: '// do not write `as unknown as { _foo: number }` or vi.spyOn(x, "_foo")` in new tests\nconst value = 1;\n',
	},
	{
		name: "an underscore that is not a leading member is not a probe",
		source: 'const value = session as unknown as { publicMember: { nested_value: string } };\n',
	},
	{
		name: "suppression with a reason is honoured",
		source:
			'// test-hygiene-allow: frozen stock, tracked by the shadow-type removal task\nvi.spyOn(session, "_planRefine").mockResolvedValue(undefined);\n',
		expectSuppressed: 1,
	},
	{
		name: "suppression without a reason is not honoured",
		source: '// test-hygiene-allow:\nvi.spyOn(session, "_planRefine").mockResolvedValue(undefined);\n',
		expectViolations: 1,
	},
];

const DECISION_CONTROLS = [
	{
		name: "a new probe in a new file fails",
		violations: [
			{ file: "packages/ai/test/new.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: {},
		expectFailing: 1,
	},
	{
		name: "a probe frozen for that file passes",
		violations: [
			{ file: "packages/ai/test/old.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		expectFailing: 0,
	},
	{
		name: "the same fingerprint frozen for another file does not cover a new file",
		violations: [
			{ file: "packages/ai/test/other.test.ts", line: 4, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		expectFailing: 1,
		// the frozen entry for old.test.ts is not seen by this scan, so it is reported as stale
		expectStale: 1,
	},
	{
		name: "an extra copy beyond the frozen count fails",
		violations: [
			{ file: "packages/ai/test/old.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
			{ file: "packages/ai/test/old.test.ts", line: 20, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		expectFailing: 1,
	},
	{
		name: "a frozen probe re-added on a changed line passes by default",
		violations: [
			{ file: "packages/ai/test/old.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		addedLines: { "packages/ai/test/old.test.ts": [10] },
		expectFailing: 0,
	},
	{
		name: "the same frozen probe fails under --strict-diff",
		violations: [
			{ file: "packages/ai/test/old.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "F", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		addedLines: { "packages/ai/test/old.test.ts": [10] },
		options: { strictDiff: true },
		expectFailing: 0,
		expectStrictDiffHits: 1,
	},
	{
		name: "a new probe on a changed line fails",
		violations: [
			{ file: "packages/ai/test/old.test.ts", line: 10, rule: RULE_PRIVATE_SPY, fingerprint: "G", suppressed: false },
		],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 1 } } },
		addedLines: { "packages/ai/test/old.test.ts": [10] },
		expectFailing: 1,
		expectStale: 1,
	},
	{
		name: "a suppressed probe never fails",
		violations: [
			{ file: "packages/ai/test/new.test.ts", line: 3, rule: RULE_PRIVATE_CAST, fingerprint: "H", suppressed: true },
		],
		frozen: {},
		expectFailing: 0,
		expectSuppressed: 1,
	},
	{
		name: "a cleaned-up probe is reported as a stale baseline entry",
		violations: [],
		frozen: { "packages/ai/test/old.test.ts": { [RULE_PRIVATE_SPY]: { F: 2 } } },
		expectFailing: 0,
		expectStale: 1,
	},
];

// ---------------------------------------------------------------------------
// self-test stage C: end-to-end controls in a throwaway git repository
// ---------------------------------------------------------------------------

const SCRATCH_CLEAN = 'import { expect, it } from "vitest";\n\nit("clean", () => {\n\texpect(1).toBe(1);\n});\n';
const SCRATCH_FROZEN = [
	'import { expect, it, vi } from "vitest";',
	"",
	'it("frozen probes", () => {',
	"\tconst internals = {} as unknown as { _planRefine(): void };",
	'\tvi.spyOn(internals, "_planRefine");',
	"\texpect(1).toBe(1);",
	"});",
	"",
].join("\n");
const SCRATCH_FROZEN_MOVED = [
	'import { expect, it, vi } from "vitest";',
	"",
	'it("frozen probes moved to other lines", () => {',
	"\texpect(1).toBe(1);",
	"\tconst internals = {} as unknown as { _planRefine(): void };",
	'\tvi.spyOn(internals, "_planRefine");',
	"});",
	"",
].join("\n");
const SCRATCH_IMPLANT = [
	'import { vi } from "vitest";',
	"",
	"type ImplantedInternals = { _hidden(): void };",
	"",
	"const aliased = {} as unknown as ImplantedInternals;",
	"const inline = {} as unknown as {",
	"\t_alsoHidden: number;",
	"};",
	'vi.spyOn(aliased, "_hidden");',
	"export const keep = [aliased, inline];",
	"",
].join("\n");
const SCRATCH_LEAK = [
	'import { vi } from "vitest";',
	"",
	"const leaked = {} as unknown as { _neverScanned(): void };",
	'vi.spyOn(leaked, "_neverScanned");',
	"export const keep = leaked;",
	"",
].join("\n");

/**
 * Build a throwaway git repository containing a copy of this script, so the controls below drive
 * the real entry point (argument parsing, file walk, git diff plumbing, exit codes) instead of a
 * re-implementation of it.
 */
function createScratchRepo(selfPath) {
	const root = mkdtempSync(join(tmpdir(), "test-hygiene-selftest-"));
	const git = (args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.email=self-test@example.com",
				"-c",
				"user.name=test-hygiene-self-test",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
		);
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "packages", "demo", "test"), { recursive: true });
	copyFileSync(selfPath, join(root, "scripts", "check.mjs"));

	const write = (rel, text) => {
		const target = join(root, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text, "utf-8");
	};
	const gate = (...args) => {
		try {
			const stdout = execFileSync(
				process.execPath,
				[join(root, "scripts", "check.mjs"), "--baseline", "scripts/baseline.json", ...args],
				{ cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
			);
			return { code: 0, output: stdout };
		} catch (error) {
			return {
				code: typeof error.status === "number" ? error.status : 1,
				output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
			};
		}
	};
	const commit = (message) => {
		git(["add", "-A"]);
		git(["commit", "-q", "--allow-empty", "-m", message]);
		return git(["rev-parse", "HEAD"]).trim();
	};
	git(["-c", "init.defaultBranch=main", "init", "-q"]);
	return { root, write, gate, commit, dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

function runEndToEndControls(selfPath) {
	const failures = [];
	let controls = 0;
	const check = (name, ok, detail) => {
		controls++;
		if (!ok) {
			failures.push(`end-to-end control "${name}": ${String(detail).replace(/\n/g, " | ").slice(0, 400)}`);
		}
		return ok;
	};

	const scratch = createScratchRepo(selfPath);
	try {
		scratch.write("packages/demo/test/clean.test.ts", SCRATCH_CLEAN);
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_FROZEN);
		const freeze = scratch.gate("--update-baseline");
		check("scratch baseline freeze", freeze.code === 0 && /baseline written/.test(freeze.output), freeze.output);
		const base = scratch.commit("freeze baseline");
		const atFreeze = scratch.gate("--base", base);
		check(
			"green at the freeze point while frozen stock is present",
			atFreeze.code === 0 && /frozen by baseline: 2/.test(atFreeze.output),
			atFreeze.output,
		);

		// plant violating test files, the way a lane would, and require red
		scratch.write("packages/demo/test/implanted.test.ts", SCRATCH_IMPLANT);
		scratch.commit("implant probes");
		const implanted = scratch.gate("--base", base);
		check("implanted probes turn the gate red", implanted.code === 1, implanted.output);
		for (const rule of RULES) {
			check(`implanted probes report ${rule}`, implanted.output.includes(rule), implanted.output);
		}
		check(
			"implanted probes are labelled as changed lines",
			(implanted.output.match(/\(changed line\)/g) ?? []).length === RULES.length,
			implanted.output,
		);
		const withoutBase = scratch.gate();
		check("implanted probes also fail in baseline-only mode", withoutBase.code === 1, withoutBase.output);

		execFileSync("rm", ["-f", join(scratch.root, "packages/demo/test/implanted.test.ts")]);
		scratch.commit("remove implant");
		check("removing the implant turns the gate green again", scratch.gate("--base", base).code === 0, scratch.gate("--base", base).output);

		// a new probe in a file that used to be clean
		scratch.write("packages/demo/test/clean.test.ts", `${SCRATCH_CLEAN}\nvi.spyOn({} as never, "_sneaky");\n`);
		scratch.commit("sneaky probe");
		const sneaky = scratch.gate("--base", base);
		check("a new probe in a previously clean file fails", sneaky.code === 1 && sneaky.output.includes("_sneaky"), sneaky.output);
		scratch.write("packages/demo/test/clean.test.ts", SCRATCH_CLEAN);
		scratch.commit("revert sneaky probe");

		// a second copy of an already frozen probe
		scratch.write(
			"packages/demo/test/frozen.test.ts",
			`${SCRATCH_FROZEN}\nexport const extra = (internals: never) => vi.spyOn(internals, "_planRefine");\n`,
		);
		scratch.commit("duplicate frozen probe");
		const duplicated = scratch.gate("--base", base);
		check("an extra copy beyond the frozen count fails", duplicated.code === 1 && duplicated.output.includes("private-spyon"), duplicated.output);
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_FROZEN);
		scratch.commit("revert duplicate");

		// Moving identical probe lines: a line-based diff keeps them in the longest common
		// subsequence, so they are not "added lines" and neither mode fails. Recorded here so the
		// limitation is a tested fact rather than a surprise.
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_FROZEN_MOVED);
		scratch.commit("move frozen probes");
		const moved = scratch.gate("--base", base);
		check("moving a frozen probe passes by default", moved.code === 0, moved.output);
		const movedStrict = scratch.gate("--base", base, "--strict-diff");
		check(
			"moving a byte-identical frozen probe also passes --strict-diff (line diffs cannot see a pure move)",
			movedStrict.code === 0,
			movedStrict.output,
		);
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_FROZEN);
		scratch.commit("revert move");

		// Editing a line that carries a frozen probe: the probe text (and therefore its fingerprint)
		// is unchanged, but the line is now a changed line, which is what --strict-diff is for.
		scratch.write(
			"packages/demo/test/frozen.test.ts",
			SCRATCH_FROZEN.replace('\tvi.spyOn(internals, "_planRefine");', '\tvi.spyOn(internals, "_planRefine"); // edited line'),
		);
		scratch.commit("edit a line carrying a frozen probe");
		const editedFrozen = scratch.gate("--base", base);
		check("editing a line that carries a frozen probe passes by default", editedFrozen.code === 0, editedFrozen.output);
		const editedFrozenStrict = scratch.gate("--base", base, "--strict-diff");
		check(
			"the same edited line fails under --strict-diff",
			editedFrozenStrict.code === 1 && /changed line/.test(editedFrozenStrict.output),
			editedFrozenStrict.output,
		);
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_FROZEN);
		scratch.commit("revert edited line");

		// scope traps: an absolute symlink and a nested node_modules tree must never be scanned
		scratch.write("outside/leak.test.ts", SCRATCH_LEAK);
		const leakSource = readFileSync(join(scratch.root, "outside", "leak.test.ts"), "utf-8");
		check(
			"the out-of-scope leak fixture really contains probes",
			scanSource(leakSource, "outside/leak.test.ts").length >= 2,
			scanSource(leakSource, "outside/leak.test.ts"),
		);
		symlinkSync(join(scratch.root, "outside", "leak.test.ts"), join(scratch.root, "packages", "demo", "test", "linked.test.ts"));
		scratch.write("packages/demo/test/node_modules/dep/leak.test.ts", SCRATCH_LEAK);
		scratch.commit("scope traps");
		const scoped = scratch.gate("--base", base);
		check("symlinks and node_modules are never followed", scoped.code === 0, scoped.output);
		check("the scan still reports exactly the two in-scope files", /scanned 2 files/.test(scoped.output), scoped.output);

		// base-ref handling
		const deadBase = scratch.gate("--base", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
		check("an unresolvable base falls back to baseline-only mode", deadBase.code === 0 && /does not resolve/.test(deadBase.output), deadBase.output);
		const zeroBase = scratch.gate("--base", "0".repeat(40));
		check("an all-zero base (first push of a branch) falls back", zeroBase.code === 0 && /does not resolve/.test(zeroBase.output), zeroBase.output);

		// cleaning probes up must not fail, and must surface the stale baseline entries
		scratch.write("packages/demo/test/frozen.test.ts", SCRATCH_CLEAN);
		scratch.commit("clean up probes");
		const cleaned = scratch.gate("--base", base);
		check(
			"removing frozen probes stays green and reports stale baseline entries",
			cleaned.code === 0 && /stale baseline entries/.test(cleaned.output),
			cleaned.output,
		);

		// suppression marker
		scratch.write(
			"packages/demo/test/frozen.test.ts",
			'import { vi } from "vitest";\n\n// test-hygiene-allow: frozen stock, tracked by the seam task\nvi.spyOn({} as never, "_documented");\n',
		);
		scratch.commit("documented suppression");
		const allowed = scratch.gate("--base", base);
		check(
			"a suppression with a reason passes and is counted",
			allowed.code === 0 && /suppressed by test-hygiene-allow: 1/.test(allowed.output),
			allowed.output,
		);
		scratch.write(
			"packages/demo/test/frozen.test.ts",
			'import { vi } from "vitest";\n\n// test-hygiene-allow:\nvi.spyOn({} as never, "_undocumented");\n',
		);
		scratch.commit("undocumented suppression");
		const notAllowed = scratch.gate("--base", base);
		check("a suppression without a reason does not pass", notAllowed.code === 1 && notAllowed.output.includes("_undocumented"), notAllowed.output);
	} finally {
		scratch.dispose();
	}
	return { failures, controls };
}

function runSelfTest() {
	const failures = [];

	for (const control of SCANNER_CONTROLS) {
		const found = scanSource(control.source, "self-test.test.ts").filter((violation) => !violation.suppressed);
		for (const expected of control.expect) {
			const hit = found.some(
				(violation) => violation.rule === expected.rule && violation.line === expected.line,
			);
			if (!hit) {
				failures.push(
					`positive control "${control.name}": expected ${expected.rule} at line ${expected.line}, found ` +
						JSON.stringify(found.map((violation) => [violation.rule, violation.line])),
				);
			}
		}
	}

	for (const control of SCANNER_NEGATIVE_CONTROLS) {
		const found = scanSource(control.source, "self-test.test.ts");
		const unexpected = found.filter((violation) => !violation.suppressed);
		const expectedCount = control.expectViolations ?? 0;
		if (unexpected.length !== expectedCount) {
			failures.push(
				`negative control "${control.name}": expected ${expectedCount} violations, found ` +
					JSON.stringify(unexpected.map((violation) => [violation.rule, violation.line, violation.text])),
			);
		}
		const suppressedFound = found.filter((violation) => violation.suppressed).length;
		if (suppressedFound !== (control.expectSuppressed ?? 0)) {
			failures.push(
				`negative control "${control.name}": expected ${control.expectSuppressed ?? 0} suppressed violations, ` +
					`found ${suppressedFound}`,
			);
		}
	}

	for (const control of DECISION_CONTROLS) {
		const addedLines = new Map(
			Object.entries(control.addedLines ?? {}).map(([file, lines]) => [file, new Set(lines)]),
		);
		const result = evaluate(control.violations, control.frozen, addedLines, control.options ?? {});
		const checks = [
			["failing", result.failing.length, control.expectFailing ?? 0],
			["suppressed", result.suppressed.length, control.expectSuppressed ?? 0],
			["stale", result.stale.length, control.expectStale ?? 0],
			["strictDiffHits", result.strictDiffHits.length, control.expectStrictDiffHits ?? 0],
		];
		for (const [label, actual, expected] of checks) {
			if (actual !== expected) {
				failures.push(`decision control "${control.name}": ${label} expected ${expected}, got ${actual}`);
			}
		}
	}

	// The scanner must also see the frozen stock this gate was built for: if the walk or the rules
	// silently stop matching anything, the gate would be vacuously green.
	const liveFiles = collectTestFiles();
	const live = scanFiles(liveFiles);
	if (liveFiles.length === 0) {
		failures.push("self-test: no test files found under packages/*/test (scan scope broken?)");
	}
	if (live.length === 0) {
		failures.push("self-test: zero probes found in the whole stock (rules broken? gate would be vacuous)");
	}

	// Stage C: drive the real entry point against a throwaway git repository, including planting
	// violating test files and asserting the gate goes red. This is the control that catches a
	// silent matcher regression (for example a regex flavor that stops matching whitespace).
	const endToEnd = runEndToEndControls(fileURLToPath(import.meta.url));
	failures.push(...endToEnd.failures);

	return {
		failures,
		stats: {
			files: liveFiles.length,
			violations: live.length,
			endToEndControls: endToEnd.controls,
			endToEndFailures: endToEnd.failures.length,
		},
	};
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function summarize(violations) {
	const byRule = {};
	const byFile = new Map();
	for (const violation of violations) {
		byRule[violation.rule] = (byRule[violation.rule] ?? 0) + 1;
		byFile.set(violation.file, (byFile.get(violation.file) ?? 0) + 1);
	}
	return { byRule, files: byFile.size, total: violations.length };
}

function printViolation(violation) {
	console.log(`  ${violation.file}:${violation.line} [${violation.rule}]${violation.onAddedLine ? " (changed line)" : ""}`);
	console.log(`    ${violation.text}`);
}

function main() {
	const watchdog = setTimeout(() => {
		console.error(`test-hygiene gate: exceeded ${HARD_TIMEOUT_MS}ms, aborting`);
		process.exit(2);
	}, HARD_TIMEOUT_MS);
	watchdog.unref?.();

	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`test-hygiene gate: ${error.message}`);
		console.error("usage: node scripts/check-test-private-probes.mjs [--base <ref>] [--strict-diff] [--self-test] [--list] [--update-baseline] [--json]");
		process.exit(2);
	}

	if (options.selfTest) {
		const { failures, stats } = runSelfTest();
		if (options.json) {
			console.log(JSON.stringify({ ok: failures.length === 0, failures, stats }, null, 2));
		} else {
			console.log(
				`test-hygiene self-test: ${SCANNER_CONTROLS.length} scanner positive controls, ` +
					`${SCANNER_NEGATIVE_CONTROLS.length} scanner negative controls, ` +
					`${DECISION_CONTROLS.length} decision controls, ` +
					`${stats.endToEndControls} end-to-end controls in a throwaway git repo, ` +
					`live scan ${stats.violations} probes in ${stats.files} files`,
			);
			for (const failure of failures) {
				console.log(`  FAIL ${failure}`);
			}
		}
		if (failures.length > 0) {
			process.exit(1);
		}
		console.log("test-hygiene self-test: OK");
		process.exit(0);
	}

	const files = collectTestFiles();
	const violations = scanFiles(files);
	const baseline = loadBaseline(options.baselinePath);

	if (options.updateBaseline) {
		const next = baselineFromViolations(violations);
		writeFileSync(options.baselinePath, `${JSON.stringify(next, null, "\t")}\n`, "utf-8");
		const summary = summarize(violations);
		console.log(
			`test-hygiene baseline written to ${relative(REPO_ROOT, options.baselinePath)}: ` +
				`${summary.total} probes in ${summary.files} files ` +
				`(${RULES.map((rule) => `${rule}=${summary.byRule[rule] ?? 0}`).join(", ")})`,
		);
		process.exit(0);
	}

	let addedLines = new Map();
	let diffNote;
	if (options.base) {
		const resolved = resolveBaseRef(options.base);
		if (resolved === undefined) {
			diffNote = `--base ${options.base} does not resolve to a commit; falling back to baseline-only mode`;
		} else {
			const result = addedLinesFor(resolved);
			addedLines = result.added;
			diffNote = result.error
				? `git diff against ${resolved} failed (${result.error}); falling back to baseline-only mode`
				: `diff scope: ${addedLines.size} changed file(s) under packages/ against ${resolved}`;
		}
	} else {
		diffNote = "no --base given; baseline-only mode (frozen stock ignored, anything else fails)";
	}

	const result = evaluate(violations, baseline.files, addedLines, { strictDiff: options.strictDiff });
	const summary = summarize(violations);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					ok: result.failing.length === 0 && result.strictDiffHits.length === 0,
					baselinePresent: baseline.present,
					diffNote,
					scannedFiles: files.length,
					summary,
					failing: result.failing,
					strictDiffHits: result.strictDiffHits,
					suppressed: result.suppressed,
					frozen: result.frozenHits.length,
					staleBaselineEntries: result.stale,
				},
				null,
				2,
			),
		);
		process.exit(result.failing.length === 0 && result.strictDiffHits.length === 0 ? 0 : 1);
	}

	console.log(
		`test-hygiene gate: scanned ${files.length} files under packages/*/test/**, ` +
			`found ${summary.total} private-member probes ` +
			`(${RULES.map((rule) => `${rule}=${summary.byRule[rule] ?? 0}`).join(", ")})`,
	);
	console.log(`  ${diffNote}`);
	if (!baseline.present) {
		console.log(
			`  WARNING no baseline at ${relative(REPO_ROOT, options.baselinePath)}: every probe counts as new`,
		);
	}
	console.log(`  frozen by baseline: ${result.frozenHits.length}`);
	console.log(`  suppressed by ${ALLOW_MARKER} ${result.suppressed.length}`);
	if (result.stale.length > 0) {
		console.log(
			`  stale baseline entries (probe removed, re-freeze with --update-baseline): ${result.stale.length}`,
		);
	}

	if (options.list) {
		for (const violation of violations) {
			printViolation(violation);
		}
	}

	const blocking = [...result.failing, ...result.strictDiffHits];
	if (blocking.length === 0) {
		console.log("test-hygiene gate: OK (no new private-member probes)");
		process.exit(0);
	}

	console.log("");
	console.log(`NEW private-member probes in tests: ${blocking.length}`);
	for (const violation of blocking) {
		printViolation(violation);
		console.log(`    why: ${RULE_HELP[violation.rule]}`);
	}
	console.log("");
	console.log("Fix the test to use a public seam. If a probe must stay, add");
	console.log(`  // ${ALLOW_MARKER} <reason>`);
	console.log("on the line above it, and re-freeze deliberate stock with");
	console.log("  node scripts/check-test-private-probes.mjs --update-baseline");
	process.exit(1);
}

main();
