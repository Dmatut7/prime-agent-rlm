/**
 * Legacy credential stores: every name an older version could have left a copy of
 * the OAuth/api-key store under, and how to get rid of them.
 *
 * The live store is `auth.json`; older versions used `oauth.json`, and the startup
 * migration renamed that file to `oauth.json.migrated` instead of removing it.
 * Nothing reads those names back, so a copy that survives a logout is a refresh
 * token that outlives `/logout` — and the renamed copy kept the legacy 0644 mode,
 * which made it readable by every account on the machine.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { removePrivateFile, tightenPrivateFileMode } from "../utils/private-files.js";

/** The one credential store current versions read and write. */
const LIVE_AUTH_STORE_FILE_NAME = "auth.json";

/**
 * `oauth.json` / `auth.json` plus any dotted suffix (`.migrated`, `.bak`, `.old`,
 * a dated `oauth.json.migrated.2026-09-14`, ...) and the atomic writer's crash
 * leftovers, whose temp names are `.<name>.<pid>.<uuid>.tmp`.
 *
 * Kept as a name family instead of "every `*.json` in the directory" so a logout
 * never deletes a user-authored file; the suffix is deliberately open-ended because
 * the renames older versions performed are exactly what this cleanup is for.
 */
function isLegacyTokenStoreName(name: string): boolean {
	if (name === LIVE_AUTH_STORE_FILE_NAME) return false;
	// proper-lockfile's `<auth.json>.lock` directory guards the live store.
	if (name.endsWith(".lock")) return false;
	return /^\.?(?:oauth|auth)\.json(?:\.[A-Za-z0-9_.-]+)*$/.test(name);
}

/** Token-bearing copies in `agentDir` that no code path reads back. */
export function findLegacyTokenStores(agentDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(agentDir);
	} catch {
		return [];
	}
	return names
		.filter(isLegacyTokenStoreName)
		.map((name) => join(agentDir, name))
		.sort();
}

/**
 * Delete every left-over credential copy in `agentDir`, except the paths in
 * `keep` (which are tightened to 0600 instead — a kept copy is one whose contents
 * are not committed anywhere else yet, e.g. an unreadable `oauth.json` that is the
 * only trace of a login).
 *
 * Throws when a copy it was asked to delete survives: the caller is about to report
 * a logout, and a silent leftover is the bug this exists to prevent.
 */
export function purgeLegacyTokenStores(agentDir: string, options: { keep?: Iterable<string> } = {}): string[] {
	const keep = new Set(options.keep ?? []);
	const removed: string[] = [];
	const failed: string[] = [];
	for (const path of findLegacyTokenStores(agentDir)) {
		if (keep.has(path)) {
			try {
				tightenPrivateFileMode(path);
			} catch {
				// Best effort: the contents are the caller's problem, and a mode it cannot
				// repair must not turn into a failed migration.
			}
			continue;
		}
		try {
			if (removePrivateFile(path)) removed.push(path);
		} catch (error) {
			failed.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	if (failed.length > 0) {
		throw new Error(`Could not remove legacy credential file(s): ${failed.join(", ")}`);
	}
	return removed;
}

/** Provider entries of a legacy store, or undefined when it cannot be read as one. */
export function readLegacyTokenStore(path: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** One MiB: the state directory's own files are small; anything larger is not a store copy. */
const SECRET_SWEEP_MAX_BYTES = 1024 * 1024;

/**
 * Values that are references to a secret rather than the secret itself, or short
 * enough to occur in unrelated text: sweeping for them would fail a logout that
 * actually worked.
 */
function isSweepableSecret(value: string): boolean {
	if (value.length < 16) return false;
	if (value.startsWith("!")) return false;
	return !/^[A-Z][A-Z0-9_]*$/.test(value);
}

/**
 * Files holding one of `secrets` verbatim, searched over the top-level regular
 * files of `agentDir`.
 *
 * A logout deletes the copies whose names it knows; this is what turns "we removed
 * them" into "we checked". The sweep is bounded to the state directory's own files
 * (not the session or log subdirectories, which hold tool output rather than
 * credentials) and to values that are secrets of their own right, so it can fail a
 * logout only for a copy that really is one.
 */
export function findFilesHoldingSecrets(agentDir: string, secrets: Iterable<string>): string[] {
	const needles = [...secrets].filter(isSweepableSecret).map((secret) => Buffer.from(secret, "utf-8"));
	if (needles.length === 0) return [];

	let entries: Dirent[];
	try {
		entries = readdirSync(agentDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const hits: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(agentDir, entry.name);
		try {
			if (statSync(path).size > SECRET_SWEEP_MAX_BYTES) continue;
			const bytes = readFileSync(path);
			if (needles.some((needle) => bytes.includes(needle))) hits.push(path);
		} catch {
			// Unreadable file: it cannot be reported as holding the secret.
		}
	}
	return hits.sort();
}
