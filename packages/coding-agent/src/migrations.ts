/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { basename, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir, getSessionsDir } from "./config.js";
import { FileAuthStorageBackend } from "./core/auth-storage.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";
import { findLegacyTokenStores, purgeLegacyTokenStores, readLegacyTokenStore } from "./core/legacy-auth-files.js";
import { readFirstLineSync } from "./utils/file-lines.js";
import { tightenPrivateFileMode, writePrivateFileAtomic } from "./utils/private-files.js";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json, then delete the
 * legacy stores.
 *
 * What may be deleted is decided on the live store's contents, never on whether
 * auth.json exists: any read through AuthStorage writes `{}`, so a store can be present
 * while holding nobody's credentials. A legacy store goes only once every provider it
 * lists is readable back from auth.json - which means the providers it lacks are merged
 * in first - and a store that still holds an uncommitted provider is kept (tightened to
 * 0600) and reported.
 *
 * The legacy copies are deleted rather than renamed: `oauth.json.migrated` was a second,
 * world-readable copy of every token (see legacy-auth-files.ts), and this migration is
 * the only chance to remove one that an older version already left behind. A file that
 * never parses as a store is a torn copy rather than the trace of a login, so there is
 * nothing to take over from it; it survives only while no live store exists at all.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// A live store that exists but does not parse commits nothing, and merging into it
	// would overwrite bytes the user may still repair: keep the legacy files and say so.
	if (existsSync(authPath) && !readStore(authPath)) {
		return keepLegacyStores(agentDir, `${authPath} is not a readable credential store`);
	}

	const live = readStore(authPath) ?? {};
	const additions: Record<string, unknown> = {};
	// oauth.json is read first so a legacy api key can never shadow an OAuth login.
	for (const [provider, credential] of Object.entries(readStore(oauthPath) ?? {})) {
		if (!(provider in live)) additions[provider] = { type: "oauth", ...(credential as object) };
	}
	for (const [provider, key] of Object.entries(readSettingsApiKeys(settingsPath) ?? {})) {
		if (typeof key === "string" && !(provider in live) && !(provider in additions)) {
			additions[provider] = { type: "api_key", key };
		}
	}

	// Re-read after the write: what proves a credential was taken over is what auth.json
	// holds on disk now, not what this pass meant to put into it.
	const committed = Object.keys(additions).length > 0 ? commitCredentialAdditions(authPath, additions) : live;
	if (!committed) {
		return keepLegacyStores(agentDir, `${authPath} could not be updated`);
	}
	const providers = Object.keys(additions).filter((provider) => provider in committed);
	releaseSettingsApiKeys(settingsPath, committed);

	const keep = legacyStoresNotCommittedIn(agentDir, committed, existsSync(authPath));
	if (keep.length > 0) {
		console.error(
			chalk.yellow(
				`Warning: kept legacy credential ${keep.length === 1 ? "store" : "stores"} ${keep
					.map((path) => basename(path))
					.join(", ")}: it holds a provider that ${basename(authPath)} does not.`,
			),
		);
	}

	privatizeLiveStore(authPath);
	removeSupersededLegacyStores(agentDir, keep);

	return providers;
}

/** A credential store's entries, or undefined when the file is absent or is not one. */
function readStore(path: string): Record<string, unknown> | undefined {
	return existsSync(path) ? readLegacyTokenStore(path) : undefined;
}

/** The shape test AuthStorage itself uses: a JSON object of provider entries. */
function parseStore(content: string | undefined): Record<string, unknown> | undefined {
	if (!content) return {};
	try {
		const parsed = JSON.parse(content) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Nothing could be committed, so every legacy store survives this pass (the purge
 * tightens what it keeps) with one warning naming the reason.
 */
function keepLegacyStores(agentDir: string, reason: string): string[] {
	console.error(
		chalk.yellow(`Warning: no credentials were migrated because ${reason}; legacy credential stores were kept.`),
	);
	privatizeLiveStore(join(agentDir, "auth.json"));
	removeSupersededLegacyStores(agentDir, findLegacyTokenStores(agentDir));
	return [];
}

/**
 * Add the missing entries to the live store and return what it holds on disk afterwards,
 * or undefined when nothing can be trusted. The merge is a read-modify-write on a file a
 * running session writes too, so it goes through the same `<auth.json>.lock` AuthStorage
 * uses: a store that will not free, or a write that fails, commits nothing. A provider
 * the live store already lists is never overwritten - its credential is the current one.
 */
function commitCredentialAdditions(
	authPath: string,
	additions: Record<string, unknown>,
): Record<string, unknown> | undefined {
	try {
		new FileAuthStorageBackend(authPath).withLock((current) => {
			const stored = parseStore(current);
			if (!stored) return { result: undefined };
			const merged: Record<string, unknown> = { ...stored };
			for (const [provider, credential] of Object.entries(additions)) {
				if (!(provider in merged)) merged[provider] = credential;
			}
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	} catch (error) {
		console.error(
			chalk.yellow(
				`Warning: could not migrate credentials to ${authPath}: ${error instanceof Error ? error.message : error}`,
			),
		);
	}
	// The read-back is the proof: an entry that did not survive the write cannot be
	// reported as migrated, and the store it is missing from cannot be deleted.
	return readStore(authPath);
}

/** The legacy `settings.json` apiKeys block, or undefined when there is nothing to take. */
function readSettingsApiKeys(settingsPath: string): Record<string, unknown> | undefined {
	const apiKeys = readStore(settingsPath)?.apiKeys;
	if (typeof apiKeys !== "object" || apiKeys === null || Array.isArray(apiKeys)) return undefined;
	return apiKeys as Record<string, unknown>;
}

/**
 * Drop the apiKeys entries the live store now carries. Anything else stays: removing a
 * key that was never committed is the loss this migration exists to prevent.
 */
function releaseSettingsApiKeys(settingsPath: string, committed: Record<string, unknown>): void {
	const apiKeys = readSettingsApiKeys(settingsPath);
	if (!apiKeys) return;

	const settings = readStore(settingsPath);
	if (!settings) return;
	const retained: Record<string, unknown> = {};
	let released = 0;
	for (const [provider, key] of Object.entries(apiKeys)) {
		if (typeof key === "string" && provider in committed) {
			released += 1;
		} else {
			retained[provider] = key;
		}
	}
	if (released === 0) return;
	if (Object.keys(retained).length > 0) settings.apiKeys = retained;
	else delete settings.apiKeys;

	try {
		// Same private atomic write as every other credential write: a crash here used to
		// leave a truncated settings.json behind.
		writePrivateFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
	} catch (error) {
		console.error(
			chalk.yellow(
				`Warning: could not clear migrated apiKeys from ${settingsPath}: ${error instanceof Error ? error.message : error}`,
			),
		);
	}
}

/**
 * Legacy copies still holding a provider the live store does not have. An empty copy is a
 * copy of nothing, so it does not block the cleanup; a copy that never parsed is only the
 * trace of a login while there is no live store to have taken it over.
 */
function legacyStoresNotCommittedIn(
	agentDir: string,
	committed: Record<string, unknown>,
	liveStoreExists: boolean,
): string[] {
	return findLegacyTokenStores(agentDir).filter((path) => {
		const entries = readStore(path);
		if (!entries) return !liveStoreExists;
		return Object.keys(entries).some((provider) => !(provider in committed));
	});
}

/**
 * Tighten the live store when it already exists. This code writes it 0600 through
 * the private-file helpers, but a store left by another tool (or an older version)
 * can still be world-readable, and the migration is the one pass that sees it
 * without having to trust the caller.
 */
function privatizeLiveStore(authPath: string): void {
	if (!existsSync(authPath)) return;
	try {
		tightenPrivateFileMode(authPath);
	} catch (error) {
		console.error(
			chalk.yellow(`Warning: could not tighten ${authPath}: ${error instanceof Error ? error.message : error}`),
		);
	}
}

/**
 * Delete credential stores that no code path reads any more. A startup must not die
 * on a credential copy, so a failed removal is reported instead of thrown; logout is
 * the path that refuses to report success while a token copy survives.
 */
function removeSupersededLegacyStores(agentDir: string, keep: string[]): void {
	try {
		purgeLegacyTokenStores(agentDir, { keep });
	} catch (error) {
		console.error(chalk.yellow(`Warning: ${error instanceof Error ? error.message : error}`));
	}
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to the session root.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/. This migration moves them to the configured
 * session root.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const firstLine = readFirstLineSync(file);
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session") continue;

			const correctDir = getSessionsDir(agentDir);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const newPath = join(correctDir, basename(file));

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

type SessionFileProbe = "session" | "other" | "unreadable";

/**
 * Classify a candidate by its JSONL header only. `unreadable` means the header
 * could not be read at all, which says nothing about the file's content: the
 * caller must not fold it into the permanent leftovers it marks as done.
 */
function probeSessionJsonlFile(filePath: string): SessionFileProbe {
	let firstLine: string | undefined;
	try {
		firstLine = readFirstLineSync(filePath);
	} catch {
		return "unreadable";
	}
	try {
		if (!firstLine?.trim()) {
			return "other";
		}
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string" ? "session" : "other";
	} catch {
		return "other";
	}
}

function isLegacySessionDirName(name: string): boolean {
	return /^--.+--$/.test(name);
}

/**
 * Written into a legacy dir this migration has already drained as far as it can,
 * so later startups skip it instead of re-reading every file inside again.
 */
const LEGACY_DIR_MIGRATION_MARKER = ".migrated-to-session-root";

function isLegacyDirMigrationMarked(legacyDir: string): boolean {
	return existsSync(join(legacyDir, LEGACY_DIR_MIGRATION_MARKER));
}

function markLegacyDirMigrationDone(legacyDir: string): void {
	try {
		writeFileSync(join(legacyDir, LEGACY_DIR_MIGRATION_MARKER), `${new Date().toISOString()}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {
		// Best-effort: without the marker the next startup simply repeats this pass.
	}
}

/**
 * Migrate legacy per-cwd session directories into the flat session root.
 *
 * Older versions stored sessions under ~/.prime/agent/sessions/--cwd--/*.jsonl.
 * The daemon list/continue paths now scan the flat session root, so move any
 * existing nested JSONL session files up one level. A dir that cannot be fully
 * drained is marked done, so each legacy dir is walked at most once.
 */
export function migrateLegacySessionDirsToSessionRoot(): void {
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);

	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isLegacySessionDirName(entry.name)) {
			continue;
		}

		const legacyDir = join(sessionsDir, entry.name);
		if (isLegacyDirMigrationMarked(legacyDir)) {
			continue;
		}
		let files: string[];
		try {
			files = readdirSync(legacyDir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}

		let unfinished = false;
		for (const file of files) {
			const oldPath = join(legacyDir, file);
			let newPath = join(sessionsDir, file);
			const probe = probeSessionJsonlFile(oldPath);
			if (probe !== "session") {
				if (probe === "unreadable") {
					// An unreadable header may be a transient failure, so keep the dir
					// unmarked and let the next startup try again.
					unfinished = true;
				}
				continue;
			}
			if (existsSync(newPath)) {
				if (filesHaveSameContent(oldPath, newPath)) {
					// Already migrated; leave the legacy copy alone.
					continue;
				}
				// A different session shares the basename; move it under a unique name
				// so it stays discoverable by the flat-root list and continue paths.
				newPath = uniqueSessionRootPath(sessionsDir, file);
			}
			try {
				renameSync(oldPath, newPath);
			} catch {
				// Leave the legacy file in place if it cannot be moved.
				unfinished = true;
			}
		}

		try {
			if (readdirSync(legacyDir).length === 0) {
				rmdirSync(legacyDir);
			} else if (!unfinished) {
				// Only leftovers this migration can never move remain (non-session
				// files, nested dirs, a duplicate already in the flat root). Mark the
				// dir so this pass, and its full-file content compares, run once.
				markLegacyDirMigrationDone(legacyDir);
			}
		} catch {
			// Ignore cleanup errors; migrated files are already in the flat root.
		}
	}
}

function filesHaveSameContent(a: string, b: string): boolean {
	try {
		if (statSync(a).size !== statSync(b).size) {
			return false;
		}
		return readFileSync(a, "utf-8") === readFileSync(b, "utf-8");
	} catch {
		return false;
	}
}

function uniqueSessionRootPath(sessionsDir: string, file: string): string {
	const base = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
	for (let n = 1; ; n++) {
		const candidate = join(sessionsDir, `${base}-${n}.jsonl`);
		if (!existsSync(candidate)) {
			return candidate;
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	if (!process.stdin.isTTY) {
		// A non-interactive parent never delivers the keypress; don't hang waiting for it.
		console.log();
		return;
	}
	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Sweep the sessions directory for the atomic writer's crash leftovers.
 *
 * `writePrivateFileAtomic`/`writePrivateFileAtomicLines` write their temp file
 * (`.<name>.<pid>.<uuid>.tmp`) into the target's own directory and remove it in a
 * `finally` that only runs while the process is alive: a SIGKILL mid-write leaves the
 * temp behind forever, and in the sessions directory one temp can hold an entire
 * transcript. The auth store (legacy-auth-files.ts) and the orphan journal already
 * sweep their crash leftovers at startup; this is the same pass for the sessions
 * directory. Only temps old enough that no live writer can still own one are removed -
 * a young temp may be an in-flight write by a concurrent session process.
 *
 * @returns Number of stale temps removed.
 */
export function sweepStaleSessionDirTemps(agentDir: string = getAgentDir()): number {
	const sessionsDir = getSessionsDir(agentDir);
	const cutoff = Date.now() - STALE_SESSION_TEMP_MAX_AGE_MS;
	let names: string[];
	try {
		names = readdirSync(sessionsDir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		// The writer's temp family: a dot-prefixed name ending in ".tmp". Session
		// transcripts and legacy dirs never match, so user-visible files are safe.
		if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
		const tempPath = join(sessionsDir, name);
		try {
			if (statSync(tempPath).mtimeMs >= cutoff) continue;
			rmSync(tempPath, { force: true });
			removed++;
		} catch {
			// A temp that vanished or turned unreadable mid-sweep is already gone.
		}
	}
	return removed;
}

const STALE_SESSION_TEMP_MAX_AGE_MS = 60_000;

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateLegacySessionDirsToSessionRoot();
	sweepStaleSessionDirTemps();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
