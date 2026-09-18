#!/usr/bin/env node
/**
 * Browser smoke check: the browser-facing entry point has to bundle.
 *
 * Why this exists
 * ---------------
 * `scripts/browser-smoke-entry.ts` imports the published package surface (`@earendil-works/pi-ai`)
 * the way a browser bundle does. If that import stops resolving - a rename, a `node:`-only module
 * pulled into the browser graph, an export that moved - the package is broken for every browser
 * consumer, and nothing else in `npm run check` builds for the browser. This gate is one esbuild
 * bundle of that entry: success is exit 0, a bundle that cannot be built writes esbuild's errors to
 * `--error-log` and exits 1.
 *
 * What it does not check
 * ----------------------
 * esbuild does not typecheck, so a type error in the graph still bundles and this gate stays green:
 * `tsgo --noEmit` (which `npm run check` runs before this gate) is the type gate. The self-test
 * holds a control for that blind spot, so it is a tested fact rather than an assumed one.
 *
 * Usage
 * -----
 *   node scripts/check-browser-smoke.mjs
 *   node scripts/check-browser-smoke.mjs --self-test
 *   node scripts/check-browser-smoke.mjs [--entry <path>] [--outfile <path>] [--error-log <path>]
 *
 * Exit codes: 0 = the entry bundled, 1 = it did not (or a self-test mismatch), 2 = usage.
 * The self-test runs the same build path on planted entries, so it needs esbuild - that is, the
 * repository's node_modules - and cannot ride the dependency-free CI test-hygiene job.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const DEFAULT_ENTRY_PATH = "scripts/browser-smoke-entry.ts";
const DEFAULT_OUTPUT_PATH = join(tmpdir(), "pi-browser-smoke.js");
const DEFAULT_ERROR_LOG_PATH = join(tmpdir(), "pi-browser-smoke-errors.log");

class UsageError extends Error {}

function usage() {
	return [
		"usage: check-browser-smoke.mjs [--self-test]",
		"       [--entry <path>] [--outfile <path>] [--error-log <path>]",
		"",
		`  (no phase flag)  bundle ${DEFAULT_ENTRY_PATH} for the browser`,
		"--self-test      plant entries that cannot bundle and require exit 1, then bundle the real",
		"                 entry and require exit 0 (needs node_modules: the same esbuild path runs)",
		"",
		`  --entry, --outfile and --error-log default to ${DEFAULT_ENTRY_PATH},`,
		`  ${DEFAULT_OUTPUT_PATH} and ${DEFAULT_ERROR_LOG_PATH}.`,
		"  The self-test uses them to keep a planted run inside its own temporary directory.",
	].join("\n");
}

/** `--flag value` and `--flag=value` both work. */
function takeValue(argv, index, flag) {
	const inline = argv[index].startsWith(`${flag}=`);
	const value = inline ? argv[index].slice(flag.length + 1) : argv[index + 1];
	if (value === undefined || value === "" || value.startsWith("-")) {
		throw new UsageError(`${flag} needs a path`);
	}
	return { value, index: inline ? index : index + 1 };
}

function parseArgs(argv) {
	const options = {
		selfTest: false,
		entryPath: DEFAULT_ENTRY_PATH,
		outfile: DEFAULT_OUTPUT_PATH,
		errorLogPath: DEFAULT_ERROR_LOG_PATH,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			options.selfTest = true;
			continue;
		}
		let taken;
		if (arg === "--entry" || arg.startsWith("--entry=")) {
			taken = takeValue(argv, index, "--entry");
			options.entryPath = taken.value;
		} else if (arg === "--outfile" || arg.startsWith("--outfile=")) {
			taken = takeValue(argv, index, "--outfile");
			options.outfile = taken.value;
		} else if (arg === "--error-log" || arg.startsWith("--error-log=")) {
			taken = takeValue(argv, index, "--error-log");
			options.errorLogPath = taken.value;
		} else if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		} else if (arg.startsWith("-")) {
			throw new UsageError(`unknown option "${arg}"`);
		} else {
			throw new UsageError(`unexpected argument "${arg}"`);
		}
		index = taken.index;
	}
	return options;
}

/** One bundle attempt. The one path both the gate and its self-test build through. */
async function bundleEntry(entryPath, outfile) {
	try {
		await build({
			entryPoints: [entryPath],
			bundle: true,
			platform: "browser",
			format: "esm",
			logLevel: "silent",
			outfile,
		});
		return { ok: true, error: undefined };
	} catch (error) {
		return { ok: false, error };
	}
}

/** esbuild's error list flattened to `file:line:column <text>` lines, plus the stack. */
function describeBuildError(error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	return [detailedErrors, baseError].filter(Boolean).join("\n\n");
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof UsageError ? error.message : String(error));
		console.error(usage());
		return 2;
	}
	if (options.help) {
		console.log(usage());
		return 0;
	}
	if (options.selfTest) return await runSelfTest(options);

	const result = await bundleEntry(options.entryPath, options.outfile);
	if (result.ok) return 0;

	writeFileSync(options.errorLogPath, describeBuildError(result.error), "utf-8");
	console.error(`Browser smoke check failed. See ${options.errorLogPath}`);
	return 1;
}

// ---------------------------------------------------------------------------
// self-test: planted entries that cannot bundle must turn the gate red
// ---------------------------------------------------------------------------
//
// The controls drive `main`, not `bundleEntry`, so what is proven is the verdict the wiring sees:
// the exit code and the error log. Planted entries live in one temporary directory and the output
// and error log are pointed into it, so a self-test run leaves nothing behind outside the OS temp
// directory and never touches `scripts/browser-smoke-entry.ts` (which it only reads and bundles).
//
// Summary line: `self-test: N controls, M mismatch(es)`.

/** Collect what the gate prints, so the self-test's own report stays readable. */
async function withCapturedOutput(run) {
	const captured = [];
	const log = console.log;
	const error = console.error;
	const record = (...args) => captured.push(args.map((value) => String(value)).join(" "));
	console.log = record;
	console.error = record;
	try {
		const code = await run();
		return { code, output: captured.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

/** What the gate's `--self-test` plants. `source === null` plants nothing (the path stays absent). */
const SELF_TEST_ENTRIES = [
	{
		name: "the real browser smoke entry bundles (green)",
		expectPass: true,
		fileName: null,
		realEntry: true,
	},
	{
		name: "a planted syntax error is red",
		expectPass: false,
		fileName: "planted-syntax-error.ts",
		source: "const broken: = ;\n",
		needle: 'Unexpected "="',
	},
	{
		name: "a planted missing import is red",
		expectPass: false,
		fileName: "planted-missing-import.ts",
		source: 'import { nothing } from "./planted-absent-module.js";\nconsole.log(nothing);\n',
		needle: 'Could not resolve "./planted-absent-module.js"',
	},
	{
		name: "a planted entry that does not exist is red",
		expectPass: false,
		fileName: null,
		source: null,
		needle: "Could not resolve",
	},
	{
		name: "esbuild does not typecheck: a planted type error still bundles (the gate's blind spot)",
		expectPass: true,
		fileName: "planted-type-error.ts",
		source: 'const count: number = "seven";\nconsole.log(count);\n',
	},
];

async function judgeSelfTestEntry(entry, options, dir) {
	const label = entry.realEntry ? "real-entry" : entry.fileName === null ? "planted-absent-entry" : entry.fileName.replace(/\.ts$/, "");
	const entryPath = entry.realEntry ? options.entryPath : join(dir, entry.fileName ?? "planted-absent-entry.ts");
	if (!entry.realEntry && entry.fileName !== null) {
		writeFileSync(entryPath, entry.source, "utf-8");
	}
	const errorLogPath = join(dir, `${label}-errors.log`);
	const { code, output } = await withCapturedOutput(() =>
		main(["--entry", entryPath, "--outfile", join(dir, `${label}.js`), "--error-log", errorLogPath]),
	);

	if (entry.expectPass) {
		const problems = [];
		if (code !== 0) {
			problems.push(`expected exit 0, got exit ${code}: ${[output, readIfPresent(errorLogPath)].filter(Boolean).join(" ")}`);
		}
		if (existsSync(errorLogPath)) {
			problems.push(`a green bundle wrote an error log (${errorLogPath}): ${readIfPresent(errorLogPath)}`);
		}
		return { code, problems };
	}

	const problems = [];
	if (code !== 1) {
		problems.push(`expected exit 1, got exit ${code}: ${output}`);
		return { code, problems };
	}
	if (!output.includes("Browser smoke check failed. See ")) {
		problems.push(`exit 1 without telling the reader where the errors are: ${output}`);
	}
	const log = readIfPresent(errorLogPath, "utf-8");
	if (log === undefined) {
		problems.push(`exit 1 without writing the error log at ${errorLogPath}`);
	} else if (entry.needle !== undefined && !log.includes(entry.needle)) {
		problems.push(`the error log does not say ${JSON.stringify(entry.needle)}: ${log.split("\n")[0]}`);
	}
	return { code, problems };
}

/** Read a file, or `undefined` when it is not there (the file not existing is a verdict of its own). */
function readIfPresent(path, encoding) {
	try {
		return readFileSync(path, encoding);
	} catch {
		return undefined;
	}
}

/** How a path looked at one moment: its content, or "absent". */
function describePath(path) {
	const content = readIfPresent(path, "utf-8");
	return content === undefined ? "absent" : `${content.length} bytes`;
}

/**
 * The state the self-test must leave exactly as it found it: the entry it plants nothing into, and
 * the two shared temp paths the real gate writes. A run of this self-test that edits the entry or
 * writes the shared error log is a red control, not something a reader has to trust.
 */
function selfTestWitness() {
	return Object.fromEntries([DEFAULT_ENTRY_PATH, DEFAULT_OUTPUT_PATH, DEFAULT_ERROR_LOG_PATH].map((path) => [path, describePath(path)]));
}

function witnessProblems(before, after) {
	const problems = [];
	for (const path of Object.keys(before)) {
		if (before[path] !== after[path]) {
			problems.push(`${path} changed during the self-test (${before[path]} -> ${after[path]})`);
		}
	}
	return problems;
}

async function runSelfTest(options) {
	const controls = [...SELF_TEST_ENTRIES];
	const dir = mkdtempSync(join(tmpdir(), "browser-smoke-selftest-"));
	const before = selfTestWitness();
	try {
		const results = [];
		for (const entry of controls) {
			let judged;
			try {
				judged = await judgeSelfTestEntry(entry, options, dir);
			} catch (error) {
				judged = { code: "n/a", problems: [`the control threw: ${error instanceof Error ? error.message : String(error)}`] };
			}
			results.push(judged);
		}

		// The last control judges the run itself: planting entries must not touch the real entry or
		// the temp paths the real gate uses.
		const problems = witnessProblems(before, selfTestWitness());
		controls.push({
			name: "the self-test left the real entry and the shared temp paths alone",
			expectPass: true,
		});
		results.push({ code: "n/a", problems });

		let mismatches = 0;
		for (const [index, control] of controls.entries()) {
			const { code, problems } = results[index];
			const passed = problems.length === 0;
			if (!passed) mismatches += 1;
			console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${control.expectPass ? "green" : "red"}, got exit ${code})`);
			for (const problem of problems) console.log(`       ${problem}`);
		}
		console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
		return mismatches === 0 ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

process.exit(await main(process.argv.slice(2)));
