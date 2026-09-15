/**
 * R2 regression: the daemon catalog process appended to session transcripts with
 * neither a session lease nor a torn-tail repair.
 *
 * `SessionManager.open` stops reading at an unterminated trailing line (a
 * crash-torn append), but the catalog's appends went straight to appendFile, so
 * the new line was glued onto the torn fragment. The glued line no longer
 * parses, every reader skips it, and the write is silently lost: the archived
 * status never shows up in `readSessionInfo()` and the worker-recovery note
 * never appears in the transcript.
 *
 * The fix takes the session lease first, repairs the torn tail only under that
 * lease, appends, and releases in `finally` -- the same shape as the other
 * write-owning branches (main.ts:1798, daemon-mode.ts:1801). A transcript a
 * second live process owns is now refused loudly instead of being interleaved
 * with.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	acquireSessionLeaseAsync,
	SESSION_LEASES_ENABLED_ENV,
	type SessionLease,
} from "../../../src/core/session-lease.js";
import { CURRENT_SESSION_VERSION, readSessionInfo } from "../../../src/core/session-manager.js";
import { DaemonCatalogClient } from "../../../src/modes/daemon/daemon-catalog-process.js";

const SESSION_ID = "01r2-catalog-append";
/** Unparseable by construction: a crash left this append one byte short of a line. */
const TORN_TAIL = '{"type":"session_state","id":"state-torn","state":{"st';

interface TranscriptFacts {
	bytes: Buffer;
	lastLine: string;
	lastLineIsTerminated: boolean;
	lastEntry: Record<string, unknown> | undefined;
}

function readTranscriptFacts(sessionFile: string): TranscriptFacts {
	const bytes = readFileSync(sessionFile);
	const text = bytes.toString("utf8");
	const lines = text.split("\n").filter((line) => line.length > 0);
	const lastLine = lines.at(-1) ?? "";
	let lastEntry: Record<string, unknown> | undefined;
	try {
		lastEntry = JSON.parse(lastLine) as Record<string, unknown>;
	} catch {
		lastEntry = undefined;
	}
	return { bytes, lastLine, lastLineIsTerminated: text.endsWith("\n"), lastEntry };
}

describe("daemon catalog appends under a session lease", () => {
	const roots: string[] = [];
	const clients: DaemonCatalogClient[] = [];
	const leases: SessionLease[] = [];
	let previousAgentDir: string | undefined;

	afterEach(async () => {
		for (const lease of leases.splice(0)) {
			lease.release();
		}
		while (clients.length > 0) {
			await clients.pop()?.stop();
		}
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		previousAgentDir = undefined;
	});

	/** A real catalog subprocess whose agent dir is a throwaway root this test owns. */
	function startCatalog(): { client: DaemonCatalogClient; agentDir: string } {
		const agentDir = mkdtempSync(join(tmpdir(), "pa-r2-catalog-"));
		roots.push(agentDir);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		const client = new DaemonCatalogClient(() => {});
		clients.push(client);
		return { client, agentDir };
	}

	/** A transcript whose last line is unterminated, i.e. a crash-torn append. */
	function writeTornTranscript(agentDir: string, body: string[] = []): string {
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: SESSION_ID,
			timestamp: new Date().toISOString(),
			cwd: sessionDir,
		};
		writeFileSync(sessionFile, [JSON.stringify(header), ...body, TORN_TAIL].join("\n"));
		return sessionFile;
	}

	it("repairs a torn tail so the archive marker survives the append", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTornTranscript(agentDir);

		const archived = await client.archive(sessionFile, SESSION_ID);
		const info = await readSessionInfo(sessionFile);
		const facts = readTranscriptFacts(sessionFile);

		expect({
			archived,
			status: info?.state?.status ?? null,
			lastLineIsTerminated: facts.lastLineIsTerminated,
			lastEntryType: facts.lastEntry?.type ?? null,
		}).toEqual({
			archived: true,
			status: "archived",
			lastLineIsTerminated: true,
			lastEntryType: "session_state",
		});
		expect(facts.lastEntry?.state).toEqual({ status: "archived" });

		// The append releases the lease in `finally`: this process can take it now.
		const released = await acquireSessionLeaseAsync(sessionFile, agentDir, {
			...process.env,
			[SESSION_LEASES_ENABLED_ENV]: "1",
		});
		expect(released).toBeDefined();
		released?.release();
	}, 30_000);

	it("repairs a torn tail so the worker-recovery note survives the append", async () => {
		const { client, agentDir } = startCatalog();
		// The recovery note is a custom message, and message entries only persist
		// once the transcript has an assistant message.
		const assistantEntry = JSON.stringify({
			type: "message",
			id: "msg-assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		const sessionFile = writeTornTranscript(agentDir, [assistantEntry]);

		await client.markInterrupted(sessionFile, "active-r2", ["model_stream"]);
		const facts = readTranscriptFacts(sessionFile);

		expect({
			lastLineIsTerminated: facts.lastLineIsTerminated,
			lastEntryType: facts.lastEntry?.type ?? null,
			customType: facts.lastEntry?.customType ?? null,
			carriesInterruptedMarker: facts.lastLine.includes("prime_agent_worker_interrupted"),
		}).toEqual({
			lastLineIsTerminated: true,
			lastEntryType: "custom_message",
			customType: "prime-agent.worker_recovery",
			carriesInterruptedMarker: true,
		});
		expect(facts.lastEntry?.details).toEqual({ activeSessionId: "active-r2", operations: ["model_stream"] });
	}, 30_000);

	it("refuses to append while another live process holds the session lease", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTornTranscript(agentDir);
		// This test process stands in for the live session worker that owns the file.
		const lease = await acquireSessionLeaseAsync(sessionFile, agentDir, {
			...process.env,
			[SESSION_LEASES_ENABLED_ENV]: "1",
		});
		expect(lease).toBeDefined();
		leases.push(lease as SessionLease);

		const before = readFileSync(sessionFile);
		let archived: boolean | undefined;
		let refusal: string | undefined;
		try {
			archived = await client.archive(sessionFile, SESSION_ID);
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}
		const after = readFileSync(sessionFile);

		expect({
			archived,
			refused: refusal !== undefined,
			bytesUnchanged: Buffer.compare(before, after) === 0,
		}).toEqual({ archived: undefined, refused: true, bytesUnchanged: true });
		expect(refusal).toMatch(/already active/i);
	}, 30_000);
});
