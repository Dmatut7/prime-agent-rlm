import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { readSessionInfo, type SessionHeader } from "../src/core/session-manager.js";

/**
 * These assertions deliberately touch nothing but `readSessionInfo` and the
 * filesystem, so they state the durable-summary contract from the outside: a
 * transcript scan leaves something behind that outlives the process.
 */
let agentDir = "";
let sessionsDir = "";
let outsideDir = "";
let savedAgentDirEnv: string | undefined;

function transcript(id: string, cwd: string): string {
	const header: SessionHeader = { type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd };
	const message = {
		type: "message",
		id: `${id}-entry-1`,
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "durable summary probe" }], timestamp: 1000 },
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

function cacheDir(): string {
	return join(agentDir, "session-info-cache");
}

function cacheEntries(): string[] {
	if (!existsSync(cacheDir())) return [];
	return readdirSync(cacheDir())
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(cacheDir(), name));
}

beforeEach(() => {
	savedAgentDirEnv = process.env[ENV_AGENT_DIR];
	agentDir = mkdtempSync(join(tmpdir(), "prime-durable-summary-"));
	outsideDir = mkdtempSync(join(tmpdir(), "prime-durable-outside-"));
	sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
});

describe("readSessionInfo durable summary", () => {
	it("leaves a summary behind that outlives the process that scanned", async () => {
		const path = join(sessionsDir, "durable-a.jsonl");
		writeFileSync(path, transcript("durable-a", "/tmp/project"), "utf8");

		const info = await readSessionInfo(path);
		expect(info?.messageCount).toBe(1);

		// Before the durable layer existed, a scan died with its process and the
		// next worker re-parsed every transcript from byte zero.
		expect(existsSync(cacheDir())).toBe(true);
		const entries = cacheEntries();
		expect(entries).toHaveLength(1);

		const parsed = JSON.parse(readFileSync(entries[0]!, "utf8")) as {
			info: { id: string; messageCount: number; path: string };
		};
		expect(parsed.info).toMatchObject({
			id: "durable-a",
			messageCount: 1,
			path,
		});
	});

	it("pins the summary to the exact transcript version it describes", async () => {
		const path = join(sessionsDir, "durable-b.jsonl");
		writeFileSync(path, transcript("durable-b", "/tmp/project"), "utf8");
		await readSessionInfo(path);
		const stats = statSync(path);

		const parsed = JSON.parse(readFileSync(cacheEntries()[0]!, "utf8")) as {
			fingerprint: { dev: number; ino: number; size: number; mtimeMs: number };
		};
		expect(parsed.fingerprint).toEqual({
			dev: stats.dev,
			ino: stats.ino,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});

		// A grown transcript must not be servable from that pin. The read in this
		// process stays correct through the incremental resume, and the durable
		// entry keeps describing the version it actually scanned: a stale pin is a
		// miss for the next process, never a wrong answer.
		writeFileSync(path, transcript("durable-b", "/tmp/project"), { flag: "a" });
		const grown = statSync(path);
		expect(grown.size).not.toBe(stats.size);
		const info = await readSessionInfo(path);
		expect(info?.messageCount).toBe(2);
		const pinned = JSON.parse(readFileSync(cacheEntries()[0]!, "utf8")) as {
			fingerprint: { size: number };
			info: { messageCount: number };
		};
		expect(pinned.fingerprint.size).toBe(stats.size);
		expect(pinned.info.messageCount).toBe(1);
	});

	it("writes nothing for a transcript outside the agent's own session roots", async () => {
		const path = join(outsideDir, "elsewhere.jsonl");
		writeFileSync(path, transcript("elsewhere", "/tmp/project"), "utf8");
		const info = await readSessionInfo(path);
		expect(info?.messageCount).toBe(1);
		expect(existsSync(cacheDir())).toBe(false);
	});
});
