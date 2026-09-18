#!/usr/bin/env node
/**
 * Installer render gate: the splash install.sh prints has to fit the terminal it prints into, and
 * its npm invocation has to carry the policy the npm in use requires.
 *
 * Why this exists
 * ---------------
 * install.sh paints a full-screen splash (a logo of fixed height, a lab width frozen on the first
 * frame, a compact mode for small terminals) with raw ANSI and a synchronized-update sequence.
 * None of that is visible to a test runner: the failure mode is a frame that is one row too tall
 * or a logo that reappears after the terminal shrank, and those only show up on a real terminal.
 * This gate therefore sources the installer's own functions into a harness that fakes the terminal
 * size and renders the splash through six size transitions, then asserts the geometry, the
 * synchronized-update close and the indeterminate progress line. It also runs the installer's npm
 * invocation against a fake npm, which fails unless npm >= 12 gets `--allow-remote=all` and
 * `--allow-scripts=<tarball>` and npm < 12 gets neither.
 *
 * Usage
 * -----
 *   node scripts/check-installer.mjs
 *   node scripts/check-installer.mjs --self-test
 *
 * The gate reads `install.sh` from the working directory (the repository root). `--self-test`
 * plants a mutated installer per control into its own temporary directory and runs *this* script
 * there, so each planted defect has to reach the real judgement and the real exit code. Exit
 * codes: 0 = gate green, 1 = gate red (or a self-test mismatch).
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The installer this gate judges, relative to the working directory (the repository root). */
const DEFAULT_INSTALLER_PATH = "install.sh";

/** This script's own path: the self-test drives the real entry point, not a copy of its logic. */
const SELF_PATH = fileURLToPath(import.meta.url);

/** The installer's final entry-point call: the harness stops at it, the gate requires it to exist. */
const MAIN_CALL = '\nmain "$@"';

// `--self-test` runs before the gate body, so it needs no install.sh in its own working directory:
// every control plants one in a throwaway directory and runs this script there.
if (process.argv.includes("--self-test")) {
	process.exit(await runSelfTest());
}

const installerSource = readFileSync(DEFAULT_INSTALLER_PATH, "utf-8");
const mainCallIndex = installerSource.lastIndexOf(MAIN_CALL);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_test_cols=80
prime_agent_test_rows=24

prime_agent_read_terminal_size() {
	prime_agent_screen_cols="$prime_agent_test_cols"
	prime_agent_screen_rows="$prime_agent_test_rows"
}

print_render_meta() {
	label="$1"
	if prime_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(prime_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$prime_agent_screen_cols" "$prime_agent_screen_rows" "$prime_agent_screen_layout_show_logo" \\
		"$prime_agent_screen_layout_lab_width" "$prime_agent_screen_render_lab_width" "$prime_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	prime_agent_screen_title="Installing Prime Agent"
	prime_agent_screen_detail="Fetching the verified package."
	prime_agent_screen_question=
	prime_agent_screen_frame=1
	prime_agent_screen_cols="$1"
	prime_agent_screen_rows="$2"
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ first\\n'

	prime_agent_screen_frame=2
	prime_agent_screen_cols="$3"
	prime_agent_screen_rows="$4"
	prime_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	prime_agent_screen_enabled=1
	prime_agent_screen_drawn=0
	prime_agent_screen_last_cols=0
	prime_agent_screen_last_rows=0
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_screen_frame=0

	prime_agent_test_cols="$1"
	prime_agent_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	prime_agent_test_cols="$3"
	prime_agent_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		prime_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(prime_agent_animation_status "Installing Prime Agent" "$progress_details" static)" "$(prime_agent_animation_detail "$progress_details")"
	done
}

render_case "$@"
screen_case "$@"
progress_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");

	checkNpmInstallPolicies();
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer check passed.");

function checkNpmInstallPolicies() {
	const binDir = join(tempDir, "bin");
	const installHarnessPath = join(tempDir, "install-harness.sh");
	const npmPath = join(binDir, "npm");
	const tarballPath = join(tempDir, "verified release package.tgz");
	const installHarnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_npm_install "$1"
`;
	const npmSource = `#!/bin/sh
set -eu

if [ "\${1:-}" = "--version" ]; then
	printf '%s\\n' "$FAKE_NPM_VERSION"
	exit 0
fi
[ "\${1:-}" = install ] || exit 1

remote_policy=
script_policy=
target=
for arg in "$@"; do
	case "$arg" in
		--allow-remote=*) remote_policy=\${arg#*=} ;;
		--allow-scripts=*) script_policy=\${arg#*=} ;;
		"$FAKE_NPM_TARBALL") target="$arg" ;;
	esac
done
[ "$target" = "$FAKE_NPM_TARBALL" ] || exit 1

npm_major=\${FAKE_NPM_VERSION%%.*}
if [ "$npm_major" -ge 12 ]; then
	[ "$remote_policy" = all ] && [ "$script_policy" = "$FAKE_NPM_TARBALL" ] || exit 1
else
	[ -z "$remote_policy" ] && [ -z "$script_policy" ] || exit 1
fi
`;

	mkdirSync(binDir);
	writeFileSync(installHarnessPath, installHarnessSource, "utf-8");
	writeFileSync(npmPath, npmSource, "utf-8");
	writeFileSync(tarballPath, "verified fixture", "utf-8");
	chmodSync(npmPath, 0o755);

	for (const npmVersion of ["10.9.8", "11.12.1", "12.0.2"]) {
		const result = spawnSync("sh", [installHarnessPath, tarballPath], {
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_NPM_TARBALL: tarballPath,
				FAKE_NPM_VERSION: npmVersion,
				PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			},
		});
		if (result.status !== 0) {
			failures.push(`npm ${npmVersion}: install policy check failed\n${result.stderr}${result.stdout}`);
		}
	}
}

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing Prime Agent...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
	};
}

// ---------------------------------------------------------------------------
// self-test: planted installers must turn the gate red, the real one must stay green
// ---------------------------------------------------------------------------
//
// Each control below writes a whole install.sh - a byte-level mutation of the repository's own
// installer - into its own temporary directory and runs this script there, so what is proven is
// the real entry point: the harness generation, the six render/screen size transitions, the
// progress samples, the npm install policy, the early `main "$@"` check and the exit code. A
// re-implementation of the judgement would prove only that the re-implementation works.
//
// `mutate` throws when its anchor is gone or the replacement changes nothing, so a planted defect
// that no longer applies fails the self-test loudly instead of quietly re-testing the healthy
// installer. Every red control also names the criterion it expects to see, so reaching the right
// verdict for the wrong reason is a mismatch too. Summary: `self-test: N controls, M mismatch(es)`.

/**
 * Plant `source` as install.sh in a throwaway directory and run this gate in it.
 * `source === null` plants nothing, which is how "the installer is not there at all" is controlled.
 */
function runGateOnPlant(label, source, timeoutMs) {
	return new Promise((resolve) => {
		// The pid is in the name so the witness control below only ever judges this run's
		// directories: another lane running this self-test at the same time must not read as
		// leftovers.
		const dir = mkdtempSync(join(tmpdir(), `installer-gate-${process.pid}-${label}-`));
		if (source !== null) {
			writeFileSync(join(dir, DEFAULT_INSTALLER_PATH), source, "utf-8");
		}
		const child = spawn(process.execPath, [SELF_PATH], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		let settled = false;
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			resolve({ code, output, timedOut });
		};
		child.on("error", (error) => finish(`spawn failed: ${error.message}`));
		child.on("close", (code) => finish(code));
	});
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimited(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	const runner = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await worker(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
	return results;
}

/** A mkdtemp-safe label: the control names are sentences. */
function selfTestSlug(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32);
}

/**
 * `source` with `anchor` replaced. Throws when the anchor is gone or the replacement changes
 * nothing: a planted defect whose anchor moved must be a self-test failure, never a green control
 * that quietly re-tested the healthy file.
 */
function mutate(source, anchor, replacement, { all = false } = {}) {
	if (!source.includes(anchor)) {
		throw new Error(`the planted anchor is gone from ${DEFAULT_INSTALLER_PATH}: ${JSON.stringify(anchor)}`);
	}
	const mutated = all ? source.split(anchor).join(replacement) : source.replace(anchor, replacement);
	if (mutated === source) {
		throw new Error(`the planted replacement changed nothing: ${JSON.stringify(anchor)}`);
	}
	return mutated;
}

/**
 * What this self-test must leave exactly as it found it: the installer it copies (its content) and
 * the temporary directories it creates for the planted gates (none of them may survive).
 */
function selfTestWitness() {
	let installerSource;
	try {
		installerSource = readFileSync(DEFAULT_INSTALLER_PATH, "utf-8");
	} catch (error) {
		installerSource = `unreadable: ${error.message}`;
	}
	const leftovers = readdirSync(tmpdir())
		.filter((name) => name.startsWith(`installer-gate-${process.pid}-`))
		.sort();
	return { installerSource, leftovers };
}

function witnessProblems(before, after) {
	const problems = [];
	if (before.installerSource !== after.installerSource) {
		problems.push(`${DEFAULT_INSTALLER_PATH} changed while the self-test ran`);
	}
	const leftovers = after.leftovers.filter((name) => !before.leftovers.includes(name));
	if (leftovers.length > 0) {
		problems.push(`the self-test left ${leftovers.length} planted directory(ies) behind: ${leftovers.join(", ")}`);
	}
	return problems;
}

/** The last non-empty line of a gate's output: short enough for one self-test line. */
function lastLine(output) {
	const lines = output.split("\n").filter((line) => line.trim() !== "");
	return lines.length > 0 ? lines[lines.length - 1] : "(no output)";
}

/** Plant one control's installer, run the gate on it, and judge the verdict and its reason. */
async function judgeControl(control, timeoutMs) {
	let source;
	try {
		source = control.source();
	} catch (error) {
		return { code: "n/a", problem: `the planted installer could not be built: ${error.message}` };
	}
	const run = await runGateOnPlant(selfTestSlug(control.name), source, timeoutMs);
	if (run.timedOut) {
		return { code: "timeout", problem: `the planted gate was still running after ${timeoutMs}ms` };
	}
	if (control.expectPass) {
		return run.code === 0 && run.output.includes("Installer check passed.")
			? { code: run.code }
			: { code: run.code, problem: `expected exit 0 and "Installer check passed.", got exit ${run.code}: ${lastLine(run.output)}` };
	}
	if (run.code !== 1) {
		return { code: run.code, problem: `expected exit 1, got exit ${run.code}: ${lastLine(run.output)}` };
	}
	if (!run.output.includes(control.needle)) {
		return { code: run.code, problem: `exit 1 without naming the criterion "${control.needle}": ${lastLine(run.output)}` };
	}
	return { code: run.code };
}

async function runSelfTest() {
	// One gate spawns nine shells of its own, so the planted gates run a few at a time rather than
	// all at once; the timeout makes a gate that hangs a red control instead of a hung self-test.
	const concurrency = 5;
	const timeoutMs = 120_000;

	let real;
	try {
		real = readFileSync(DEFAULT_INSTALLER_PATH, "utf-8");
	} catch (error) {
		console.error(`self-test: cannot read ${DEFAULT_INSTALLER_PATH}: ${error.message}`);
		console.error("self-test: run it from the repository root, the working directory the gate reads");
		return 1;
	}

	const controls = [
		{
			name: "the repository's own install.sh is green",
			expectPass: true,
			source: () => real,
		},
		{
			name: "a planted installer without the final main call is red",
			expectPass: false,
			needle: 'could not find final main "$@" call',
			source: () => mutate(real, MAIN_CALL, ""),
		},
		{
			name: "a planted logo that never shows is red",
			expectPass: false,
			needle: "expected the initial large render to show the logo",
			source: () =>
				mutate(
					real,
					'\t[ "$prime_agent_screen_layout_show_logo" = 1 ] && [ "$prime_agent_screen_compact" != 1 ] && [ "$prime_agent_screen_render_lab_width" -ge 32 ]',
					"\treturn 1",
				),
		},
		{
			name: "a planted layout mode that never compacts is red",
			expectPass: false,
			needle: "expected shrink below logo width to use compact mode",
			source: () => mutate(real, "\t\tprime_agent_screen_compact=1", "\t\t:", { all: true }),
		},
		{
			name: "a planted render that drops rows is red",
			expectPass: false,
			needle: "expected first render to have 30 rows",
			source: () => mutate(real, '\twhile [ "$y" -lt "$prime_agent_screen_rows" ]; do', '\twhile [ "$y" -lt 3 ]; do'),
		},
		{
			name: "a planted screen frame with a trailing row newline is red",
			expectPass: false,
			needle: "expected first screen frame not to emit a trailing row newline",
			source: () =>
				mutate(
					real,
					'\t\tprintf \'%s%s%s%s\' "$prime_agent_sync_start" "$prime_agent_screen_prefix" "$prime_agent_screen_frame_text" "$prime_agent_sync_end" >&2',
					'\t\tprintf \'%s%s%s\\n%s\' "$prime_agent_sync_start" "$prime_agent_screen_prefix" "$prime_agent_screen_frame_text" "$prime_agent_sync_end" >&2',
				),
		},
		{
			name: "a planted progress step width is red",
			expectPass: false,
			needle: "expected progress sample 2 to show",
			source: () => mutate(real, "\tdetail_index=$(((frame - 1) / 24 + 1))", "\tdetail_index=$(((frame - 1) / 12 + 1))"),
		},
		{
			name: "a planted npm 12 invocation without its remote policy is red",
			expectPass: false,
			needle: "npm 12.0.2: install policy check failed",
			source: () => mutate(real, '--allow-remote=all --allow-scripts="$tarball_path" "$tarball_path"', '"$tarball_path"'),
		},
		{
			name: "a planted directory with no installer at all is red",
			expectPass: false,
			needle: "no such file or directory",
			source: () => null,
		},
	];

	const before = selfTestWitness();
	const results = await mapLimited(controls, concurrency, (control) => judgeControl(control, timeoutMs));

	// The last control judges the run itself: planting installers must not touch the real one, and
	// every planted directory must be gone by the time the planted gates have finished.
	controls.push({
		name: "the self-test left the installer alone and cleaned up its planted directories",
		expectPass: true,
	});
	results.push({ code: "n/a", problem: witnessProblems(before, selfTestWitness()).join("; ") || undefined });

	let mismatches = 0;
	for (const [index, control] of controls.entries()) {
		const { code, problem } = results[index];
		const passed = problem === undefined;
		if (!passed) mismatches += 1;
		console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${control.expectPass ? "green" : "red"}, got exit ${code})`);
		if (!passed) console.log(`       ${problem}`);
	}
	console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}
