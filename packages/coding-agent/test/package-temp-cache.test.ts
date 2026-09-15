import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * R14 FS-1 / FS-1b: the temporary extension cache that `-e <npm-or-git source>` fills
 * and the extension loader then imports.
 *
 * Only the public package-manager entry point is driven. Observations are file system
 * facts plus what the fake `npm`/`git` on PATH were asked to run, so a silent "the
 * directory was already there, reuse it" is distinguishable from an install.
 */

const CACHE_NAMESPACE = "pi-extensions";
/** The computable shared path the audit planted into: sha256("npm-")[0:8]. */
const LEGACY_NPM_HASH = "f35b2129";
/** sha256("git-example.invalid-acme/ext")[0:8]. */
const LEGACY_GIT_HASH = "88c94770";
const NPM_PACKAGE = "pi-probe-nonexistent-pkg-xyz";
const NPM_SOURCE = `npm:${NPM_PACKAGE}`;
const GIT_SOURCE = "https://example.invalid/acme/ext";
const IS_WINDOWS = process.platform === "win32";

function uidSuffix(): string {
	return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

function modeString(path: string): string | undefined {
	try {
		return (lstatSync(path).mode & 0o777).toString(8);
	} catch {
		return undefined;
	}
}

function readLog(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function writeFakeTool(dir: string, name: string, body: string): void {
	const path = join(dir, name);
	writeFileSync(path, body, { mode: 0o755 });
	chmodSync(path, 0o755);
}

/** Logs its argv, then either refuses or performs a dependency-free "install". */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, "npm " + args.join(" ") + "\\n");
if (process.env.FAKE_NPM_BEHAVIOR === "fail") {
  process.stderr.write("fake npm: install refused\\n");
  process.exit(1);
}
if (process.env.FAKE_NPM_BEHAVIOR === "install") {
  const prefixIndex = args.indexOf("--prefix");
  const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
  const spec = args.find((a) => a !== "install" && a !== "-g" && !a.startsWith("-") && a !== prefix);
  if (prefix && spec) {
    const name = spec.replace(/@[^@]*$/, "");
    const pkgDir = path.join(prefix, "node_modules", name);
    fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    fs.writeFileSync(
      path.join(pkgDir, "extensions", "installed.ts"),
      "export default function () { return { name: \\"installed\\" }; }\\n"
    );
  }
}
process.exit(0);
`;

/** Logs argv plus cwd; can materialise a clone and can fail a fetch. */
const FAKE_GIT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) {
  fs.appendFileSync(process.env.FAKE_TOOL_LOG, "git " + args.join(" ") + " [cwd=" + process.cwd() + "]\\n");
}
const stdout = {
  "rev-parse HEAD": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rev-parse @{upstream}": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "rev-parse --abbrev-ref @{upstream}": "origin/main",
  "rev-parse origin/HEAD": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
  "rev-parse --is-inside-work-tree": "true",
};
if (Object.prototype.hasOwnProperty.call(stdout, args.join(" "))) {
  process.stdout.write(stdout[args.join(" ")] + "\\n");
  process.exit(0);
}
if (args[0] === "clone") {
  const target = args[args.length - 1];
  fs.mkdirSync(path.join(target, "pi-extensions"), { recursive: true });
  fs.mkdirSync(path.join(target, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ name: "fake-clone", pi: { extensions: ["./pi-extensions"] } })
  );
  fs.writeFileSync(
    path.join(target, "pi-extensions", "hook.ts"),
    "export default function () { return { name: \\"fake-clone\\" }; }\\n"
  );
  process.exit(0);
}
if (args[0] === "fetch" && process.env.FAKE_GIT_FETCH_BEHAVIOR === "fail") {
  process.stderr.write("fake git: fetch refused\\n");
  process.exit(128);
}
process.exit(0);
`;

function plantedExtension(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "export default function () { return { name: 'planted' }; }\n");
}

describe("temporary extension cache privileges (R14 FS-1, FS-1b)", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let toolLog: string;
	let previousTmpdir: string | undefined;
	let previousPath: string | undefined;
	let previousOffline: string | undefined;

	beforeEach(() => {
		root = join(realpathSync(tmpdir()), `r14-fsperm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(join(root, "bin"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		toolLog = join(root, "tools.log");
		writeFakeTool(join(root, "bin"), "npm", FAKE_NPM);
		writeFakeTool(join(root, "bin"), "git", FAKE_GIT);

		previousTmpdir = process.env.TMPDIR;
		previousPath = process.env.PATH;
		previousOffline = process.env.PI_OFFLINE;
		// The fake tools shadow the real ones, so no test can reach a registry or a host.
		process.env.TMPDIR = root;
		process.env.PATH = `${join(root, "bin")}:${previousPath ?? ""}`;
		process.env.FAKE_TOOL_LOG = toolLog;
		delete process.env.PI_OFFLINE;
	});

	afterEach(() => {
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		restore("TMPDIR", previousTmpdir);
		restore("PATH", previousPath);
		restore("PI_OFFLINE", previousOffline);
		delete process.env.FAKE_TOOL_LOG;
		delete process.env.FAKE_NPM_BEHAVIOR;
		delete process.env.FAKE_GIT_FETCH_BEHAVIOR;
		rmSync(root, { recursive: true, force: true });
	});

	function createManager(): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd: projectDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			bundledSkillsDir: null,
		});
	}

	function toolCalls(prefix: string): string[] {
		return readLog(toolLog).filter((line) => line.startsWith(prefix));
	}

	/** `<tmp>/pi-extensions-<uid>`: the private root the fix is expected to claim. */
	function claimedCacheRoot(): string {
		return join(root, `${CACHE_NAMESPACE}-${uidSuffix()}`);
	}

	/** The `<prefix>/<bucket>` pair component: the part that must not be source-computable. */
	function entryBucket(extensionPath: string): string {
		const parts = extensionPath.split(sep);
		const index = parts.lastIndexOf("npm");
		return index >= 0 && index + 1 < parts.length ? parts[index + 1] : "";
	}

	describe("a directory somebody else placed is never executed", () => {
		it.skipIf(IS_WINDOWS)(
			"does not load a pre-seeded shared cache directory: the installer is asked to run instead",
			async () => {
				// The reported exploit: the shared path was computable and `existsSync` stood
				// in for "installed", so npm never ran and the planted file was loaded.
				const legacyEntry = join(root, CACHE_NAMESPACE, "npm", LEGACY_NPM_HASH);
				const plantedPkg = join(legacyEntry, "node_modules", NPM_PACKAGE);
				mkdirSync(join(plantedPkg, "extensions"), { recursive: true });
				writeFileSync(join(plantedPkg, "package.json"), JSON.stringify({ name: NPM_PACKAGE, version: "0.0.1" }));
				// Mode 0777 all the way: a tree another account created and can still write.
				for (const dir of [
					join(root, CACHE_NAMESPACE),
					legacyEntry,
					join(legacyEntry, "node_modules"),
					plantedPkg,
				]) {
					chmodSync(dir, 0o777);
				}
				plantedExtension(join(plantedPkg, "extensions", "hijack.ts"));
				process.env.FAKE_NPM_BEHAVIOR = "fail";

				let extensions: string[] = [];
				let thrown: unknown;
				try {
					const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
					extensions = resolved.extensions.map((entry) => entry.path);
				} catch (error) {
					thrown = error;
				}

				expect(extensions.filter((path) => path.includes("hijack.ts"))).toEqual([]);
				expect(toolCalls("npm ").length, "the installer must be asked to run, not skipped").toBeGreaterThan(0);
				expect(String(thrown)).toContain(NPM_PACKAGE);
			},
		);

		it("does not run git with a pre-seeded checkout as its working directory", async () => {
			// FS-1b: the refresh used to run `git fetch`/`reset` with the planted tree as
			// cwd, and git itself executes `.git/config`'s `core.sshCommand` from there.
			const planted = join(root, CACHE_NAMESPACE, "git-example.invalid", LEGACY_GIT_HASH, "acme", "ext");
			mkdirSync(join(planted, "pi-extensions"), { recursive: true });
			mkdirSync(join(planted, ".git"), { recursive: true });
			writeFileSync(
				join(planted, "package.json"),
				JSON.stringify({ name: "planted", pi: { extensions: ["./pi-extensions"] } }),
			);
			plantedExtension(join(planted, "pi-extensions", "hijack.ts"));
			const pwnMarker = join(root, "ssh-command-executed");
			writeFileSync(
				join(planted, ".git", "config"),
				`[core]\n\tsshCommand = /bin/sh -c 'echo pwned > ${pwnMarker}'\n[remote "origin"]\n\turl = git@example.invalid:acme/ext.git\n`,
			);
			process.env.FAKE_GIT_FETCH_BEHAVIOR = "fail";

			let extensions: string[] = [];
			let diagnostics: Array<{ type: string; message: string }> = [];
			let thrown: unknown;
			try {
				const resolved = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });
				extensions = resolved.extensions.map((entry) => entry.path);
				diagnostics = resolved.diagnostics;
			} catch (error) {
				thrown = error;
			}

			const gitCalls = toolCalls("git ");
			expect(
				gitCalls.filter((line) => line.includes(`[cwd=${planted}]`)),
				`git must never run with the planted directory as cwd: ${gitCalls.join("; ")}`,
			).toEqual([]);
			expect(existsSync(pwnMarker), `core.sshCommand must not run: ${gitCalls.join("; ")}`).toBe(false);
			expect(extensions.filter((path) => path.includes("hijack.ts"))).toEqual([]);
			const reinstalledOrRefused =
				gitCalls.some((line) => line.startsWith("git clone")) ||
				thrown !== undefined ||
				diagnostics.some((diagnostic) => /reinstall|prime-agent installed|refus/i.test(diagnostic.message));
			expect(reinstalledOrRefused, "an unverified cache must be reinstalled or explicitly refused").toBe(true);
		});

		it("reinstalls rather than reusing an entry whose directory became writable by others", async () => {
			// Proves the gate is "we installed this and nobody else can write it", not
			// merely "the cache moved". Install for real, then loosen the installed entry.
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const installed = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			expect(installed.extensions).toHaveLength(1);
			const packageDir = dirname(dirname(installed.extensions[0].path));
			chmodSync(packageDir, 0o777);

			process.env.FAKE_NPM_BEHAVIOR = "fail";
			const npmCallsBefore = toolCalls("npm ").length;
			let extensions: string[] = [];
			let diagnostics: Array<{ type: string; message: string }> = [];
			let thrown: unknown;
			try {
				const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
				extensions = resolved.extensions.map((entry) => entry.path);
				diagnostics = resolved.diagnostics;
			} catch (error) {
				thrown = error;
			}

			expect(extensions).toEqual([]);
			expect(toolCalls("npm ").length, "a loosened entry must be reinstalled, not reused").toBeGreaterThan(
				npmCallsBefore,
			);
			const visible = thrown !== undefined || diagnostics.length > 0;
			expect(visible, "refusing a cache entry must not be silent").toBe(true);
		});

		it("reinstalls rather than following an entry swapped for a symlink", async () => {
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const installed = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			const packageDir = dirname(dirname(installed.extensions[0].path));
			const elsewhere = join(root, "elsewhere-payload");
			plantedExtension(join(elsewhere, "extensions", "hijack.ts"));
			rmSync(packageDir, { recursive: true, force: true });
			symlinkSync(elsewhere, packageDir);

			process.env.FAKE_NPM_BEHAVIOR = "fail";
			let extensions: string[] = [];
			try {
				const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
				extensions = resolved.extensions.map((entry) => entry.path);
			} catch {
				// A failed reinstall is the acceptable outcome; loading the payload is not.
			}

			expect(extensions.filter((path) => path.includes("hijack.ts"))).toEqual([]);
			expect(toolCalls("npm ").length).toBeGreaterThan(1);
		});

		it("refuses an unverified entry in offline mode rather than loading it", async () => {
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const installed = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			const packageDir = dirname(dirname(installed.extensions[0].path));
			chmodSync(packageDir, 0o777);
			process.env.PI_OFFLINE = "1";

			const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });

			expect(resolved.extensions.map((entry) => entry.path)).toEqual([]);
			expect(resolved.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toHaveLength(1);
			expect(resolved.diagnostics[0].message).toMatch(/offline/i);
		});

		it("never creates the shared cache namespace", async () => {
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });

			expect(existsSync(join(root, CACHE_NAMESPACE))).toBe(false);
			expect(modeString(claimedCacheRoot())).toBe("700");
			if (typeof process.getuid === "function") {
				expect(lstatSync(claimedCacheRoot()).uid).toBe(process.getuid());
			}
			expect(resolved.extensions).toHaveLength(1);
		});

		it("falls back to a one-off private root when the per-uid name is squatted, and still installs", async () => {
			// A different account cannot be created here, so the squat is simulated the
			// way it would actually arrive in /tmp: the predictable name is taken by a
			// symlink into the attacker's tree, which already holds a "cache entry".
			const attackerTree = join(root, "attacker-tree");
			const plantedPkg = join(attackerTree, "npm", LEGACY_NPM_HASH, "node_modules", NPM_PACKAGE);
			mkdirSync(join(plantedPkg, "extensions"), { recursive: true });
			plantedExtension(join(plantedPkg, "extensions", "hijack.ts"));
			symlinkSync(attackerTree, claimedCacheRoot());

			process.env.FAKE_NPM_BEHAVIOR = "install";
			const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });

			expect(resolved.extensions).toHaveLength(1);
			const extensionPath = resolved.extensions[0].path;
			expect(extensionPath.includes("hijack.ts")).toBe(false);
			expect(extensionPath.startsWith(attackerTree)).toBe(false);
			expect(lstatSync(claimedCacheRoot()).isSymbolicLink()).toBe(true);
			expect(extensionPath.startsWith(join(root, `${CACHE_NAMESPACE}-${uidSuffix()}-`))).toBe(true);
			expect(
				resolved.diagnostics.filter((diagnostic) => /one-off private directory/i.test(diagnostic.message)),
			).toHaveLength(1);
			// The attacker's tree is left exactly as found: never read, never deleted.
			expect(existsSync(join(plantedPkg, "extensions", "hijack.ts"))).toBe(true);
		});

		it("bounds its own leftover one-off roots without touching a live one", async () => {
			// The fallback path creates a fresh private root per process when the per-uid
			// name is unavailable, so the sweep has to keep that from becoming a disk
			// leak - while never touching a root that is still young (another process may
			// be using it) or a directory this account does not own.
			const attackerTree = join(root, "attacker-tree");
			mkdirSync(attackerTree, { recursive: true });
			const prefix = `${CACHE_NAMESPACE}-${uidSuffix()}`;
			const stale: string[] = [];
			for (let index = 0; index < 6; index += 1) {
				const path = join(root, `${prefix}-stale-${index}`);
				mkdirSync(path, { recursive: true });
				const when = new Date(Date.now() - (index + 2) * 60 * 60 * 1000);
				utimesSync(path, when, when);
				stale.push(path);
			}
			const young = join(root, `${prefix}-young`);
			mkdirSync(young, { recursive: true });
			utimesSync(young, new Date(), new Date());
			// A directory owned by another account is skipped by the sweep as well; that
			// branch needs a second uid to test, so it is only asserted by the shape check
			// below (a symlinked per-uid root survives untouched).
			symlinkSync(attackerTree, claimedCacheRoot());

			process.env.FAKE_NPM_BEHAVIOR = "install";
			const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });

			expect(resolved.extensions).toHaveLength(1);
			expect(resolved.extensions[0].path.startsWith(join(root, `${prefix}-`))).toBe(true);
			const remaining = stale.filter((path) => existsSync(path));
			expect(remaining.length, "stale one-off roots of ours must be swept, newest few kept").toBeLessThan(
				stale.length,
			);
			expect(remaining.length).toBeLessThanOrEqual(3);
			expect(existsSync(young), "a young root may belong to a live process").toBe(true);
			expect(existsSync(claimedCacheRoot()) && lstatSync(claimedCacheRoot()).isSymbolicLink()).toBe(true);
		});

		it("derives the entry name from the cache root, not from the source alone", async () => {
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const first = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			const firstBucket = entryBucket(first.extensions[0].path);
			expect(firstBucket.length).toBeGreaterThan(0);
			expect(firstBucket).not.toBe(LEGACY_NPM_HASH);

			// A second private root, same source: a fresh root must not reuse a name that
			// could have been computed in advance.
			const otherTmp = join(root, "second-tmp");
			mkdirSync(join(otherTmp, "bin"), { recursive: true });
			writeFakeTool(join(otherTmp, "bin"), "npm", FAKE_NPM);
			const savedTmpdir = process.env.TMPDIR;
			const savedPath = process.env.PATH;
			process.env.TMPDIR = otherTmp;
			process.env.PATH = `${join(otherTmp, "bin")}:${savedPath ?? ""}`;
			try {
				const second = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
				expect(entryBucket(second.extensions[0].path)).not.toBe(firstBucket);
			} finally {
				process.env.TMPDIR = savedTmpdir;
				process.env.PATH = savedPath;
			}
		});
	});

	describe("positive control: what prime-agent installed is cached, refreshed and loaded", () => {
		it("installs into the private root, loads the extension and reuses the cache next time", async () => {
			process.env.FAKE_NPM_BEHAVIOR = "install";
			const resolved = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			const extensionPath = resolved.extensions[0]?.path;
			expect(extensionPath, "a clean install must resolve an extension").toBeDefined();
			expect(existsSync(extensionPath ?? "")).toBe(true);
			expect(extensionPath?.startsWith(`${claimedCacheRoot()}${sep}`)).toBe(true);
			expect(resolved.diagnostics).toEqual([]);
			const npmCalls = toolCalls("npm ").length;
			expect(npmCalls).toBeGreaterThan(0);

			// A second manager over the same TMPDIR is the next process: the verified
			// cache must be reused without running the installer again.
			const again = await createManager().resolveExtensionSources([NPM_SOURCE], { temporary: true });
			expect(again.extensions.map((entry) => entry.path)).toEqual([extensionPath]);
			expect(toolCalls("npm ").length, "a verified cache must be reused, not reinstalled").toBe(npmCalls);
			expect(again.diagnostics).toEqual([]);
		});

		it("clones a git source into the private root and refreshes it on the next resolve", async () => {
			const installed = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });
			const extensionPath = installed.extensions[0]?.path;
			expect(extensionPath, "the clone must resolve an extension").toBeDefined();
			expect(extensionPath?.startsWith(join(root, `${CACHE_NAMESPACE}-`))).toBe(true);
			expect(installed.diagnostics).toEqual([]);
			const checkoutDir = dirname(dirname(extensionPath ?? ""));
			expect(toolCalls("git clone")).toHaveLength(1);

			const refreshed = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });
			expect(refreshed.extensions.map((entry) => entry.path)).toEqual([extensionPath]);
			const calls = toolCalls("git ");
			expect(calls.some((line) => line.startsWith("git fetch") && line.includes(`[cwd=${checkoutDir}]`))).toBe(true);
			expect(
				calls.some((line) => line.startsWith("git reset")),
				"local HEAD and upstream differ, so the refresh must reset the checkout",
			).toBe(true);
			expect(toolCalls("git clone"), "a verified checkout must be refreshed, not re-cloned").toHaveLength(1);
			expect(refreshed.diagnostics).toEqual([]);
		});

		it("keeps a verified checkout and leaves a visible diagnostic when the refresh fails", async () => {
			const installed = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });
			const extensionPath = installed.extensions[0]?.path;
			expect(extensionPath).toBeDefined();
			const callsBefore = toolCalls("git ").length;
			process.env.FAKE_GIT_FETCH_BEHAVIOR = "fail";

			const resolved = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });

			expect(
				toolCalls("git ").length,
				"the refresh must actually be attempted (and must not be skipped silently)",
			).toBeGreaterThan(callsBefore);
			expect(resolved.extensions.map((entry) => entry.path)).toEqual([extensionPath]);
			const warnings = resolved.diagnostics.filter((diagnostic) => diagnostic.type === "warning");
			expect(warnings.length, "a swallowed refresh failure is the bug under test").toBeGreaterThan(0);
			expect(warnings.map((warning) => warning.message).join("\n")).toMatch(/refresh failed/i);
			expect(statSync(extensionPath ?? "").isFile()).toBe(true);
		});

		it("does not refresh a pinned temporary git source prime-agent installed", async () => {
			const installed = await createManager().resolveExtensionSources([GIT_SOURCE], { temporary: true });
			expect(installed.extensions).toHaveLength(1);
			const before = readLog(toolLog).length;

			const resolved = await createManager().resolveExtensionSources([`${GIT_SOURCE}@main`], { temporary: true });

			expect(readLog(toolLog).slice(before)).toEqual([]);
			expect(resolved.diagnostics).toEqual([]);
			// A pinned ref selects a different cache entry, so it installs rather than reuses.
			expect(toolCalls("git clone")).toHaveLength(1);
		});
	});
});
