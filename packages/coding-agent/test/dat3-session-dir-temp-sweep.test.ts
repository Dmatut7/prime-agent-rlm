import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { runMigrations } from "../src/migrations.js";

/**
 * DAT-3: a SIGKILL inside writePrivateFileAtomic's write window leaves its temp
 * (`.<name>.<pid>.<uuid>.tmp`) in the sessions directory forever - the finally that
 * removes it only runs while the process is alive. The auth store and the orphan
 * journal sweep their crash leftovers at startup; the sessions directory is the same
 * shape at transcript scale and now gets the same sweep.
 */

const staleTime = new Date(Date.now() - 10 * 60 * 1000);

function touch(path: string, mtime: Date): void {
	utimesSync(path, mtime, mtime);
}

describe("startup sweep of the sessions directory temp leftovers", () => {
	const roots: string[] = [];
	let previousAgentDir: string | undefined;
	let previousSessionDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousSessionDir = process.env[ENV_SESSION_DIR];
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env[ENV_SESSION_DIR];
		else process.env[ENV_SESSION_DIR] = previousSessionDir;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function setup(): { agentDir: string; sessionsDir: string } {
		const root = mkdtempSync(join(tmpdir(), "prime-dat3-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_SESSION_DIR] = sessionsDir;
		return { agentDir, sessionsDir };
	}

	it("removes a stale crash leftover at startup", () => {
		const { sessionsDir } = setup();
		const leftover = join(sessionsDir, ".01abc.12345.11111111-2222-3333-4444-555555555555.tmp");
		writeFileSync(leftover, "half a transcript\n");
		touch(leftover, staleTime);
		const session = join(sessionsDir, "01abc.jsonl");
		writeFileSync(session, "{}\n");

		runMigrations(process.cwd());

		expect(readdirSync(sessionsDir).includes(".01abc.12345.11111111-2222-3333-4444-555555555555.tmp")).toBe(false);
		// Real transcripts are untouched.
		expect(statSync(session).isFile()).toBe(true);
	});

	it("keeps a young temp: it may belong to a live concurrent writer", () => {
		const { sessionsDir } = setup();
		const young = join(sessionsDir, ".01live.12345.11111111-2222-3333-4444-555555555555.tmp");
		writeFileSync(young, "in flight\n");
		touch(young, new Date());

		runMigrations(process.cwd());

		expect(readdirSync(sessionsDir).includes(".01live.12345.11111111-2222-3333-4444-555555555555.tmp")).toBe(true);
	});

	it("never touches non-temp session files", () => {
		const { sessionsDir } = setup();
		const session = join(sessionsDir, "01keep.jsonl");
		const marker = join(sessionsDir, ".migrated-to-session-root");
		writeFileSync(session, "{}\n");
		writeFileSync(marker, "done\n");
		touch(marker, staleTime);

		runMigrations(process.cwd());

		expect(readdirSync(sessionsDir).sort()).toEqual([".migrated-to-session-root", "01keep.jsonl"]);
	});
});
