#!/usr/bin/env node
/**
 * One matrix row out of a GitHub workflow, read rather than copied.
 *
 * `scripts/check-process-smoke.sh` is the local mirror of the CI job "Test (coding-agent process
 * smoke)", and it used to carry the job's floors and tag-skip ledger as a hand copy with a note
 * asking whoever changes one to remember the other. Two copies of the same constants drift
 * silently in both directions: CI raising a floor while the local mirror keeps the old one turns
 * a local green into a CI red (the shape of the 2026-09-18 incident this mirror exists for), and
 * the mirror raising one alone makes the two disagree about what "green" means. This module reads
 * the row out of `.github/workflows/ci.yml` instead, and fails closed when it cannot: a missing
 * file, a missing row, two rows of the same name, or a row with no scalar keys all exit 2, so an
 * unreadable source never reads as "no floors to enforce".
 *
 * Usage:
 *   node scripts/lib/ci-matrix-row.mjs --row "coding-agent process smoke" [--file <path>]
 *   node scripts/lib/ci-matrix-row.mjs --self-test
 *
 * Prints one `<key>\t<value>` line per scalar key of the row (TAB separated, values verbatim so a
 * `tag_skip_ledger` survives intact). Exit codes: 0 = printed, 2 = could not answer.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function parseArgs(argv) {
	const options = { row: "", file: "", selfTest: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--row":
				options.row = argv[++i] ?? "";
				break;
			case "--file":
				options.file = argv[++i] ?? "";
				break;
			case "--self-test":
				options.selfTest = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	return options;
}

const indentOf = (line) => line.length - line.replace(/^[ \t]*/, "").length;

/**
 * The scalar keys of one `- name: <row>` entry inside a `strategy.matrix.include` list.
 * List-valued keys (a `branches:` style block) are skipped rather than guessed at: this reader
 * exists to hand a shell the four scalars the mirror needs, and inventing a value for a key it
 * cannot read is the failure mode it is meant to remove.
 */
export function readMatrixRow(text, rowName) {
	const lines = text.split(/\r?\n/);
	const rows = [];
	let current = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const start = line.match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
		if (start) {
			const name = start[2].replace(/^["']|["']$/g, "");
			current = { name, indent: start[1].length, keys: new Map(), keyIndent: null, line: i + 1 };
			rows.push(current);
			continue;
		}
		if (!current) continue;
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const key = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!key) continue;
		if (key[1].length <= current.indent) {
			// Left this row (back at the list's own indentation): later keys belong to something else.
			current = null;
			continue;
		}
		// The row's keys sit at one indentation; anything deeper is the content of a block value
		// (a nested map or list) and is not a scalar of this row. Without this, `matrix:` followed
		// by an indented `deeper: value` would be read as a key of the row.
		if (current.keyIndent === null) current.keyIndent = key[1].length;
		if (key[1].length !== current.keyIndent) continue;
		const value = key[3].trim();
		if (value === "") continue; // block value: not a scalar this reader reads
		current.keys.set(key[2], value.replace(/^["']|["']$/g, ""));
	}
	const matches = rows.filter((row) => row.name === rowName);
	if (matches.length === 0) throw new Error(`no matrix row named "${rowName}"`);
	if (matches.length > 1) throw new Error(`${matches.length} matrix rows named "${rowName}" (want exactly one)`);
	if (matches[0].keys.size === 0) throw new Error(`matrix row "${rowName}" (line ${matches[0].line}) has no scalar keys`);
	return matches[0].keys;
}

function defaultWorkflowPath() {
	return resolve(HERE, "..", "..", ".github", "workflows", "ci.yml");
}

function printRow(rowName, file) {
	const text = readFileSync(file, "utf8");
	const keys = readMatrixRow(text, rowName);
	for (const [key, value] of keys) process.stdout.write(`${key}\t${value}\n`);
}

function selfTest() {
	const dir = mkdtempSync(join(tmpdir(), "ci-matrix-row-selftest."));
	let controls = 0;
	let mismatches = 0;
	const check = (name, fn) => {
		controls += 1;
		try {
			const problem = fn();
			if (problem) throw new Error(problem);
			console.log(`ok   ${name}`);
		} catch (error) {
			mismatches += 1;
			console.log(`FAIL ${name}: ${error.message}`);
		}
	};
	const fixture = (name, body) => {
		const path = join(dir, name);
		writeFileSync(path, body, "utf8");
		return path;
	};
	const row = (body) => `jobs:\n  test:\n    strategy:\n      matrix:\n        include:\n${body}`;
	const goodRow = `          - name: coding-agent process smoke\n            package: packages/coding-agent\n            min_tests: 22\n            min_ran_tests: 11\n            tag_skip_ledger: 'a.test.ts=8:why; nightly runs it;;b.test.ts=4:why'\n`;
	const good = fixture("good.yml", row(goodRow));

	try {
		const keys = readMatrixRow(readFileSync(good, "utf8"), "coding-agent process smoke");
		check("a well formed row hands back its scalar keys verbatim", () => {
			if (keys.get("min_tests") !== "22") return `min_tests came back as ${keys.get("min_tests")}`;
			if (keys.get("min_ran_tests") !== "11") return `min_ran_tests came back as ${keys.get("min_ran_tests")}`;
			if (!String(keys.get("tag_skip_ledger")).includes(";;")) return "the ledger lost its entry separator";
			if (keys.get("package") !== "packages/coding-agent") return "a sibling scalar was dropped";
			if (keys.has("deeper")) return "a nested map value was read as a key of the row";
			return "";
		});
	} catch (error) {
		mismatches += 1;
		controls += 1;
		console.log(`FAIL a well formed row hands back its scalar keys verbatim: ${error.message}`);
	}

	check("a value that changed in the file is the value that comes back", () => {
		const changed = fixture("changed.yml", row(goodRow.replace("min_tests: 22", "min_tests: 999")));
		const keys = readMatrixRow(readFileSync(changed, "utf8"), "coding-agent process smoke");
		return keys.get("min_tests") === "999" ? "" : `read ${keys.get("min_tests")} instead of 999`;
	});
	check("a missing row is an error, not an empty answer", () => {
		const missing = fixture("missing.yml", row("          - name: some other job\n            min_tests: 1\n"));
		try {
			readMatrixRow(readFileSync(missing, "utf8"), "coding-agent process smoke");
			return "no error was raised";
		} catch (error) {
			return /no matrix row named/.test(error.message) ? "" : `unexpected error ${error.message}`;
		}
	});
	check("two rows with the same name are an error, not a coin flip", () => {
		const twice = fixture("twice.yml", row(goodRow + goodRow));
		try {
			readMatrixRow(readFileSync(twice, "utf8"), "coding-agent process smoke");
			return "no error was raised";
		} catch (error) {
			return /want exactly one/.test(error.message) ? "" : `unexpected error ${error.message}`;
		}
	});
	check("a row whose keys are all block values is an error, not an empty answer", () => {
		const blocks = fixture("blocks.yml", row("          - name: coding-agent process smoke\n            matrix:\n              deeper: value\n"));
		try {
			readMatrixRow(readFileSync(blocks, "utf8"), "coding-agent process smoke");
			return "no error was raised";
		} catch (error) {
			return /no scalar keys/.test(error.message) ? "" : `unexpected error ${error.message}`;
		}
	});
	check("keys of the row after it do not leak into this row", () => {
		const two = fixture(
			"two.yml",
			row(`          - name: coding-agent process smoke\n            min_tests: 22\n          - name: another job\n            min_tests: 7\n`),
		);
		const keys = readMatrixRow(readFileSync(two, "utf8"), "coding-agent process smoke");
		return keys.get("min_tests") === "22" ? "" : `read ${keys.get("min_tests")}, so the next row's key leaked in`;
	});
	check("the real ci.yml answers for the row the mirror drives", () => {
		const keys = readMatrixRow(readFileSync(defaultWorkflowPath(), "utf8"), "coding-agent process smoke");
		for (const needed of ["min_tests", "min_ran_tests", "max_nothing_files", "tag_skip_ledger"]) {
			if (!keys.has(needed)) return `the real row has no ${needed}`;
		}
		return "";
	});

	rmSync(dir, { recursive: true, force: true });
	console.log(`self-test: ${controls} controls, ${mismatches} mismatch(es)`);
	if (mismatches !== 0) process.exit(1);
}

let options;
try {
	options = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`ci-matrix-row: ${error.message}`);
	process.exit(2);
}

if (options.help) {
	console.log('usage: node scripts/lib/ci-matrix-row.mjs --row "<matrix row name>" [--file <path>]');
	console.log("       node scripts/lib/ci-matrix-row.mjs --self-test");
	process.exit(0);
}

if (options.selfTest) {
	selfTest();
	process.exit(0);
}

if (!options.row) {
	console.error("ci-matrix-row: --row <name> is required");
	process.exit(2);
}

try {
	printRow(options.row, options.file || defaultWorkflowPath());
} catch (error) {
	console.error(`ci-matrix-row: cannot read the "${options.row}" matrix row: ${error.message}`);
	process.exit(2);
}
