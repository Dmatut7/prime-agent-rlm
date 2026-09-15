#!/usr/bin/env node
/**
 * Supply-chain cooldown gate: prove that `.npmrc`'s `min-release-age=7` is really enforced.
 *
 * Why this exists
 * ---------------
 * `min-release-age` was added in npm 11.10. npm 10.x does not error on the key, it *ignores* it
 * without a warning, so a `min-release-age=7` line reads like a policy while a too-old resolver
 * enforces nothing. Node 22 (which `actions/setup-node` with `node-version: 22` installs) ships
 * npm 10.x, so the policy was silently absent exactly in CI, where every dependency is resolved.
 *
 * Measured 2026-09-15 in two otherwise identical directories carrying this repository's `.npmrc`,
 * installing `rollup@4.63.3` (published 20h earlier):
 *
 *   npm 10.9.4  `npm install --package-lock-only rollup@4.63.3`  -> exit 0, "up to date" (ignored)
 *   npm 11.12.0 `npm install --package-lock-only rollup@4.63.3`  -> exit 1
 *       npm error code ETARGET
 *       npm error notarget No matching version found for rollup@4.63.3 with a date before 9/8/2026, 4:40:07 PM.
 *
 * The refusal carries no "release-age"/"cooldown" wording: npm reports a too-young version as an
 * ordinary "no matching version" (ETARGET + notarget + "with a date before"). The probe below
 * therefore matches the strings npm actually prints rather than the phrase one would guess.
 *
 * What each phase proves
 * ----------------------
 *   default     version gate: the npm in use must be >= 11.10 and `.npmrc` must ask for a
 *               cooldown of at least one day, otherwise the policy is not in force and this
 *               exits non-zero naming the upgrade command. A gate, not documentation: run it
 *               after the CI npm upgrade so a regression to npm 10 cannot pass as green.
 *   --self-test offline: planted npm versions and planted `.npmrc` bodies must turn this gate
 *               red (npm 10.9.4, missing key, cooldown 0) and green (11.12.0 + 7), and a planted
 *               cooldown refusal must be distinguishable from a planted network/NOTFOUND error,
 *               a planted silent success and a planted timeout.
 *   --probe     online: pick a version of a churny package published *inside* the cooldown
 *               window, then require `npm install --package-lock-only <pkg>@<ver>` to fail with
 *               the cooldown refusal, and require the same command with `--min-release-age=0` to
 *               succeed (the positive control: the failure is the policy, not the network or a
 *               bad package name). Every npm call and every registry fetch is bounded by
 *               `--timeout-ms`; a timeout, an unreachable registry or no candidate version is a
 *               RED probe with a reason, never a quiet skip.
 *
 * Usage
 * -----
 *   node scripts/check-npm-release-cooldown.mjs
 *   node scripts/check-npm-release-cooldown.mjs --self-test
 *   node scripts/check-npm-release-cooldown.mjs --probe
 *
 * Options: `--npmrc <path>` (default `<repo>/.npmrc`), `--npm-cmd "<argv>"` (default `npm`;
 * use `--npm-cmd "npx -y npm@11.12.0"` to gate or probe a specific npm without changing PATH),
 * `--npm-version <x.y.z>` (skip detection, useful on a machine whose npm cannot be upgraded),
 * `--timeout-ms <n>` (default 45000, applied to every npm call and every registry fetch).
 * Exit codes: 0 = green, 1 = red, 2 = usage error.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_NPMRC = join(REPO_ROOT, ".npmrc");
/** The npm release that introduced `min-release-age`; every older npm ignores the key silently. */
const MIN_NPM_VERSION = "11.10.0";
/** The cooldown `.npmrc` must ask for, in days. */
const MIN_RELEASE_AGE_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 45_000;
const REGISTRY = "https://registry.npmjs.org";
/**
 * Churny packages, tried in order; the first one with a version published inside the cooldown
 * window is used. `typescript` is the safety net: it publishes dev builds daily, so a probe run
 * on an otherwise quiet week still finds a target.
 */
const PROBE_PACKAGES = ["rollup", "vite", "esbuild", "vitest", "typescript", "@types/node", "npm"];
/**
 * What a cooldown refusal looks like on stderr. The first three are the lines npm 11.12.0 really
 * prints (see the header); the rest are the wording the feature is documented under, kept so a
 * future npm that starts naming the option does not turn this probe red for the wrong reason.
 */
const COOLDOWN_REFUSAL_PATTERNS = [
	/\bETARGET\b/i,
	/\bnotarget\b/i,
	/with a date before/i,
	/min-release-age/i,
	/release[-_ ]age/i,
	/cooldown/i,
];

class UsageError extends Error {}

/** First `limit` characters of `text` on one line, for an error message. */
function snippet(text, limit = 400) {
	const collapsed = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/** `[major, minor, patch]`, or null when the text is not a version number. */
function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function versionAtLeast(actual, minimum) {
	const a = parseVersion(actual);
	const b = parseVersion(minimum);
	return a !== null && b !== null && compareVersions(a, b) >= 0;
}

/**
 * The `min-release-age` an `.npmrc` body asks for, or the reason it asks for none. Last
 * assignment wins, which is how npm's ini parser reads a repeated key.
 */
function readMinReleaseAge(text) {
	let raw = null;
	for (const rawLine of String(text ?? "").split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (line === "") continue;
		const match = /^min-release-age\s*(?:=\s*(.*))?$/.exec(line);
		if (match !== null) raw = (match[1] ?? "").trim();
	}
	if (raw === null) {
		return { days: null, reason: "`.npmrc` has no `min-release-age` line, so npm is asked to hold nothing back" };
	}
	if (raw === "") {
		return { days: null, reason: "`.npmrc` sets `min-release-age` with no value, which npm treats as unset" };
	}
	if (!/^\d+$/.test(raw)) {
		return { days: null, reason: `\`.npmrc\` sets \`min-release-age=${raw}\`, which is not a whole number of days` };
	}
	const days = Number.parseInt(raw, 10);
	if (days < 1) {
		return { days, reason: `\`.npmrc\` sets \`min-release-age=${raw}\`: a cooldown of ${days} day(s) holds nothing back` };
	}
	return { days, reason: null };
}

/**
 * The version gate: everything that must hold for `min-release-age` to be in force. Pure, so the
 * self-test can plant npm versions and `.npmrc` bodies through it.
 */
function checkVersionGate({ npmVersion, npmrcText, npmrcPath = DEFAULT_NPMRC }) {
	const failures = [];
	if (npmVersion !== null && !versionAtLeast(npmVersion, MIN_NPM_VERSION)) {
		failures.push(
			`the npm in use reports "${npmVersion}", but \`min-release-age\` needs npm >= ${MIN_NPM_VERSION}: ` +
				"npm 10.x and older ignore the key *silently*, with no warning, so the cooldown written in " +
				`${npmrcPath} is not in force. Upgrade with \`npm install -g npm@${MIN_NPM_VERSION}\` ` +
				"(Node 22 ships npm 10.x, so CI needs that upgrade explicitly), or re-run this gate against " +
				'a specific npm with `--npm-cmd "npx -y npm@11.12.0"`.',
		);
	}
	const cooldown = readMinReleaseAge(npmrcText);
	if (cooldown.reason !== null) {
		failures.push(`${cooldown.reason} (checked ${npmrcPath}), so there is no cooldown to enforce`);
	}
	return failures;
}

function takeValue(argv, index, flag) {
	const inline = `${flag}=`;
	if (argv[index].startsWith(inline)) return { value: argv[index].slice(inline.length), next: index };
	const next = argv[index + 1];
	if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
	return { value: next, next: index + 1 };
}

function takeInteger(argv, index, flag, minimum) {
	const taken = takeValue(argv, index, flag);
	const text = taken.value.trim();
	const value = Number.parseInt(text, 10);
	if (!Number.isInteger(value) || value < minimum || String(value) !== text) {
		throw new UsageError(`${flag} needs an integer >= ${minimum}, got "${taken.value}"`);
	}
	return { value, next: taken.next };
}

function parseArgs(argv) {
	const options = {
		selfTest: false,
		probe: false,
		help: false,
		npmVersion: null,
		npmCmd: ["npm"],
		npmrc: DEFAULT_NPMRC,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			options.selfTest = true;
			continue;
		}
		if (arg === "--probe") {
			options.probe = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--npmrc" || arg.startsWith("--npmrc=")) {
			const taken = takeValue(argv, index, "--npmrc");
			if (taken.value.trim() === "") throw new UsageError("--npmrc needs a path");
			options.npmrc = resolve(taken.value);
			index = taken.next;
			continue;
		}
		if (arg === "--npm-cmd" || arg.startsWith("--npm-cmd=")) {
			const taken = takeValue(argv, index, "--npm-cmd");
			const argvForm = taken.value.trim().split(/\s+/).filter(Boolean);
			if (argvForm.length === 0) throw new UsageError("--npm-cmd needs a command");
			options.npmCmd = argvForm;
			index = taken.next;
			continue;
		}
		if (arg === "--npm-version" || arg.startsWith("--npm-version=")) {
			const taken = takeValue(argv, index, "--npm-version");
			if (parseVersion(taken.value) === null) {
				throw new UsageError(`--npm-version needs a version like 11.12.0, got "${taken.value}"`);
			}
			options.npmVersion = taken.value.trim();
			index = taken.next;
			continue;
		}
		if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
			const taken = takeInteger(argv, index, "--timeout-ms", 1000);
			options.timeoutMs = taken.value;
			index = taken.next;
			continue;
		}
		if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
		throw new UsageError(`unexpected argument "${arg}"`);
	}
	return options;
}

function readTextFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** One child process, reduced to what the gate judges. Never throws. */
function runCommand(command, args, { cwd, timeoutMs }) {
	const started = Date.now();
	try {
		const stdout = execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, npm_config_update_notifier: "false", NO_COLOR: "1" },
		});
		return { code: 0, stdout, stderr: "", merged: stdout, timedOut: false, durationMs: Date.now() - started };
	} catch (error) {
		const stdout = typeof error?.stdout === "string" ? error.stdout : "";
		const stderr = typeof error?.stderr === "string" ? error.stderr : "";
		const timedOut = error?.killed === true || error?.signal === "SIGKILL" || error?.code === "ETIMEDOUT";
		return {
			code: typeof error?.status === "number" ? error.status : null,
			stdout,
			stderr,
			merged: `${stdout}${stderr}`.trim() === "" ? String(error?.message ?? error) : `${stdout}${stderr}`,
			timedOut,
			durationMs: Date.now() - started,
		};
	}
}

function runNpm(options, args, cwd = REPO_ROOT) {
	return runCommand(options.npmCmd[0], [...options.npmCmd.slice(1), ...args], { cwd, timeoutMs: options.timeoutMs });
}

async function fetchPackument(pkg, timeoutMs) {
	const url = `${REGISTRY}/${encodeURIComponent(pkg)}`;
	let response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { accept: "application/json" },
		});
	} catch (error) {
		const name = error?.name === "TimeoutError" ? "timed out" : "failed";
		throw new Error(`GET ${url} ${name}: ${error?.message ?? error}`);
	}
	if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
	return await response.json();
}

/**
 * The newest version of a packument published inside the cooldown window, i.e. the version the
 * policy must refuse. Entries the packument no longer serves, and timestamps in the future, are
 * skipped: neither is installable, so neither can be a probe target.
 */
function selectVersionInsideCooldown(packument, nowMs, maxAgeDays = MIN_RELEASE_AGE_DAYS) {
	const times = packument?.time ?? {};
	const served = packument?.versions ?? {};
	const inside = [];
	for (const [version, publishedAt] of Object.entries(times)) {
		if (version === "created" || version === "modified") continue;
		if (!Object.hasOwn(served, version)) continue;
		const at = Date.parse(publishedAt);
		if (!Number.isFinite(at)) continue;
		const ageDays = (nowMs - at) / 86_400_000;
		if (ageDays < 0 || ageDays >= maxAgeDays) continue;
		inside.push({ version, publishedAt, ageDays });
	}
	if (inside.length === 0) return null;
	inside.sort((left, right) => left.ageDays - right.ageDays);
	return inside[0];
}

function isCooldownRefusal(text) {
	return COOLDOWN_REFUSAL_PATTERNS.some((pattern) => pattern.test(String(text ?? "")));
}

/** The too-young pin must fail *because of* the cooldown, and nothing else counts as green. */
function judgePinAttempt({ outcome, target, timeoutMs }) {
	if (outcome.timedOut) {
		return [
			`the too-young pin \`${target}\` timed out after ${timeoutMs}ms (registry unreachable, or the ` +
				"resolver hung): a probe that cannot finish is red, not skipped",
		];
	}
	if (outcome.code === 0) {
		return [
			`\`npm install --package-lock-only ${target}\` SUCCEEDED (exit 0) with a ${MIN_RELEASE_AGE_DAYS}-day ` +
				"cooldown in `.npmrc`: npm resolved a version published inside the window, so the cooldown is " +
				`not in force on this npm. Output: ${snippet(outcome.merged)}`,
		];
	}
	if (!isCooldownRefusal(outcome.merged)) {
		return [
			`the too-young pin \`${target}\` failed for a reason that is not the cooldown (exit ${outcome.code}, ` +
				"no ETARGET/notarget/date-before wording): this is a broken probe, not a green gate. " +
				`Output: ${snippet(outcome.merged)}`,
		];
	}
	return [];
}

/** The positive control must succeed, otherwise the refusal above proved nothing. */
function judgePositiveControl({ outcome, target, timeoutMs, resolution }) {
	if (outcome.timedOut) {
		return [`the positive control \`${target} --min-release-age=0\` timed out after ${timeoutMs}ms, so the refusal above is unexplained`];
	}
	if (outcome.code !== 0) {
		return [
			`the positive control \`${target} --min-release-age=0\` failed too (exit ${outcome.code}), so the ` +
				"refusal above is not attributable to the cooldown: overrides must install the same version. " +
				`Output: ${snippet(outcome.merged)}`,
		];
	}
	if (resolution !== null && !resolution) {
		return [`the positive control reported success without recording \`${target}\` in package-lock.json`];
	}
	return [];
}

function formatGateInputs(npmVersion, cooldown, npmrcPath) {
	return (
		`npm ${npmVersion ?? "(version not detected)"}, ${npmrcPath} ` +
		(cooldown.days === null ? "asks for no cooldown" : `asks for min-release-age=${cooldown.days}`)
	);
}

/**
 * Read the npm version (unless `--npm-version` pins one) and `.npmrc`, then apply the version
 * gate. Returns the failures, the version and the cooldown so both the gate and the probe share
 * exactly this decision.
 */
function inspectEnvironment(options) {
	const failures = [];
	let npmVersion = options.npmVersion;
	if (npmVersion === null) {
		const detected = runNpm(options, ["--version"]);
		if (detected.timedOut) {
			failures.push(`\`${options.npmCmd.join(" ")} --version\` timed out after ${options.timeoutMs}ms`);
		} else if (detected.code !== 0) {
			failures.push(`\`${options.npmCmd.join(" ")} --version\` exited ${detected.code}: ${snippet(detected.merged)}`);
		} else if (parseVersion(detected.stdout) === null) {
			failures.push(`\`npm --version\` printed "${snippet(detected.stdout, 80)}", which is not a version number`);
		} else {
			npmVersion = detected.stdout.trim();
		}
	}
	const npmrcText = readTextFile(options.npmrc);
	if (npmrcText === null) {
		failures.push(`cannot read ${options.npmrc}: the cooldown policy has to live in a file this gate can read`);
		return { failures, npmVersion, cooldown: { days: null, reason: "unreadable" } };
	}
	const cooldown = readMinReleaseAge(npmrcText);
	failures.push(...checkVersionGate({ npmVersion, npmrcText, npmrcPath: options.npmrc }));
	return { failures, npmVersion, cooldown, npmrcText };
}

function reportFailures(title, failures, hint) {
	console.error(`${title}: RED (${failures.length} problem(s))`);
	for (const failure of failures) console.error(`  - ${failure}`);
	if (hint !== undefined) console.error(hint);
	return 1;
}

/** Phase 1 only: is the cooldown policy in force for the npm that will resolve dependencies? */
function runVersionGate(options) {
	const inspection = inspectEnvironment(options);
	const line = formatGateInputs(inspection.npmVersion, inspection.cooldown, options.npmrc);
	if (inspection.failures.length > 0) {
		return reportFailures(
			`npm release cooldown gate (${line})`,
			inspection.failures,
			"Without npm >= 11.10 resolving dependencies, `.npmrc`'s min-release-age holds nothing back. " +
				"CI upgrades npm to a pinned version and runs this gate after the upgrade; see " +
				".github/workflows/ci.yml and the header of scripts/check-npm-release-cooldown.mjs.",
		);
	}
	console.log(`npm release cooldown gate: GREEN (${line}; npm enforces the cooldown)`);
	return 0;
}

/** Phase 3: ask the registry for a too-young version, then make npm refuse it. */
async function runProbe(options) {
	const failures = [];
	const inspection = inspectEnvironment(options);
	const line = formatGateInputs(inspection.npmVersion, inspection.cooldown, options.npmrc);
	console.log(`probe: ${line}, timeout ${options.timeoutMs}ms per call`);
	if (inspection.failures.length > 0) {
		return reportFailures(
			`npm release cooldown probe (${line})`,
			inspection.failures,
			"The probe only means something on an npm that can enforce the key: fix the gate above first.",
		);
	}

	let target = null;
	for (const pkg of PROBE_PACKAGES) {
		let packument;
		try {
			packument = await fetchPackument(pkg, options.timeoutMs);
		} catch (error) {
			failures.push(`registry fetch for the probe candidate \`${pkg}\` failed: ${snippet(error?.message ?? error)}`);
			continue;
		}
		const picked = selectVersionInsideCooldown(packument, Date.now(), MIN_RELEASE_AGE_DAYS);
		if (picked === null) {
			console.log(`  - ${pkg}: no version published inside the last ${MIN_RELEASE_AGE_DAYS} days`);
			continue;
		}
		target = { package: pkg, version: picked.version, publishedAt: picked.publishedAt, ageDays: picked.ageDays };
		break;
	}
	if (target === null) {
		failures.push(
			`none of the ${PROBE_PACKAGES.length} candidate packages (${PROBE_PACKAGES.join(", ")}) has a version ` +
				`published inside the last ${MIN_RELEASE_AGE_DAYS} days, so there is nothing to refuse: add a ` +
				"churnier candidate to PROBE_PACKAGES rather than letting the probe silently pass",
		);
		return reportFailures(`npm release cooldown probe (${line})`, failures);
	}

	const spec = `${target.package}@${target.version}`;
	console.log(
		`probe target: ${spec}, published ${target.publishedAt} ` +
			`(${target.ageDays.toFixed(2)} days ago, inside the ${MIN_RELEASE_AGE_DAYS}-day window)`,
	);

	const dir = mkdtempSync(join(tmpdir(), "npm-cooldown-probe-"));
	let pin;
	let control;
	let controlResolution = null;
	try {
		const cache = join(dir, "cache");
		const project = (name) => {
			const path = join(dir, name);
			mkdirSync(path, { recursive: true });
			writeFileSync(`${path}/.npmrc`, inspection.npmrcText, "utf8");
			writeFileSync(`${path}/package.json`, '{"name":"npm-cooldown-probe","version":"1.0.0","private":true}\n', "utf8");
			return path;
		};
		const base = ["install", "--package-lock-only", "--no-audit", "--no-fund", "--cache", cache];
		const pinDir = project("pin");
		const controlDir = project("control");
		pin = runNpm(options, [...base, spec], pinDir);
		console.log(
			`  pin      \`npm install --package-lock-only ${spec}\` -> exit ${pin.code}` +
				`${pin.timedOut ? " (timed out)" : ""} in ${pin.durationMs}ms`,
		);
		console.log(`           ${snippet(pin.merged)}`);
		failures.push(...judgePinAttempt({ outcome: pin, target: spec, timeoutMs: options.timeoutMs }));

		control = runNpm(options, [...base, "--min-release-age=0", spec], controlDir);
		console.log(
			`  control  \`npm install --package-lock-only --min-release-age=0 ${spec}\` -> exit ${control.code}` +
				`${control.timedOut ? " (timed out)" : ""} in ${control.durationMs}ms`,
		);
		console.log(`           ${snippet(control.merged)}`);
		const lock = readTextFile(join(controlDir, "package-lock.json"));
		if (lock !== null) controlResolution = lock.includes(`"version": "${target.version}"`);
		failures.push(
			...judgePositiveControl({
				outcome: control,
				target: spec,
				timeoutMs: options.timeoutMs,
				resolution: controlResolution,
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		return reportFailures(`npm release cooldown probe (${line}; target ${spec})`, failures);
	}
	console.log(
		`npm release cooldown probe: GREEN (${line}; npm ${inspection.npmVersion} refused ${spec}, ` +
			"published inside the window, and the --min-release-age=0 control installed it)",
	);
	return 0;
}

// ---------------------------------------------------------------------------
// self-test: planted npm versions, planted .npmrc bodies and planted probe outcomes
// ---------------------------------------------------------------------------

/** A packument with the given `version -> publishedAt` entries, all served. */
function plantedPackument(entries) {
	const versions = {};
	for (const version of Object.keys(entries)) versions[version] = { name: "planted", version };
	return { name: "planted", "dist-tags": { latest: Object.keys(entries)[0] }, versions, time: { ...entries } };
}

function hoursAgo(hours) {
	return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function runSelfTest() {
	const realNpmrc = readTextFile(DEFAULT_NPMRC);
	const goodNpmrc = readMinReleaseAge("min-release-age=7\n");
	const controls = [];
	const gate = (npmVersion, npmrcText) => checkVersionGate({ npmVersion, npmrcText });
	const npmOutcome = (code, merged, extra = {}) => ({ code, stdout: merged, stderr: merged, merged, timedOut: false, durationMs: 1, ...extra });

	// --- the version gate, as the task demands: npm 10 red, no key red, npm 11.12.0 + 7 green ---
	controls.push({
		name: "npm 10.9.4 with a 7-day cooldown is red (the silent-ignore case)",
		expectPass: false,
		run: () => gate("10.9.4", "min-release-age=7"),
	});
	controls.push({
		name: "npm 11.9.0, one minor below the floor, is red",
		expectPass: false,
		run: () => gate("11.9.0", "min-release-age=7"),
	});
	controls.push({
		name: "npm 11.10.0, the release that added the key, is green",
		expectPass: true,
		run: () => gate("11.10.0", "min-release-age=7"),
	});
	controls.push({
		name: "npm 11.12.0 with min-release-age=7 is green",
		expectPass: true,
		run: () => gate("11.12.0", "min-release-age=7"),
	});
	controls.push({
		name: "an .npmrc without min-release-age is red",
		expectPass: false,
		run: () => gate("11.12.0", "save-exact=true\nfund=false\n"),
	});
	controls.push({
		name: "min-release-age=0 is red",
		expectPass: false,
		run: () => gate("11.12.0", "min-release-age=0"),
	});
	controls.push({
		name: "a bare min-release-age with no value is red",
		expectPass: false,
		run: () => gate("11.12.0", "min-release-age"),
	});
	controls.push({
		name: "a non-numeric min-release-age is red",
		expectPass: false,
		run: () => gate("11.12.0", "min-release-age=7d"),
	});
	controls.push({
		name: "a commented-out min-release-age does not count",
		expectPass: false,
		run: () => gate("11.12.0", "# min-release-age=7\n"),
	});
	controls.push({
		name: "spacing and an inline comment still parse",
		expectPass: true,
		run: () => gate("11.12.0", "min-release-age = 7  # seven days\n"),
	});
	controls.push({
		name: "the last min-release-age wins when the key repeats",
		expectPass: false,
		run: () => gate("11.12.0", "min-release-age=7\nmin-release-age=0\n"),
	});
	controls.push({
		name: "an unparsable npm version is red",
		expectPass: false,
		run: () => gate("(unknown)", "min-release-age=7"),
	});
	controls.push({
		name: "a null npm version leaves the version judgement to the caller without inventing a pass",
		expectPass: true,
		run: () => gate(null, "min-release-age=7"),
	});
	controls.push({
		name: "this repository's own .npmrc passes the gate on npm 11.12.0",
		expectPass: true,
		run: () => {
			if (realNpmrc === null) return [`cannot read ${DEFAULT_NPMRC}`];
			return gate("11.12.0", realNpmrc);
		},
	});
	controls.push({
		name: "this repository's .npmrc really asks for the documented cooldown",
		expectPass: true,
		run: () => {
			if (realNpmrc === null) return [`cannot read ${DEFAULT_NPMRC}`];
			const cooldown = readMinReleaseAge(realNpmrc);
			return cooldown.days === MIN_RELEASE_AGE_DAYS
				? []
				: [`${DEFAULT_NPMRC} asks for min-release-age=${cooldown.days ?? "(none)"}, expected ${MIN_RELEASE_AGE_DAYS}`];
		},
	});
	controls.push({
		name: "an unreadable .npmrc is red, not a pass",
		expectPass: false,
		run: () => {
			const dir = mkdtempSync(join(tmpdir(), "npm-cooldown-selftest-"));
			try {
				const missing = join(dir, "absent.npmrc");
				return inspectEnvironment({ ...parseArgs([]), npmVersion: "11.12.0", npmrc: missing }).failures;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	});

	// --- choosing a target the policy must refuse ---
	controls.push({
		name: "the most recently published version inside the window is picked",
		expectPass: true,
		run: () => {
			const planted = plantedPackument({ "1.0.0": hoursAgo(30 * 24), "1.0.9": hoursAgo(50), "1.1.0": hoursAgo(20) });
			const picked = selectVersionInsideCooldown(planted, Date.now());
			return picked?.version === "1.1.0" ? [] : [`picked ${picked?.version ?? "nothing"}, expected 1.1.0 (20h old)`];
		},
	});
	controls.push({
		name: "a version the packument no longer serves is not a target",
		expectPass: true,
		run: () => {
			const packument = plantedPackument({ "1.0.0": hoursAgo(30 * 24), "2.0.0": hoursAgo(2) });
			delete packument.versions["2.0.0"];
			const picked = selectVersionInsideCooldown(packument, Date.now());
			return picked === null ? [] : [`picked the unserved ${picked.version}`];
		},
	});
	controls.push({
		name: "a registry with nothing inside the window yields no target",
		expectPass: true,
		run: () => {
			const picked = selectVersionInsideCooldown(plantedPackument({ "1.0.0": hoursAgo(90 * 24), "2.0.0": hoursAgo(40 * 24) }), Date.now());
			return picked === null ? [] : [`picked ${picked.version} from an all-old packument`];
		},
	});
	controls.push({
		name: "a future timestamp is not a target (clock skew, not a publish)",
		expectPass: true,
		run: () => {
			const picked = selectVersionInsideCooldown(plantedPackument({ "1.0.0": hoursAgo(-48) }), Date.now());
			return picked === null ? [] : [`picked ${picked.version} published in the future`];
		},
	});
	controls.push({
		name: "an empty or shapeless packument yields no target",
		expectPass: true,
		run: () => {
			const picks = [null, {}, { time: {} }, { time: { created: hoursAgo(1) }, versions: {} }].map((p) =>
				selectVersionInsideCooldown(p, Date.now()),
			);
			const wrong = picks.filter((picked) => picked !== null);
			return wrong.length === 0 ? [] : [`${wrong.length} shapeless packument(s) produced a target`];
		},
	});

	// --- judging the probe's two npm calls (the real npm 11.12.0 stderr is the sample) ---
	const realRefusal =
		"\nnpm error code ETARGET\nnpm error notarget No matching version found for rollup@4.63.3 " +
		"with a date before 9/8/2026, 4:40:07 PM.\nnpm error A complete log of this run can be found in: /home/runner/.npm/_logs/x.log\n";
	const target = "rollup@4.63.3";
	controls.push({
		name: "npm 11.12.0's real ETARGET/date-before refusal is recognised",
		expectPass: true,
		run: () => judgePinAttempt({ outcome: npmOutcome(1, realRefusal), target, timeoutMs: 45_000 }),
	});
	controls.push({
		name: "a too-young pin that succeeds is red",
		expectPass: false,
		run: () => judgePinAttempt({ outcome: npmOutcome(0, "\nup to date in 821ms\n"), target, timeoutMs: 45_000 }),
	});
	controls.push({
		name: "a pin that failed for another reason (404) is red",
		expectPass: false,
		run: () => judgePinAttempt({ outcome: npmOutcome(1, "\nnpm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/rollup - Not found\n"), target, timeoutMs: 45_000 }),
	});
	controls.push({
		name: "a pinned-down network failure is red",
		expectPass: false,
		run: () => judgePinAttempt({ outcome: npmOutcome(1, "\nnpm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/ failed\n"), target, timeoutMs: 45_000 }),
	});
	controls.push({
		name: "a timed-out pin is red, not skipped",
		expectPass: false,
		run: () => judgePinAttempt({ outcome: npmOutcome(null, "", { timedOut: true }), target, timeoutMs: 45_000 }),
	});
	controls.push({
		name: "a positive control that installs the version is green",
		expectPass: true,
		run: () => judgePositiveControl({ outcome: npmOutcome(0, "\nup to date in 2s\n"), target, timeoutMs: 45_000, resolution: true }),
	});
	controls.push({
		name: "a positive control that also fails is red",
		expectPass: false,
		run: () => judgePositiveControl({ outcome: npmOutcome(1, realRefusal), target, timeoutMs: 45_000, resolution: null }),
	});
	controls.push({
		name: "a positive control that claims success without the version in the lockfile is red",
		expectPass: false,
		run: () => judgePositiveControl({ outcome: npmOutcome(0, "\nup to date in 2s\n"), target, timeoutMs: 45_000, resolution: false }),
	});
	controls.push({
		name: "a timed-out positive control is red",
		expectPass: false,
		run: () => judgePositiveControl({ outcome: npmOutcome(null, "", { timedOut: true }), target, timeoutMs: 45_000, resolution: null }),
	});
	controls.push({
		name: "the cooldown refusal matcher ignores unrelated npm text",
		expectPass: true,
		run: () => {
			const wrong = ["\nnpm error code E404\n", "\nup to date in 3s\n", ""].filter((text) => isCooldownRefusal(text));
			return wrong.length === 0 ? [] : [`${wrong.length} unrelated text(s) read as a cooldown refusal`];
		},
	});

	// --- options ---
	controls.push({
		name: "every option parses in both spellings",
		expectPass: true,
		run: () => {
			const shape = (options) => `${options.timeoutMs}|${options.probe}|${options.npmCmd.join(" ")}|${options.npmrc}`;
			const spaced = parseArgs(["--probe", "--timeout-ms", "9000", "--npm-cmd", "npx -y npm@11.12.0", "--npmrc", "./.npmrc"]);
			const inline = parseArgs(["--probe", "--timeout-ms=9000", "--npm-cmd=npx -y npm@11.12.0", "--npmrc=./.npmrc"]);
			return shape(spaced) === shape(inline) && spaced.timeoutMs === 9000 && spaced.npmCmd[0] === "npx"
				? []
				: [`parsed "${shape(spaced)}" vs "${shape(inline)}"`];
		},
	});
	controls.push({
		name: "a bad timeout, npm version, unknown flag or stray argument is a usage error",
		expectPass: true,
		run: () => {
			const wrong = [
				["--timeout-ms=45s"],
				["--timeout-ms=0"],
				["--timeout-ms"],
				["--npm-version=eleven"],
				["--npm-cmd="],
				["--frobnicate"],
				["loose-argument"],
			].map((argv) => {
				try {
					parseArgs(argv);
					return `${argv.join(" ")} was accepted`;
				} catch (error) {
					return error instanceof UsageError ? "" : `${argv.join(" ")} threw ${error}`;
				}
			});
			const bad = wrong.filter(Boolean);
			return bad.length === 0 ? [] : bad;
		},
	});
	controls.push({
		name: "--npm-version skips detection (an unusable npm command is never invoked)",
		expectPass: true,
		run: () => {
			const options = parseArgs(["--npm-version", "11.12.0", "--npm-cmd", "definitely-not-a-command-xyz"]);
			const inspection = inspectEnvironment(options);
			return inspection.npmVersion === "11.12.0" && inspection.failures.length === 0
				? []
				: [`--npm-version still produced ${inspection.failures.length} failure(s): ${inspection.failures.join(" / ")}`];
		},
	});
	controls.push({
		name: "an unusable npm command without --npm-version is reported as a failed detection",
		expectPass: true,
		run: () => {
			const options = parseArgs(["--npm-cmd", "definitely-not-a-command-xyz"]);
			const inspection = inspectEnvironment(options);
			return inspection.npmVersion === null && inspection.failures.length > 0
				? []
				: [`detection produced version=${inspection.npmVersion} with ${inspection.failures.length} failure(s)`];
		},
	});

	let mismatches = 0;
	for (const control of controls) {
		let failures;
		let threw;
		try {
			failures = control.run();
		} catch (error) {
			threw = error;
		}
		const passed = threw === undefined && (control.expectPass ? failures.length === 0 : failures.length > 0);
		if (!passed) mismatches += 1;
		const detail = threw ? `threw ${threw.message}` : `${failures.length} failure(s)`;
		console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (expected ${control.expectPass ? "green" : "red"}, got ${detail})`);
		if (!passed && failures?.length) for (const failure of failures) console.log(`       ${failure}`);
	}
	console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}

function usage() {
	return [
		"usage: check-npm-release-cooldown.mjs [--self-test | --probe]",
		"       [--npmrc <path>] [--npm-cmd \"<argv>\"] [--npm-version <x.y.z>] [--timeout-ms <n>]",
		"",
		"  (no phase flag)  version gate: npm >= 11.10 and .npmrc min-release-age >= 1",
		"--self-test      offline: planted npm versions and .npmrc bodies must go red/green",
		"--probe          online: a version published < 7 days ago must be refused, and the",
		"                 --min-release-age=0 control must install it",
	].join("\n");
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
	if (options.selfTest) return runSelfTest();
	if (options.probe) return await runProbe(options);
	return runVersionGate(options);
}

process.exit(await main(process.argv.slice(2)));
