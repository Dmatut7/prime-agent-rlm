import { existsSync, readFileSync } from "node:fs";
import type { OAuthCredentials } from "./oauth/types.js";
import { writePrivateFileAtomic } from "./private-file.js";

/**
 * auth.json store for the pi-ai login CLI: one record per OAuth provider.
 * Written 0600 through the private-file helper (A10 hardening: the previous
 * bare writeFileSync landed the credentials world-readable and followed a
 * symlink placed at the file's path).
 */

export type AuthRecord = Record<string, { type: "oauth" } & OAuthCredentials>;

export const AUTH_FILE = "auth.json";

export function loadAuth(path: string = AUTH_FILE): AuthRecord {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

export function saveAuth(auth: AuthRecord, path: string = AUTH_FILE): void {
	// 0600, symlink-refusing, atomic replace (see writePrivateFileAtomic).
	writePrivateFileAtomic(path, JSON.stringify(auth, null, 2));
}
