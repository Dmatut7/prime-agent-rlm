#!/usr/bin/env node

/**
 * Lockstep versions across every workspace of this monorepo, and the lockfile agreement that the
 * 0.10.0 release got wrong.
 *
 * The boundary this script judges (and prints, so the claim and the sampling面 can never drift
 * apart again):
 *
 *   IN  - every manifest npm treats as a workspace member, discovered by expanding the root
 *         `package.json`'s `workspaces` patterns. That is `packages/*` *and* the nested
 *         `packages/coding-agent/examples/extensions/*` members; the previous version of this
 *         script read `readdirSync("packages")` one level deep, so the four extension examples
 *         could sit at 0.9.5 while it printed "All packages at same version (lockstep)".
 *   OUT - `prime-agent-runtime` (a separate Python distribution that keeps its own version) and
 *         anything not reachable from `workspaces`. Both are named in the report rather than
 *         silently skipped.
 *
 * Two drift classes are failures:
 *   1. a workspace manifest whose version differs from the others (`versions.size > 1`);
 *   2. a `package-lock.json` workspace entry that disagrees with the manifest next to it. Release
 *      0adac843e carried exactly that: the lock said 0.10.0 for the four examples while the
 *      manifests in the same commit said 0.9.5, and `npm ci` accepts both.
 *
 * Modes:
 *   node scripts/sync-versions.js            sync inter-package dependency ranges, then judge
 *   node scripts/sync-versions.js --check    judge only, write nothing (gates use this)
 *   node scripts/sync-versions.js --self-test
 *
 * Exit codes: 0 = lockstep holds, 1 = drift (named), 2 = usage or an unreadable workspace pattern.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SELF_TEST = process.argv.includes("--self-test");
const CHECK_ONLY = process.argv.includes("--check") || SELF_TEST;
const KNOWN_FLAGS = new Set(["--check", "--self-test"]);

/** Packages that are deliberately outside the lockstep set, named in the report. */
const OUT_OF_SCOPE = ["prime-agent-runtime"];

class UsageError extends Error {}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Expands the root `workspaces` patterns to relative directories.
 *
 * Only one `*`, and only in the last segment (`packages/*`), is supported. A pattern this function
 * cannot expand is a hard error: silently ignoring an unrecognised pattern is the shape of the bug
 * this script exists to prevent - a check whose sampling面 is smaller than its claim.
 */
export function expandWorkspaces(root, patterns) {
	const dirs = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) {
			throw new UsageError(`workspaces contains a pattern that is not a path: ${JSON.stringify(pattern)}`);
		}
		const segments = pattern.split("/").filter((segment) => segment.length > 0);
		const starCount = segments.filter((segment) => segment.includes("*")).length;
		if (starCount === 0) {
			dirs.push(segments.join("/"));
			continue;
		}
		if (starCount > 1 || !segments[segments.length - 1].includes("*")) {
			throw new UsageError(
				`workspaces pattern ${JSON.stringify(pattern)} is not expandable (only a single '*' in the last segment is); ` +
					"teach expandWorkspaces about it instead of letting the check sample less than it claims",
			);
		}
		const parent = join(root, ...segments.slice(0, -1));
		const leaf = segments[segments.length - 1];
		const leafPrefix = leaf.slice(0, leaf.indexOf("*"));
		if (!existsSync(parent)) {
			throw new UsageError(`workspaces pattern ${JSON.stringify(pattern)} points at a directory that does not exist: ${parent}`);
		}
		// A `*` matches directories that carry a manifest, which is what npm installs as a member
		// (`packages/` itself may hold directories that are not workspaces).
		const matches = readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(leafPrefix))
			.filter((entry) => existsSync(join(parent, entry.name, "package.json")))
			.map((entry) => [...segments.slice(0, -1), entry.name].join("/"))
			.sort();
		if (matches.length === 0) {
			// A pattern that expands to nothing means the check would silently cover one member less.
			throw new UsageError(`workspaces pattern ${JSON.stringify(pattern)} expanded to no workspace under ${parent}`);
		}
		dirs.push(...matches);
	}
	return dirs;
}

/** Every workspace member whose manifest exists, in a stable order. */
export function workspaceMembers(root) {
	const rootManifestPath = join(root, "package.json");
	const rootManifest = readJson(rootManifestPath);
	const patterns = rootManifest.workspaces ?? [];
	if (!Array.isArray(patterns) || patterns.length === 0) {
		throw new UsageError("the root package.json declares no workspaces array; nothing to hold in lockstep");
	}
	const members = [];
	for (const dir of expandWorkspaces(root, patterns)) {
		const manifestPath = join(root, dir, "package.json");
		if (!existsSync(manifestPath)) {
			// A pattern written out by hand (`packages/coding-agent/examples/extensions/sandbox`) must
			// resolve: that directory is one more place a version could be hiding, and npm errors here
			// too. (A `*` expansion filters these out above, the way npm matches members.)
			throw new UsageError(`workspace ${dir} is listed in workspaces but has no package.json`);
		}
		const manifest = readJson(manifestPath);
		members.push({ dir, manifestPath, name: manifest.name ?? dir, version: manifest.version, data: manifest });
	}
	return { rootManifest, members, patterns };
}

/**
 * The lockfile's workspace entries (`packages["<dir>"]`) against the manifests beside them.
 * A workspace with no lock entry is a failure too: `npm install` records every member, so a missing
 * entry means the lock was hand-edited or never refreshed - the same class as a disagreeing one.
 */
export function lockProblems(root, members) {
	const lockPath = join(root, "package-lock.json");
	if (!existsSync(lockPath)) {
		return [`${lockPath} is missing: the lockfile is what npm ci installs from, so it has to be checked`];
	}
	const lock = readJson(lockPath);
	const entries = lock.packages ?? {};
	const problems = [];
	for (const member of members) {
		const entry = entries[member.dir];
		if (entry === undefined) {
			problems.push(
				`package-lock.json has no entry for workspace ${member.dir} (manifest says ${member.version}); ` +
					"run `npm install` so the lock records it",
			);
			continue;
		}
		if (entry.version !== member.version) {
			problems.push(
				`${member.dir}: package-lock.json says ${entry.version} while ${member.manifestPath} says ${member.version} ` +
					"(npm ci accepts either, so this has to be checked here)",
			);
		}
	}
	return problems;
}

/** The version-drift problems: every workspace member must carry the same version. */
export function lockstepProblems(members) {
	const byVersion = new Map();
	for (const member of members) {
		if (typeof member.version !== "string" || member.version.length === 0) {
			return [`${member.manifestPath} has no version`];
		}
		const list = byVersion.get(member.version) ?? [];
		list.push(member);
		byVersion.set(member.version, list);
	}
	if (byVersion.size <= 1) return [];
	const majority = [...byVersion.entries()].sort((a, b) => b[1].length - a[1].length)[0];
	const problems = [`not all ${members.length} workspace members share one version; most are at ${majority[0]}:`];
	for (const [version, list] of [...byVersion.entries()].sort()) {
		if (version === majority[0]) continue;
		for (const member of list) problems.push(`  ${member.manifestPath} is at ${version}, expected ${majority[0]}`);
	}
	return problems;
}

/**
 * The dependency ranges that point at another workspace member but do not name its version.
 * Returned rather than written so `--check` can report drift without touching the tree.
 */
export function dependencyUpdates(members) {
	const versions = new Map(members.map((member) => [member.name, member.version]));
	const updates = [];
	for (const member of members) {
		for (const field of ["dependencies", "devDependencies"]) {
			const block = member.data[field];
			if (!block) continue;
			for (const [depName, current] of Object.entries(block)) {
				if (!versions.has(depName)) continue;
				const wanted = `^${versions.get(depName)}`;
				if (current !== wanted) updates.push({ member, field, depName, current, wanted });
			}
		}
	}
	return updates;
}

export function applyDependencyUpdates(updates) {
	const touched = new Set();
	for (const update of updates) {
		update.member.data[update.field][update.depName] = update.wanted;
		touched.add(update.member);
	}
	for (const member of touched) {
		writeFileSync(member.manifestPath, `${JSON.stringify(member.data, null, "\t")}\n`);
	}
	return touched.size;
}

/** One judgement pass. `write` decides whether dependency drift is synced or merely reported. */
export function evaluate(root, write) {
	const { members } = workspaceMembers(root);
	const problems = [...lockstepProblems(members), ...lockProblems(root, members)];
	const updates = dependencyUpdates(members);
	if (write && updates.length > 0) {
		applyDependencyUpdates(updates);
	}
	if (!write) {
		for (const update of updates) {
			problems.push(
				`${update.member.manifestPath}: ${update.field}.${update.depName} is ${update.current}, ` +
					`expected ${update.wanted} (run node scripts/sync-versions.js to sync it)`,
			);
		}
	}
	return { members, problems, updates };
}

function describe(members) {
	return `${members.length} workspace members (${members.map((member) => member.dir).join(", ")})`;
}

function run(root, write) {
	const { members, problems, updates } = evaluate(root, write);
	console.log(`Lockstep set: ${describe(members)}`);
	for (const member of members) console.log(`  ${member.name}: ${member.version}`);
	for (const out of OUT_OF_SCOPE) console.log(`  (out of scope by design: ${out})`);
	if (updates.length > 0 && write) {
		console.log(`\nSynced ${updates.length} inter-package dependency range(s).`);
	}
	if (problems.length > 0) {
		console.error("\nERROR: the workspace versions are not one version:");
		for (const problem of problems) console.error(`  ${problem}`);
		return 1;
	}
	console.log(`\nAll ${members.length} workspace members are at one version, and package-lock.json agrees with each manifest.`);
	return 0;
}

// ---------------------------------------------------------------------------
// self-test: every leg plants a drift the check has to name
// ---------------------------------------------------------------------------
function writeFixturePackage(root, dir, manifest) {
	const dirPath = join(root, dir);
	mkdirSync(dirPath, { recursive: true });
	writeFileSync(join(dirPath, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "sync-versions-selftest-"));
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify(
			{
				name: "fixture-root",
				version: "0.10.0",
				private: true,
				workspaces: ["packages/*", "packages/nested/examples/one"],
			},
			null,
			"\t",
		)}\n`,
	);
	writeFixturePackage(root, "packages/a", {
		name: "fixture-a",
		version: "0.10.0",
		dependencies: { "fixture-b": "0.10.0" },
	});
	writeFixturePackage(root, "packages/b", { name: "fixture-b", version: "0.10.0" });
	writeFixturePackage(root, "packages/nested/examples/one", { name: "fixture-one", version: "0.10.0" });
	writeLock(root, { "packages/a": "0.10.0", "packages/b": "0.10.0", "packages/nested/examples/one": "0.10.0" });
	return root;
}

function writeLock(root, versions) {
	const packages = { "": { name: "fixture-root", version: "0.10.0" } };
	for (const [dir, version] of Object.entries(versions)) packages[dir] = { version };
	writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages }, null, "\t")}\n`);
}

function selfTest() {
	let controls = 0;
	let mismatches = 0;
	const expect = (name, want, problems, needle) => {
		controls += 1;
		const red = problems.length > 0;
		const named = !needle || problems.some((problem) => problem.includes(needle));
		if (red === (want === "red") && named) {
			console.log(`ok   ${name} (${red ? "red" : "green"})`);
			return;
		}
		mismatches += 1;
		console.log(`FAIL ${name}: wanted ${want}, got ${red ? "red" : "green"}; problems: ${JSON.stringify(problems)}`);
	};

	const roots = [];
	try {
		// 1. a consistent tree is green, and the report counts the nested member too
		let root = makeFixture();
		roots.push(root);
		let result = evaluate(root, true);
		expect("a consistent tree is green", "green", result.problems);
		controls += 1;
		if (result.members.length === 3) console.log("ok   the nested workspace member is inside the lockstep set (3 members)");
		else {
			mismatches += 1;
			console.log(`FAIL the nested workspace member is missing from the lockstep set: ${JSON.stringify(result.members.map((m) => m.dir))}`);
		}
		// the sync half still writes: packages/a's dependency drifts to 0.10.0 -> ^0.10.0
		controls += 1;
		const aAfter = readJson(join(root, "packages/a/package.json"));
		if (aAfter.dependencies["fixture-b"] === "^0.10.0") console.log("ok   the dependency range is synced to ^<version>");
		else {
			mismatches += 1;
			console.log(`FAIL the dependency range was not synced: ${JSON.stringify(aAfter.dependencies)}`);
		}

		// 2. the B4-28 shape: a *nested* workspace member left behind by the lockstep bump
		root = makeFixture();
		roots.push(root);
		writeFixturePackage(root, "packages/nested/examples/one", { name: "fixture-one", version: "0.9.5" });
		result = evaluate(root, false);
		expect("a nested member left behind is red", "red", result.problems, "packages/nested/examples/one/package.json");

		// 3. the 0adac843e shape: lock and manifest disagree inside one commit
		root = makeFixture();
		roots.push(root);
		writeLock(root, { "packages/a": "0.10.0", "packages/b": "0.9.9", "packages/nested/examples/one": "0.10.0" });
		result = evaluate(root, false);
		expect("a lock entry that disagrees with its manifest is red", "red", result.problems, "package-lock.json says 0.9.9");

		// 4. a workspace the lock never recorded
		root = makeFixture();
		roots.push(root);
		writeLock(root, { "packages/a": "0.10.0", "packages/b": "0.10.0" });
		result = evaluate(root, false);
		expect("a workspace missing from the lock is red", "red", result.problems, "has no entry for workspace");

		// 5. dependency drift in check mode is reported, not written
		root = makeFixture();
		roots.push(root);
		result = evaluate(root, false);
		expect("dependency drift is reported in check mode", "red", result.problems, "run node scripts/sync-versions.js to sync it");
		controls += 1;
		const aUntouched = readJson(join(root, "packages/a/package.json"));
		if (aUntouched.dependencies["fixture-b"] === "0.10.0") console.log("ok   check mode writes nothing");
		else {
			mismatches += 1;
			console.log(`FAIL check mode wrote to the manifest: ${JSON.stringify(aUntouched.dependencies)}`);
		}

		// 6. an unexpandable pattern is a loud failure, not a smaller sample
		root = makeFixture();
		roots.push(root);
		writeFileSync(
			join(root, "package.json"),
			`${JSON.stringify({ name: "fixture-root", version: "0.10.0", workspaces: ["packages/*/examples/*"] }, null, "\t")}\n`,
		);
		controls += 1;
		try {
			workspaceMembers(root);
			mismatches += 1;
			console.log("FAIL an unexpandable workspace pattern must not be silently skipped");
		} catch (error) {
			if (error instanceof UsageError) console.log("ok   an unexpandable workspace pattern is a hard error");
			else {
				mismatches += 1;
				console.log(`FAIL unexpected error type for an unexpandable pattern: ${error}`);
			}
		}

		console.log(`\nself-test: ${controls} controls, ${mismatches} mismatch(es)`);
		return mismatches === 0 ? 0 : 1;
	} finally {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	}
}

if (SELF_TEST) {
	process.exit(selfTest());
}

for (const arg of process.argv.slice(2)) {
	if (!KNOWN_FLAGS.has(arg)) {
		console.error(`usage: node scripts/sync-versions.js [--check|--self-test]   (unknown argument ${arg})`);
		process.exit(2);
	}
}

try {
	process.exit(run(resolve(process.cwd()), !CHECK_ONLY));
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`sync-versions: ${error.message}`);
		process.exit(2);
	}
	throw error;
}
