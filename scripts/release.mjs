#!/usr/bin/env node
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs <target> --dry-run   (preview changelog updates only)
 *
 * Steps:
 * 1. Refuse to run at all when this checkout is a fork (FORK RELEASE GATE below)
 * 2. Check for uncommitted changes
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: aggregate .changes/*.md fragments into a
 *    [version] - date section, git rm the consumed fragments
 * 5. Commit and tag
 * 6. Publish to npm
 * 7. Push the branch and the tag
 *
 * ───────────────────────────────── FORK RELEASE GATE ─────────────────────────────────
 *
 * What one `npm run release:*` does that cannot be undone, in the order it does it:
 *
 *   1. `git commit -m "Release v$ver"` - a release commit on this line's history, on top of a
 *      version bump that already rewrote every workspace `package.json` (and, for an explicit
 *      `x.y.z` target, already deleted and reinstalled `node_modules` + `package-lock.json`).
 *   2. `git tag v$ver` - the tag the registry, GitHub and every installer read as "a release".
 *   3. `npm run publish` -> `npm publish -ws --access public` - publishes `@earendil-works/pi-*`,
 *      i.e. the UPSTREAM public npm scope. npm never lets a version be unpublished again, so a
 *      fork build published from here is permanent and is what upstream users then install.
 *   4. `git push origin main` + `git push origin v$ver` - and pushing a `v*` tag is what triggers
 *      `.github/workflows/build-binaries.yml` (`on: push: tags: ['v*']`; its `publish` job runs
 *      with `permissions: contents: write` and `secrets.R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
 *      / `R2_BUCKET` / `R2_ENDPOINT_URL`), which uploads release artifacts to R2, rewrites
 *      `latest.json`, `stable` and `install.sh`, and creates or updates the GitHub release.
 *
 * Why this line must not do that: this checkout is the maintained fork
 * `Dmatut7/prime-agent-rlm`, not the upstream release channel. Its `build-binaries.yml` release
 * surface is live but unadjudicated (`docs/fork/merge-upstream-20260917.md` §4.4 risk R1), and
 * `CHANGELOG.md` §已知挂账 carries the ban as prose only ("仍禁推 `v*` 标签"). Prose is not a
 * guardrail - nothing in the repository stopped `npm run release:patch` from running all four
 * steps - so the gate below is that guardrail.
 *
 * How the fork is detected: walk up from this file's own directory for the marker file
 * `FORK_MARKER_FILE`, exactly like `detectForkInstall()` in
 * `packages/coding-agent/src/fork-self-update.ts` does for the self-update refusal. This is a
 * deliberate copy of a four-line walk, not an import: `npm run release:*` runs
 * `node scripts/release.mjs`, so importing the TypeScript side would need a loader (`tsx`/`jiti`)
 * plus a built `dist/` for its `@earendil-works/pi-ai` import - a gate that can fail to load is
 * not a gate. The two sides are pinned together instead by
 * `packages/coding-agent/test/release-fork-gate.test.ts`, which imports the TS constants, runs
 * both detectors over the same directories, and fails if either name drifts.
 *
 * How to release from a fork checkout anyway - explicitly, and only explicitly:
 *
 *   PRIME_AGENT_ALLOW_RELEASE=1 node scripts/release.mjs <major|minor|patch|x.y.z>
 *
 * Any other value (`true`, `yes`, `0`, empty, `1 `) keeps the refusal; per this repository's
 * "explicitly provided" rule there is no fallback and nothing is guessed. The override stops the
 * refusal and nothing else: it prints a warning naming every step above, and the run then goes on
 * to commit, tag, `npm publish` `@earendil-works/pi-*` to the public registry, push `main`, push
 * the tag, and thereby run `build-binaries.yml` with `contents: write` and the R2 secrets.
 *
 * The gate fires before argument parsing and before anything is read, written or spawned, and it
 * fires on `--dry-run` too. A dry run performs no irreversible step (it prints the changelog
 * preview and exits before the first write), so gating it is not about protecting the tree: it is
 * because a rehearsal that looks and reads like a normal release is how a forbidden release gets
 * run, and because a refusal that depends on a flag is a hole the size of that flag. `--dry-run`
 * with the override set is the supported way to look at what a release would fold together.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildReleaseSection } from "./lib/changelog-fragments.mjs";

/**
 * Marker this fork keeps at its repository root.
 *
 * Must stay equal to the `FORK_MARKER_FILE` export of
 * `packages/coding-agent/src/fork-self-update.ts`; the needle named in the header asserts the
 * equality and runs both marker walks over the same fixture directories, so neither side can be
 * renamed or repointed on its own.
 */
const FORK_MARKER_FILE = "FORK_NOTES.md";

/**
 * The only override this gate accepts, and deliberately not `PRIME_AGENT_FORK_GATE`: that variable
 * is the self-update gate's test seam (`=off`), and a seam that exists so suites can exercise the
 * official update path must never open a release. Pinned behaviourally by the same needle.
 */
const RELEASE_OVERRIDE_ENV_VAR = "PRIME_AGENT_ALLOW_RELEASE";

/** The irreversible steps, printed by both gate outcomes so neither can be read as harmless. */
const IRREVERSIBLE_RELEASE_STEPS = [
	'1. git commit -m "Release v<ver>"  (the version bump already rewrote every package.json)',
	"2. git tag v<ver>",
	"3. npm run publish -> npm publish -ws --access public: publishes @earendil-works/pi-*,",
	"   the UPSTREAM public npm scope, where a version can never be unpublished again",
	"4. git push origin main && git push origin v<ver>: pushing a v* tag runs",
	"   .github/workflows/build-binaries.yml (publish job: permissions contents: write,",
	"   secrets.R2_ACCESS_KEY_ID) -> release artifacts to R2, latest.json/stable/install.sh",
	"   rewritten, GitHub release created or updated",
];

/** Walk up from `startDir` for the fork marker; mirrors `findForkInstall()` on the TypeScript side. */
function findForkRoot(startDir) {
	let dir = resolve(startDir);
	for (;;) {
		if (existsSync(join(dir, FORK_MARKER_FILE))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * The gate itself: refuse on a fork checkout, warn loudly when the override is given, and do
 * nothing at all on an installation that is not a fork checkout. Called before any argument is
 * parsed, so no invocation shape can reach the steps below without passing it.
 */
function forkReleaseGate() {
	const forkRoot = findForkRoot(dirname(fileURLToPath(import.meta.url)));
	if (forkRoot === undefined) {
		return;
	}

	const override = process.env[RELEASE_OVERRIDE_ENV_VAR];
	if (override === "1") {
		console.warn(`warning: ${RELEASE_OVERRIDE_ENV_VAR}=1 given; releasing from a fork checkout.`);
		console.warn(`warning: fork marker ${FORK_MARKER_FILE} at ${forkRoot}`);
		console.warn("warning: the flag stops this refusal and nothing else. This run will still:");
		for (const step of IRREVERSIBLE_RELEASE_STEPS) {
			console.warn(`   ${step}`);
		}
		console.warn("");
		return;
	}

	const lines = [
		`error: refusing to release from a fork checkout (marker ${FORK_MARKER_FILE} at ${forkRoot}).`,
		"",
		"One `npm run release:*` performs, in this order, steps that cannot be undone:",
		...IRREVERSIBLE_RELEASE_STEPS.map((step) => `   ${step}`),
		"",
		"This checkout is the maintained fork Dmatut7/prime-agent-rlm, not the upstream release",
		"channel, and its build-binaries.yml release surface is live but unadjudicated",
		"(docs/fork/merge-upstream-20260917.md §4.4 R1; CHANGELOG.md 已知挂账 records the `v*` tag",
		"ban as prose only). Publishing from here would put a fork build into the public",
		"@earendil-works/pi-* scope for good and cut a release nobody adjudicated.",
		"",
		"Nothing was read, written, committed, tagged, published or pushed: the gate runs before",
		"argument parsing and applies to --dry-run as well.",
		"",
		"To release from this checkout anyway, say so explicitly:",
		`   ${RELEASE_OVERRIDE_ENV_VAR}=1 node scripts/release.mjs <major|minor|patch|x.y.z>`,
	];
	// Named but not echoed: a mis-set variable's value has no business ending up in a CI log, and
	// "set to something that is not 1" is the whole reason the run was refused.
	if (override !== undefined) {
		lines.push(
			"",
			`note: ${RELEASE_OVERRIDE_ENV_VAR} is set, but to something other than exactly "1", so the`,
			"refusal stands. There is no fallback value.",
		);
	}
	for (const line of lines) {
		console.error(line);
	}
	process.exit(1);
}

forkReleaseGate();

const DRY_RUN = process.argv.includes("--dry-run");
const RELEASE_TARGET = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	if (compareVersions(target, currentVersion) <= 0) {
		console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		`npm version ${target} -ws --no-git-tag-version && node scripts/sync-versions.js && npx shx rm -rf node_modules packages/*/node_modules package-lock.json && npm install`,
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function listFragments(pkgDir) {
	const changesDir = join(pkgDir, ".changes");
	if (!existsSync(changesDir)) {
		return [];
	}

	const files = readdirSync(changesDir)
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => join(changesDir, name));
	return files
		.map((path) => ({ path, key: fragmentSortKey(path) }))
		.sort((a, b) => a.key - b.key || (a.path < b.path ? -1 : 1))
		.map(({ path }) => ({ name: path, content: readFileSync(path, "utf-8") }));
}

function fragmentSortKey(path) {
	const output = run(`git log --diff-filter=A --format=%ct -1 -- ${shellQuote(path)}`, {
		silent: true,
		ignoreError: true,
	});
	const epoch = Number.parseInt((output || "").trim(), 10);
	return Number.isFinite(epoch) ? epoch : Infinity;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();
	const consumedFragments = [];

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const allFragments = listFragments(dirname(changelog));
		// Empty fragments are skipped, not consumed, so nothing is ever lost silently.
		const empty = allFragments.filter((fragment) => !fragment.content.trim());
		for (const fragment of empty) {
			console.warn(`  Warning: skipping empty fragment ${fragment.name}; delete it or add content.`);
		}
		const fragments = allFragments.filter((fragment) => fragment.content.trim());
		const result = buildReleaseSection(content, fragments, version, date);

		if (!result.changed) {
			console.log(`  Skipping ${changelog}: no fragments`);
			continue;
		}

		if (DRY_RUN) {
			console.log(`\n--- ${changelog} (${fragments.length} fragments) ---`);
			const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const sectionRe = new RegExp(`## \\[${escapedVersion}\\][\\s\\S]*?(?=\\n## \\[|$)`);
			console.log((result.content.match(sectionRe) || ["(no release section)"])[0]);
		} else {
			writeFileSync(changelog, result.content);
			console.log(`  Updated ${changelog} (${fragments.length} fragments)`);
		}
		consumedFragments.push(...fragments.map((fragment) => fragment.name));
	}

	if (consumedFragments.length > 0) {
		if (DRY_RUN) {
			console.log(`\nWould git rm: ${consumedFragments.join(", ")}`);
		} else {
			run(`git rm -q -- ${consumedFragments.map(shellQuote).join(" ")}`);
		}
	}
}

function previewVersion(target) {
	if (!BUMP_TYPES.has(target)) {
		return target;
	}
	const [major, minor, patch] = getVersion().split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

console.log("\n=== Release Script ===\n");

if (DRY_RUN) {
	const version = previewVersion(RELEASE_TARGET);
	console.log(`Dry run for v${version}: previewing changelog updates, no files are written.`);
	updateChangelogsForRelease(version);
	console.log("\n=== Dry run complete (no changes made) ===");
	process.exit(0);
}

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Publishing to npm...");
run("npm run publish");
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
