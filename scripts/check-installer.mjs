#!/usr/bin/env node
/**
 * check-installer.mjs - the gate behind `npm run check:installer`, which the husky pre-commit
 * hook (`npm run check`) and CI's `build-check` job both run. `install.sh` is the only entry
 * point an external user has, and this file is the only mechanical reader of it in the repo:
 * nothing else executes the installer's screen / layout / animation / npm-policy shell functions.
 *
 * What it judges (six readings, each one a real execution of install.sh's own functions)
 * --------------------------------------------------------------------------------------
 * The script cuts `install.sh` at its last `main "$@"`, appends a harness, and runs that harness
 * with `sh` under fake terminal sizes (`prime_agent_read_terminal_size` is overridden, so no tty
 * is needed and nothing is installed):
 *
 *   1. logo layout freeze - a too-narrow initial terminal freezes the text-only layout and later
 *      growth must not turn a logo on (`prime_agent_init_screen_layout`'s `layout_ready` latch);
 *   2. resize stability - a safe resize keeps the logo and must not grow the lab width;
 *   3. compact mode - shrinking below the frozen lab width, or below the frozen splash height,
 *      must switch to compact and hide the logo (`prime_agent_refresh_screen_layout_mode`);
 *   4. width safety - no rendered line and no screen-frame line may reach the terminal's last
 *      column at either size (`assertLineWidths`, `max_safe_width = cols - 1`);
 *   5. frame shape - a frame ends with the synchronized-update close escape this file knows
 *      (`\x1b[?2026l`, a hand copy of install.sh's `prime_agent_sync_end`), carries no trailing
 *      row newline, and holds exactly `rows - 1` line breaks;
 *   6. progress + npm policy - the indeterminate progress animation (a fixed status with no
 *      percent, the detail rotating through the step list) and `prime_agent_npm_install`'s npm-12
 *      policy flags (`--allow-remote=all` plus `--allow-scripts=<the verified tarball>` and
 *      nothing wider), checked against a fake npm at majors 10 / 11 / 12.
 *
 * Usage
 * -----
 *   node scripts/check-installer.mjs              # the gate (green prints "Installer check passed.")
 *   node scripts/check-installer.mjs --self-test  # prove the gate can still go red
 *
 * --self-test contract
 * --------------------
 * Nine controls, all in memory: eight plant a mutation of install.sh's own text and require the
 * *same* assertion code the gate runs to name the exact drift that mutation introduces (a
 * mutation that reddens for an unrelated reason - a harness crash, a vanished anchor - is a
 * mismatch, not a pass), and the ninth requires the unmutated source to stay green so a broken
 * environment cannot masquerade as detection. A tenth control proves the run is side-effect free:
 * install.sh is byte-identical afterwards and every throwaway harness directory the controls
 * created is gone. It writes nothing into the checkout (fixtures live in `mkdtempSync`), starts no
 * browser, opens no socket and installs nothing; it takes ~18s because each control really runs
 * the installer's own shell functions under `sh`.
 *
 * install.sh is resolved from this file's own location, so the gate and its self-test read the
 * same installer whichever directory they are invoked from.
 * Exit codes: 0 = green, 1 = red, 2 = usage.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = join(repoRoot, "install.sh");

const mainCall = '\nmain "$@"';
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const noMainCallFailure = 'could not find final main "$@" call.';

// Per-run state: every assertion below reads these five, so one run assigns all five and returns
// its own failure list (that is what lets --self-test drive the same code over mutated sources).
let installerSource = "";
let mainCallIndex = -1;
let tempDir = "";
let harnessPath = "";
let failures = [];
/** Every throwaway directory this process created, so the self-test can prove they were removed. */
const createdTempDirs = [];

class UsageError extends Error {}

function parseArgs(argv) {
	const options = { selfTest: false };
	for (const arg of argv) {
		if (arg === "--self-test") options.selfTest = true;
		else if (arg === "-h" || arg === "--help") options.help = true;
		else throw new UsageError(`check-installer: unknown argument ${arg}`);
	}
	return options;
}

function usage() {
	console.error("usage: node scripts/check-installer.mjs [--self-test]");
}

function readInstallerSource() {
	if (!existsSync(installerPath)) {
		throw new UsageError(`check-installer: no installer at ${installerPath} (not a prime-agent checkout?)`);
	}
	return readFileSync(installerPath, "utf-8");
}

/**
 * Run the whole gate over one installer source and return its failures.
 * `scope` narrows a run to the readings a control needs (`{ cases: false }` skips the render /
 * layout / progress harnesses, `{ npmPolicy: false }` skips the fake-npm install policy run).
 */
function runInstallerCheck(source, scope = {}) {
	const runCases = scope.cases !== false;
	const runNpmPolicy = scope.npmPolicy !== false;
	installerSource = source;
	mainCallIndex = installerSource.lastIndexOf(mainCall);
	failures = [];
	if (mainCallIndex === -1) {
		failures.push(noMainCallFailure);
		return failures;
	}

	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
	createdTempDirs.push(tempDir);
	harnessPath = join(tempDir, "harness.sh");

	try {
		if (runCases) {
			writeFileSync(harnessPath, buildHarnessSource(), "utf-8");

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

		}
		if (runNpmPolicy) checkNpmInstallPolicies();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	return failures;
}

function buildHarnessSource() {
	return `${installerSource.slice(0, mainCallIndex)}

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
}

// ---------------------------------------------------------------------------
// self-test: planted install.sh mutations must turn the gate red, the shipped one must not
// ---------------------------------------------------------------------------

/**
 * Apply one mutation to the installer text. The anchor must occur exactly `occurrences` times:
 * an anchor that drifted away becomes a silent no-op, and a no-op mutation would report
 * "expected red, got green" without naming why. Throwing here names the drifted anchor instead,
 * so install.sh moving under a control reddens the self-test rather than hiding.
 */
function mutate(source, find, replace, occurrences = 1) {
	let count = 0;
	for (let index = source.indexOf(find); index !== -1; index = source.indexOf(find, index + find.length)) count += 1;
	if (count !== occurrences) {
		throw new Error(`mutation anchor occurs ${count}x, expected ${occurrences}x: ${find.slice(0, 72)}`);
	}
	return source.split(find).join(replace);
}

/** One control: a source to run, whether it must be green, and the failure a red one must name. */
function selfTestControls(source) {
	// The render/layout/progress readings and the fake-npm policy reading are independent scopes;
	// each control runs only the scope its mutation can affect, so the self-test stays in seconds.
	const casesOnly = { npmPolicy: false };
	const npmPolicyOnly = { cases: false };
	return [
		{
			name: "the shipped install.sh passes every reading (green control)",
			expectPass: true,
			run: () => runInstallerCheck(source),
		},
		{
			name: 'a vanished final main "$@" anchor is caught',
			expectPass: false,
			expectFailure: noMainCallFailure,
			run: () => runInstallerCheck(mutate(source, mainCall, '\n# main "$@" removed by the self-test\n')),
		},
		{
			name: "a widened logo-support width floor is caught (reading 1: layout freeze)",
			expectPass: false,
			expectFailure: "expected a too-narrow initial terminal to freeze text-only layout",
			run: () =>
				runInstallerCheck(
					mutate(source, '[ "$prime_agent_screen_cols" -ge 42 ]', '[ "$prime_agent_screen_cols" -ge 20 ]'),
					casesOnly,
				),
		},
		{
			name: "a lowered compact row threshold is caught (reading 3: compact mode)",
			expectPass: false,
			expectFailure: "expected shrink below frozen splash height to use compact mode",
			run: () =>
				runInstallerCheck(mutate(source, '[ "$prime_agent_screen_rows" -lt 17 ]', '[ "$prime_agent_screen_rows" -lt 5 ]'), casesOnly),
		},
		{
			name: "an off-by-one safe width is caught (reading 4: no line reaches the last column)",
			expectPass: false,
			expectFailure: "expected narrow width mode to keep the rendered lab width inside the resized terminal",
			run: () =>
				runInstallerCheck(
					mutate(source, "max_safe_width=$((prime_agent_screen_cols - 1))", "max_safe_width=$((prime_agent_screen_cols))"),
					casesOnly,
				),
		},
		{
			name: "a changed synchronized-update close escape is caught (reading 5: frame shape)",
			expectPass: false,
			expectFailure: "expected first screen frame to end with synchronized update close",
			run: () =>
				runInstallerCheck(
					mutate(source, 'prime_agent_sync_end="${prime_agent_esc}[?2026l"', 'prime_agent_sync_end="${prime_agent_esc}[?2025l"'),
					casesOnly,
				),
		},
		{
			name: "a progress detail that stops rotating is caught (reading 6a: step list)",
			expectPass: false,
			expectFailure: 'expected progress sample 3 to show "Linking command binaries."',
			run: () => runInstallerCheck(mutate(source, 'sed -n "${detail_index}p"', 'sed -n "1p"'), casesOnly),
		},
		{
			name: "a percent in the progress status is caught (reading 6b: indeterminate)",
			expectPass: false,
			expectFailure: "expected progress sample 1 to use indeterminate status",
			run: () =>
				runInstallerCheck(
					mutate(source, `		*) printf '%s...' "$1" ;;`, `		*) printf '%s %s%%' "$1" "42" ;;`),
					casesOnly,
				),
		},
		{
			name: "an npm-12 policy threshold that skips the flags is caught (reading 6c: install policy)",
			expectPass: false,
			expectFailure: "npm 12.0.2: install policy check failed",
			run: () => runInstallerCheck(mutate(source, '[ "$npm_major" -ge 12 ]', '[ "$npm_major" -ge 13 ]'), npmPolicyOnly),
		},
	];
}

function runSelfTest(source) {
	const installerBefore = readFileSync(installerPath);
	const controls = selfTestControls(source);
	let mismatches = 0;

	for (const control of controls) {
		let controlFailures;
		let threw;
		try {
			controlFailures = control.run();
		} catch (error) {
			threw = error;
		}
		const wanted = control.expectPass ? "green" : `red naming "${control.expectFailure}"`;
		let passed = false;
		let detail;
		if (threw !== undefined) {
			detail = `threw ${threw.message}`;
		} else {
			const named =
				control.expectFailure === undefined || controlFailures.some((failure) => failure.includes(control.expectFailure));
			passed = (control.expectPass ? controlFailures.length === 0 : controlFailures.length > 0 && named) === true;
			detail = `${controlFailures.length} failure(s)${named ? "" : ", none naming the planted drift"}`;
		}
		if (!passed) mismatches += 1;
		console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${wanted}, got ${detail})`);
		if (!passed && controlFailures) for (const failure of controlFailures) console.log(`       ${failure}`);
	}

	const leftovers = createdTempDirs.filter((dir) => existsSync(dir));
	const installerChanged = !readFileSync(installerPath).equals(installerBefore);
	const clean = leftovers.length === 0 && !installerChanged;
	if (!clean) mismatches += 1;
	console.log(
		`${clean ? "ok  " : "FAIL"} the self-test is side-effect free (install.sh ${
			installerChanged ? "CHANGED on disk" : "byte-identical"
		}; ${createdTempDirs.length} throwaway dir(s) created, ${leftovers.length} left behind)`,
	);
	for (const dir of leftovers) console.log(`       left behind: ${dir}`);

	console.log(`self-test: ${controls.length + 1} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}

function main(argv) {
	try {
		const options = parseArgs(argv);
		if (options.help) {
			usage();
			return 0;
		}
		const source = readInstallerSource();
		if (options.selfTest) {
			const status = runSelfTest(source);
			if (status === 0) console.log("check-installer self-test: OK (every planted drift reddens the gate it belongs to)");
			else console.error("check-installer self-test: RED (a planted drift was not detected, or the green control was)");
			return status;
		}
		const runFailures = runInstallerCheck(source);
		if (runFailures.length > 0) {
			console.error(["Installer check failed:", ...runFailures.map((failure) => `- ${failure}`)].join("\n"));
			return 1;
		}
		console.log("Installer check passed.");
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			usage();
			return 2;
		}
		throw error;
	}
}

process.exit(main(process.argv.slice(2)));

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
