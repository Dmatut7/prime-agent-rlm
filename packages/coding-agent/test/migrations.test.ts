import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	migrateAuthToAuthJson,
	migrateLegacySessionDirsToSessionRoot,
	migrateSessionsFromAgentRoot,
} from "../src/migrations.js";

/** Must match LEGACY_DIR_MIGRATION_MARKER in src/migrations.ts (a durable on-disk name). */
const LEGACY_DIR_MARKER = ".migrated-to-session-root";
/** The retry case is built from a directory permission denial: root bypasses it, Windows chmod does not model it. */
const permissionDenialIsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

function sessionJsonl(id: string): string {
	const lines = [
		{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp/project" },
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hello", timestamp: Date.now() },
		},
	];
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("session migrations", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("moves legacy per-cwd session files into the flat session root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-1.jsonl");
		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		];
		writeFileSync(legacyFile, `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		migrateLegacySessionDirsToSessionRoot();

		const migratedFile = join(sessionsDir, "session-1.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(existsSync(legacyDir)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-1"');
	});

	it("marks a legacy dir whose duplicate is already in the flat root, so the pass runs once", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-dup.jsonl");
		const flatCopy = join(sessionsDir, "session-dup.jsonl");
		const body = sessionJsonl("session-dup");
		writeFileSync(legacyFile, body);
		writeFileSync(flatCopy, body);

		migrateLegacySessionDirsToSessionRoot();

		// The identical legacy copy is deliberately left alone, so the dir has to be
		// marked done: otherwise every startup re-walks it and re-reads both copies
		// in full to reach the same "already migrated" verdict.
		expect(existsSync(legacyFile)).toBe(true);
		expect(readdirSync(legacyDir)).toContain(LEGACY_DIR_MARKER);

		// Marked means done: even with the flat copy gone, a later run must not move
		// the legacy file up again.
		rmSync(flatCopy);
		migrateLegacySessionDirsToSessionRoot();
		expect(existsSync(legacyFile)).toBe(true);
		expect(existsSync(flatCopy)).toBe(false);
	});

	it("marks a legacy dir holding files it can never migrate", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-other--");
		mkdirSync(join(legacyDir, "sub-0a1b2c3d"), { recursive: true });
		const strayFile = join(legacyDir, "not-a-session.jsonl");
		writeFileSync(strayFile, "garbage\n");

		migrateLegacySessionDirsToSessionRoot();

		// The dir can never be emptied, so it must not be re-walked on every startup.
		expect(existsSync(strayFile)).toBe(true);
		expect(readdirSync(legacyDir)).toContain(LEGACY_DIR_MARKER);
	});

	it.runIf(permissionDenialIsEnforced)("retries a legacy dir whose session file could not be moved", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-retry--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-retry.jsonl");
		writeFileSync(legacyFile, sessionJsonl("session-retry"));

		chmodSync(legacyDir, 0o500);
		try {
			migrateLegacySessionDirsToSessionRoot();

			// A move that did not happen is unfinished work, not a leftover to skip.
			expect(existsSync(legacyFile)).toBe(true);
			expect(readdirSync(legacyDir)).not.toContain(LEGACY_DIR_MARKER);
		} finally {
			chmodSync(legacyDir, 0o700);
		}

		migrateLegacySessionDirsToSessionRoot();

		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(join(sessionsDir, "session-retry.jsonl"), "utf8")).toContain('"id":"session-retry"');
		expect(existsSync(legacyDir)).toBe(false);
	});

	it("moves root session files using only the JSONL header", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const legacyFile = join(agentDir, "session-root.jsonl");
		writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-root",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n${"x".repeat(128 * 1024)}\n`,
		);

		migrateSessionsFromAgentRoot();

		const migratedFile = join(agentDir, "sessions", "session-root.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-root"');
	});

	it("does not move session files from non-legacy subdirectories", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const nonLegacyDir = join(sessionsDir, "exports");
		mkdirSync(nonLegacyDir, { recursive: true });
		const nestedFile = join(nonLegacyDir, "session-2.jsonl");
		writeFileSync(
			nestedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n`,
		);

		migrateLegacySessionDirsToSessionRoot();

		expect(existsSync(nestedFile)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-2.jsonl"))).toBe(false);
	});
});

describe("auth store migration", () => {
	const ACCESS_SECRET = "LEGACY-ACCESS-SECRET-abc123def456";
	const REFRESH_SECRET = "LEGACY-REFRESH-SECRET-xyz789uvw012";
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function newAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		return agentDir;
	}

	function writeLegacyStore(agentDir: string, name: string, content: string): string {
		const path = join(agentDir, name);
		writeFileSync(path, content, { mode: 0o644 });
		return path;
	}

	function topLevelFiles(agentDir: string): string[] {
		return readdirSync(agentDir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(agentDir, entry.name));
	}

	function filesHolding(agentDir: string, secret: string): string[] {
		return topLevelFiles(agentDir).filter((path) => readFileSync(path, "utf-8").includes(secret));
	}

	function oauthStoreJson(): string {
		return JSON.stringify({ "openai-codex": { access: ACCESS_SECRET, refresh: REFRESH_SECRET } }, null, 2);
	}

	it("moves legacy credentials without leaving a world-readable copy behind", () => {
		const agentDir = newAgentDir();
		const oauthPath = writeLegacyStore(agentDir, "oauth.json", oauthStoreJson());

		const providers = migrateAuthToAuthJson();

		const authPath = join(agentDir, "auth.json");
		expect(providers).toEqual(["openai-codex"]);
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(false);
		expect(readFileSync(authPath, "utf-8")).toContain(REFRESH_SECRET);
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(filesHolding(agentDir, REFRESH_SECRET)).toEqual([authPath]);
	});

	it("still migrates settings.json apiKeys alongside a legacy oauth.json", () => {
		const agentDir = newAgentDir();
		writeLegacyStore(agentDir, "oauth.json", oauthStoreJson());
		writeLegacyStore(
			agentDir,
			"settings.json",
			JSON.stringify({ theme: "dark", apiKeys: { anthropic: "sk-ant-legacy-key-000111" } }, null, 2),
		);

		expect(migrateAuthToAuthJson().sort()).toEqual(["anthropic", "openai-codex"]);

		const migrated = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<string, unknown>;
		expect(migrated.anthropic).toEqual({ type: "api_key", key: "sk-ant-legacy-key-000111" });
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
		expect(settings.apiKeys).toBeUndefined();
		expect(settings.theme).toBe("dark");
	});

	it("clears the renamed copy an older version left behind", () => {
		const agentDir = newAgentDir();
		const authPath = join(agentDir, "auth.json");
		// The live store can be world-readable: another tool wrote it without the
		// private-file helpers. The migration sees it and must not leave it that way.
		writeFileSync(authPath, oauthStoreJson(), { mode: 0o644 });
		const leftoverPath = writeLegacyStore(agentDir, "oauth.json.migrated", oauthStoreJson());

		migrateAuthToAuthJson();

		expect(existsSync(leftoverPath)).toBe(false);
		expect(readFileSync(authPath, "utf-8")).toContain(REFRESH_SECRET);
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
	});

	it("deletes unreadable legacy copies once the live store exists, and never returns them", () => {
		const agentDir = newAgentDir();
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "k" } }), {
			mode: 0o600,
		});
		// Truncated mid-write: unreadable as a store, but the token bytes are in it.
		writeLegacyStore(agentDir, "oauth.json.migrated", `{"openai-codex":{"access":"${ACCESS_SECRET}"`);

		migrateAuthToAuthJson();

		expect(filesHolding(agentDir, ACCESS_SECRET)).toEqual([]);
		expect(existsSync(join(agentDir, "oauth.json.migrated"))).toBe(false);
	});

	it("keeps the one legacy store it could not read, tightened to 0600", () => {
		const agentDir = newAgentDir();
		const oauthPath = writeLegacyStore(agentDir, "oauth.json", `{"openai-codex":{"access":"${ACCESS_SECRET}"`);

		migrateAuthToAuthJson();

		// The only copy of a possibly recoverable credential must survive, but not as
		// a file other accounts on the machine can read.
		expect(existsSync(oauthPath)).toBe(true);
		expect(statSync(oauthPath).mode & 0o777).toBe(0o600);
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
	});
});
