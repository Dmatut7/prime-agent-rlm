/**
 * Release gate for the fork checkout: no `v*` tag, no `npm publish`.
 *
 * This repository is a maintained fork of prime-agent, and its release surface is not
 * adjudicated yet. `.github/workflows/build-binaries.yml` is *live* in this tree
 * (`on: push: tags: ['v*']` at :6-8; a `publish` job at :227 with
 * `permissions: contents: write` at :230-231 and `secrets.R2_ACCESS_KEY_ID` at :233),
 * origin has never run it, and the lane still lacks three upstream fixes. A `v*` tag
 * pushed from here therefore publishes release artifacts from an unadjudicated lane.
 *
 * The ban exists today only as prose:
 *   - CHANGELOG.md:45  "build-binaries.yml 的活体发布面未裁决，故仍**禁推 `v*` 标签**"
 *   - docs/fork/merge-upstream-20260917.md:180 and :192 (risk registration R1)
 *
 * Prose is not a gate, and the forbidden path is one command wide: `scripts/release.mjs`
 * reaches `git tag v$version` (:214), `npm run publish` (:218) - which is
 * `npm publish -ws --access public`, upstream public scope @earendil-works - and
 * `git push origin v$version` (:223) from `npm run release:patch`. This module is the
 * machine half of the ban, and the line numbers cited above are *derived from the files
 * at refusal time* ({@link releaseBanAnchors}) so an anchor cannot rot in silence.
 *
 * Shape is copied from the fork's other gate, packages/coding-agent/src/fork-self-update.ts:
 * marker walk + one explicit escape hatch that is never silent. The marker file is the
 * same one that gate uses - {@link FORK_MARKER_FILE} here and `FORK_MARKER_FILE` there
 * are pinned to one another by packages/coding-agent/test/fork-release-gate.test.ts, so
 * the two gates cannot disagree about what "a fork checkout" is.
 *
 * Plain ESM, zero dependencies, runs under bare `node`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Marker this fork keeps at its repository root. Same value as `FORK_MARKER_FILE` in
 * packages/coding-agent/src/fork-self-update.ts; the pin test asserts the equality of
 * the exported constants rather than a copy of this literal.
 */
export const FORK_MARKER_FILE = "FORK_NOTES.md";

/**
 * The one way out, and it is never silent: exactly the string `"1"` counts as an explicit
 * release from a fork checkout (any other value, including `"true"`, `"yes"` or `"1 "`, is
 * refused), and taking it prints a warning naming the checkout whose ban was lifted.
 */
export const RELEASE_GATE_ENV_VAR = "PRIME_AGENT_ALLOW_RELEASE";

/** Lines whose line *numbers* are cited in the refusal; resolved at refusal time. */
const BAN_ANCHORS = [
	{ file: "CHANGELOG.md", needle: "禁推" },
	{ file: "docs/fork/merge-upstream-20260917.md", needle: "禁止在 origin 推" },
];

/**
 * Walked up from this module rather than from `process.cwd()`: the question the gate asks
 * is "which checkout owns this script", and a cwd-based walk would answer "no fork" for a
 * release started from outside the checkout (a fail-open). `scripts/lib` is always inside
 * the checkout that ships it.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root of the checkout that ships this module (the walk, not `MODULE_DIR` itself:
 * the module sits in `scripts/lib`, and the files the ban is written in sit two levels up).
 * Falls back to `MODULE_DIR` when the walk finds nothing, so it is only ever a citation hint.
 */
const MODULE_CHECKOUT_ROOT = detectForkCheckout(MODULE_DIR).repoRoot ?? MODULE_DIR;

/** Thrown refusal; carries {@link ReleaseGateRefusal#exitCode} so a caller only has to exit with it. */
export class ReleaseGateRefusal extends Error {
	constructor(lines) {
		super(lines.join("\n"));
		this.name = "ReleaseGateRefusal";
		/** Lines are pre-split so a caller picks the stream and a test can assert content. */
		this.lines = lines;
		this.exitCode = 2;
	}
}

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Is `startDir` inside a fork checkout? Fails *closed*: if the marker walk itself throws
 * (an fs error, a permission problem, an unreadable path), the result is "yes, a fork"
 * with {@link ForkCheckoutDetection#scanError} set, because "could not tell" must never
 * be reported as "official checkout, go ahead".
 *
 * @param {string} [startDir] directory to start the walk from.
 * @param {{exists?: (path: string) => boolean}} [options] `exists` is a test seam for the
 *   fail-closed path (a throwing walk cannot be produced from the real filesystem).
 * @returns {{isForkCheckout: boolean, repoRoot: string | null, scanError: string | null}}
 */
export function detectForkCheckout(startDir = MODULE_DIR, options = {}) {
	const exists = options.exists ?? existsSync;
	try {
		let dir = resolve(startDir);
		for (;;) {
			if (exists(join(dir, FORK_MARKER_FILE))) {
				return { isForkCheckout: true, repoRoot: dir, scanError: null };
			}
			const parent = dirname(dir);
			if (parent === dir) {
				return { isForkCheckout: false, repoRoot: null, scanError: null };
			}
			dir = parent;
		}
	} catch (error) {
		// Fail closed. The reason is carried, not swallowed: the refusal names it.
		return { isForkCheckout: true, repoRoot: null, scanError: describeError(error) };
	}
}

/**
 * The `file:line` anchors of the ban, resolved from the checkout's own files instead of
 * being hard-coded here - a line number nobody re-derives goes stale in silence. Roots are
 * tried in order: the checkout the walk found, then the checkout that ships this module
 * (the files the ban is written in always sit next to the script enforcing it), and only
 * then the bare path. Every fallback is deliberate: a refusal that cannot read its own
 * citations must still refuse, and the pin test asserts that each anchor carrying a line
 * number really does point at a line stating the ban.
 *
 * @param {string} [startDir] checkout root (or any directory inside it).
 * @returns {string[]} anchors, e.g. `["CHANGELOG.md:45", "docs/fork/...md:180", "...:192"]`.
 */
export function releaseBanAnchors(startDir = MODULE_DIR) {
	const detection = detectForkCheckout(startDir);
	const roots = [...new Set([detection.repoRoot, MODULE_CHECKOUT_ROOT])].filter(Boolean);
	const anchors = [];
	for (const { file, needle } of BAN_ANCHORS) {
		let cited = null;
		for (const root of roots) {
			try {
				const lines = readFileSync(join(root, file), "utf-8").split("\n");
				const hits = lines
					.map((line, index) => (line.includes(needle) ? `${file}:${index + 1}` : null))
					.filter(Boolean);
				if (hits.length > 0) {
					cited = hits;
					break;
				}
			} catch {
				// Try the next root; the bare path remains as the last resort.
			}
		}
		anchors.push(...(cited ?? [file]));
	}
	return anchors;
}

/**
 * The refusal printed instead of a release. Lines are returned rather than printed so the
 * caller decides the stream and a test can assert the content.
 */
export function releaseGateRefusalLines(detection, options = {}) {
	const where = detection.repoRoot ?? "(checkout root unknown: the marker walk failed and was treated as a fork)";
	const lines = [
		`error: refusing to release from a fork checkout (marker ${FORK_MARKER_FILE} at ${where}).`,
		"本线禁推 v* 标签、禁 npm publish：发布面未裁决 (this fork must not push a v* tag and must not npm publish).",
		"",
		"The release surface is not adjudicated: .github/workflows/build-binaries.yml is live here",
		"(on: push: tags: ['v*'], publish job with `permissions: contents: write`), origin has never",
		"run it, and this lane still lacks three upstream fixes, so a v* tag from here would publish",
		"release artifacts from an unadjudicated lane.",
	];
	if (detection.scanError) {
		lines.push(
			"",
			`The marker walk failed (${detection.scanError}); an unanswered question is refused, not allowed.`,
		);
	}
	lines.push(
		"",
		"The ban is on record at:",
		...(options.anchors ?? releaseBanAnchors(detection.repoRoot ?? MODULE_DIR)).map((anchor) => `  ${anchor}`),
		"",
		"To release from this fork anyway (it prints a warning and lifts the ban for that one command):",
		`  ${RELEASE_GATE_ENV_VAR}=1 <command>`,
	);
	return lines;
}

/** The warning printed when {@link RELEASE_GATE_ENV_VAR} lifts the ban. Never silent. */
export function releaseGateOverrideLine(detection) {
	const where = detection.repoRoot ?? "(checkout root unknown)";
	return `warning: ${RELEASE_GATE_ENV_VAR}=1 given; releasing from the fork checkout at ${where} may push a v* tag / npm publish, which CHANGELOG.md still bans.`;
}

/**
 * The gate. Returns the detection when the call may proceed and throws
 * {@link ReleaseGateRefusal} when it may not:
 *   - not a fork checkout (walk finds no marker) -> allowed, nothing printed: an official
 *     checkout has an adjudicated release surface and is not what the ban is about;
 *   - fork checkout without `PRIME_AGENT_ALLOW_RELEASE=1` -> refused;
 *   - fork checkout *with* it -> allowed, one warning line on `warn` (never silent).
 *
 * @param {{startDir?: string, env?: Record<string, string | undefined>, warn?: (line: string) => void, exists?: (path: string) => boolean}} [options]
 * @returns {{isForkCheckout: boolean, repoRoot: string | null, scanError: string | null}}
 */
export function assertReleaseAllowed(options = {}) {
	const { startDir = MODULE_DIR, env = process.env, warn = console.warn, exists } = options;
	const detection = detectForkCheckout(startDir, { exists });
	if (!detection.isForkCheckout) {
		return detection;
	}
	if (env[RELEASE_GATE_ENV_VAR] === "1") {
		warn(releaseGateOverrideLine(detection));
		return detection;
	}
	throw new ReleaseGateRefusal(releaseGateRefusalLines(detection));
}
