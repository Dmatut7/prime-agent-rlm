#!/usr/bin/env node
/**
 * check-browser-smoke.mjs - the gate behind `npm run check:browser-smoke`, which the husky
 * pre-commit hook (`npm run check`) and CI's `build-check` job both run.
 *
 * What it judges
 * --------------
 * One reading, mechanically: `scripts/browser-smoke-entry.ts` - which imports `complete` and
 * `getModel` from `@earendil-works/pi-ai` - must still bundle with esbuild at
 * `platform: "browser"`, `format: "esm"`, `bundle: true`. Resolution goes through the root
 * `tsconfig.json` `paths`, so what is bundled is pi-ai's TypeScript source graph (1,977 modules,
 * ~5 MB of output), not the published `dist`. The drift this catches is therefore "something
 * entered `@earendil-works/pi-ai`'s import graph that a browser bundle cannot resolve" - a Node
 * builtin (`node:fs`, `node:child_process`, ...), a node-only dependency, or a broken entry - and
 * it catches it without starting a browser or opening a socket: esbuild resolves and transpiles,
 * nothing is executed. A red build writes the per-error `file:line:col text` detail plus the raw
 * error to a log and names that log on stderr, because esbuild's own `logLevel: "silent"` would
 * otherwise leave the operator with nothing.
 *
 * Usage
 * -----
 *   node scripts/check-browser-smoke.mjs              # the gate (green exits 0 silently)
 *   node scripts/check-browser-smoke.mjs --self-test  # prove the gate can still go red
 *
 * --self-test contract
 * --------------------
 * Seven controls plus a side-effect reading. The reds are planted for real: throwaway fixtures in
 * `mkdtempSync` are handed to the *same* `runBuild` the gate uses, so a control passes only when
 * that build really fails and its log really names the planted drift. Two green controls keep the
 * reds honest - the shipped entry must still bundle, and a browser-safe fixture written next to
 * the `node:fs` one must still bundle, so "everything is red" (a broken esbuild, an unresolvable
 * workspace) cannot masquerade as detection. The formatter and the failure report are driven by
 * canned esbuild-shaped errors as well, since those shapes (a location-less error, a non-Error
 * throw) cannot be produced by a real bundle on demand.
 * It writes nothing into the checkout, starts no browser, opens no socket and performs no network
 * I/O; every artifact goes into one throwaway directory that is removed before exit, and the two
 * production paths in `tmpdir()` are verified untouched. Exit codes: 0 = green, 1 = red, 2 = usage.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = join(repoRoot, "scripts", "browser-smoke-entry.ts");
const outputPath = join(tmpdir(), "pi-browser-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");

class UsageError extends Error {}

function parseArgs(argv) {
	const options = { selfTest: false };
	for (const arg of argv) {
		if (arg === "--self-test") options.selfTest = true;
		else if (arg === "-h" || arg === "--help") options.help = true;
		else throw new UsageError(`check-browser-smoke: unknown argument ${arg}`);
	}
	return options;
}

function usage() {
	console.error("usage: node scripts/check-browser-smoke.mjs [--self-test]");
}

/**
 * The gate's build options. `outfile` is a parameter because that is the only thing a self-test
 * control may redirect; entry, platform, format and working directory stay the gate's own.
 */
function buildOptions(outfile, overrides = {}) {
	return {
		entryPoints: [entryPoint],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		absWorkingDir: repoRoot,
		outfile,
		...overrides,
	};
}

/**
 * esbuild's thrown failure -> the text the gate writes to its error log. Pure (no I/O), so a
 * canned error can drive it: a location-less entry formats as its text alone, and a throw that is
 * not an Error formats as its string form.
 */
function formatBuildFailure(error) {
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

/** One build, reported as a value: the gate and every self-test control run this same function. */
async function runBuild(options) {
	try {
		const result = await build(options);
		return { ok: true, warnings: result.warnings };
	} catch (error) {
		return { ok: false, log: formatBuildFailure(error) };
	}
}

/** The operator-facing half of a red gate: write the detail log, return the line printed on stderr. */
function reportFailure(logPath, log) {
	writeFileSync(logPath, log, "utf-8");
	return `Browser smoke check failed. See ${logPath}`;
}

// ---------------------------------------------------------------------------
// self-test: planted bundles must turn the gate red, the shipped one must not
// ---------------------------------------------------------------------------

/** A control's own judgement: run something, return the failures it produced ([] = green). */
async function buildControl(workDir, name, body, outfile, expectation) {
	const entry = join(workDir, name);
	writeFileSync(entry, body, "utf8");
	return evaluateBuild(await runBuild(buildOptions(join(workDir, outfile), { entryPoints: [entry] })), expectation);
}

function evaluateBuild(result, expectation) {
	const failures = [];
	if (expectation.ok && !result.ok) {
		failures.push(`expected a green browser bundle, got a red one:\n${result.log}`);
		return failures;
	}
	if (!expectation.ok && result.ok) failures.push("expected a red browser bundle, got a green one");
	for (const needle of expectation.logNames ?? []) {
		if (result.ok) failures.push(`expected the failure log to name ${JSON.stringify(needle)}, got no failure at all`);
		else if (!result.log.includes(needle)) {
			failures.push(`expected the failure log to name ${JSON.stringify(needle)}, got:\n${result.log}`);
		}
	}
	return failures;
}

/** The formatter, driven by canned esbuild-shaped failures it cannot be made to produce on demand. */
function formatterControls() {
	const failures = [];
	const stack = 'Error: Build failed with 1 error\n    at failureFailure (/x/esbuild/lib/main.js:1:1)';
	const canned = Object.assign(new Error("Build failed with 1 error"), {
		errors: [
			{
				location: { file: "scripts/browser-smoke-entry.ts", line: 1, column: 29 },
				text: 'Could not resolve "node:fs"',
			},
		],
		stack,
	});
	const expect = (actual, wanted, label) => {
		if (actual !== wanted) failures.push(`${label}: expected\n${JSON.stringify(wanted)}\ngot\n${JSON.stringify(actual)}`);
	};
	expect(
		formatBuildFailure(canned),
		`scripts/browser-smoke-entry.ts:1:29 Could not resolve "node:fs"\n\n${stack}`,
		"a located error formats as file:line:col text plus the raw error",
	);
	expect(
		formatBuildFailure(
			Object.assign(new Error("Build failed with 1 error"), {
				errors: [{ location: null, text: "The entry point is missing" }],
				stack: "raw",
			}),
		),
		"The entry point is missing\n\nraw",
		"a location-less error still formats (no undefined:null)",
	);
	// Pinned as-is, not "fixed": a throw that is not an Error stringifies opaquely, and the gate
	// still keeps the actionable part because the detailed errors are formatted first.
	expect(
		formatBuildFailure({ errors: [{ location: null, text: "The entry point is missing" }], stack: "raw" }),
		"The entry point is missing\n\n[object Object]",
		"a plain-object throw keeps its detailed part even though its string form is opaque",
	);
	expect(formatBuildFailure("esbuild exploded"), "esbuild exploded", "a non-Error throw formats as its string form");
	expect(formatBuildFailure(undefined), "undefined", "an undefined throw formats instead of crashing");
	return failures;
}

function selfTestControls(workDir) {
	return [
		{
			name: "the shipped browser-smoke entry still bundles for the browser (green control)",
			run: async () => evaluateBuild(await runBuild(buildOptions(join(workDir, "shipped.js"))), { ok: true }),
		},
		{
			name: "a Node builtin entering the graph reddens the gate and names it (the drift this gate exists for)",
			run: () =>
				buildControl(
					workDir,
					"node-builtin.ts",
					'import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n',
					"node-builtin.js",
					{ ok: false, logNames: ['Could not resolve "node:fs"', "node-builtin.ts:1:"] },
				),
		},
		{
			name: "a browser-safe fixture next to it still bundles (attribution control for the red above)",
			run: () =>
				buildControl(workDir, "browser-safe.ts", "export const answer = 41 + 1;\nconsole.log(answer);\n", "browser-safe.js", {
					ok: true,
				}),
		},
		{
			name: "a syntax error inside the bundled graph reddens the gate",
			run: () =>
				buildControl(workDir, "syntax-error.ts", "export const broken = ;\n", "syntax-error.js", {
					ok: false,
					logNames: ['Unexpected ";"', "syntax-error.ts:1:"],
				}),
		},
		{
			name: "a vanished entry file reddens the gate instead of passing silently",
			run: async () =>
				evaluateBuild(
					await runBuild(buildOptions(join(workDir, "vanished.js"), { entryPoints: [join(workDir, "gone.ts")] })),
					{ ok: false, logNames: ["gone.ts"] },
				),
		},
		{
			name: "the failure formatter reports file:line:col text plus the raw error (canned shapes)",
			run: () => formatterControls(),
		},
		{
			name: "a red build writes its detail log and names it on stderr",
			run: async () => {
				const failures = [];
				const logPath = join(workDir, "planted-errors.log");
				const entry = join(workDir, "report-entry.ts");
				writeFileSync(entry, 'import { spawnSync } from "node:child_process";\nconsole.log(spawnSync);\n', "utf8");
				const result = await runBuild(buildOptions(join(workDir, "report.js"), { entryPoints: [entry] }));
				if (result.ok) {
					failures.push("expected the planted node:child_process entry to be red for this control");
					return failures;
				}
				const line = reportFailure(logPath, result.log);
				if (!existsSync(logPath)) failures.push(`expected the detail log to be written at ${logPath}`);
				else if (!line.endsWith(logPath)) failures.push(`expected the stderr line to name the log path, got: ${line}`);
				else if (line !== `Browser smoke check failed. See ${logPath}`) {
					failures.push(`expected the gate's own failure sentence, got: ${line}`);
				}
				return failures;
			},
		},
	];
}

async function runSelfTest() {
	const workDir = mkdtempSync(join(tmpdir(), "prime-agent-browser-smoke-selftest-"));
	// The production artifacts: the self-test must neither create nor rewrite them.
	const productionArtifacts = [outputPath, errorLogPath].map((path) => [path, fingerprint(path)]);
	const controls = selfTestControls(workDir);
	let mismatches = 0;
	try {
		for (const control of controls) {
			let failures;
			let threw;
			try {
				failures = await control.run();
			} catch (error) {
				threw = error;
			}
			const passed = threw === undefined && failures.length === 0;
			if (!passed) mismatches += 1;
			console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (${threw ? `threw ${threw.message}` : `${failures.length} failure(s)`})`);
			if (!passed && failures) for (const failure of failures) console.log(`       ${failure}`);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	const sideEffectFailures = [];
	if (existsSync(workDir)) sideEffectFailures.push(`the throwaway directory survived: ${workDir}`);
	if (workDir.startsWith(`${repoRoot}/`)) sideEffectFailures.push(`the throwaway directory is inside the checkout: ${workDir}`);
	for (const [path, before] of productionArtifacts) {
		const after = fingerprint(path);
		if (before !== after) sideEffectFailures.push(`a production artifact changed: ${path} (${before} -> ${after})`);
	}
	if (sideEffectFailures.length > 0) mismatches += 1;
	console.log(
		`${sideEffectFailures.length === 0 ? "ok  " : "FAIL"} the self-test is side-effect free (throwaway dir removed, ${
			productionArtifacts.length
		} production artifact(s) untouched)`,
	);
	for (const failure of sideEffectFailures) console.log(`       ${failure}`);

	console.log(`self-test: ${controls.length + 1} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}

/** "absent" or "present at this size and mtime": enough to prove the self-test did not rewrite it. */
function fingerprint(path) {
	try {
		const stats = statSync(path);
		return `size=${stats.size} mtime=${stats.mtimeMs}`;
	} catch {
		return "absent";
	}
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(error.message);
		usage();
		return 2;
	}
	if (options.help) {
		usage();
		return 0;
	}
	if (options.selfTest) {
		const status = await runSelfTest();
		if (status === 0) console.log("check-browser-smoke self-test: OK (the gate still plants its own red)");
		else console.error("check-browser-smoke self-test: RED (a planted drift was not detected, or a green control failed)");
		return status;
	}

	const result = await runBuild(buildOptions(outputPath));
	if (result.ok) return 0;
	console.error(reportFailure(errorLogPath, result.log));
	return 1;
}

process.exit(await main(process.argv.slice(2)));
