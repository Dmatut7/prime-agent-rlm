import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { migrateLegacySessionDirsToSessionRoot, migrateSessionsFromAgentRoot } from "../src/migrations.js";

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
