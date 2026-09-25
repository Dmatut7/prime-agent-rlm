/**
 * mark_crashed: the catalog command that writes the session_state crash marker
 * for sessions that died abnormally (power loss, kill, dead worker) so the
 * agents view can park them in Idle instead of History.
 *
 * Mirrors the archive command's write discipline (session lease, torn-tail
 * repair, session-id guard) with crash-specific semantics:
 * - writes {status:"crash"} over active/absent state;
 * - never overwrites a manual archive;
 * - idempotent once the marker is present;
 * - refuses the write while another live process holds the session lease.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { acquireSessionLeaseAsync, SESSION_LEASES_ENABLED_ENV, type SessionLease } from "../src/core/session-lease.js";
import { CURRENT_SESSION_VERSION, readSessionInfo } from "../src/core/session-manager.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

const SESSION_ID = "01d-catalog-crash-marker";
/** Unparseable by construction: a crash left this append one byte short of a line. */
const TORN_TAIL = '{"type":"session_state","id":"state-torn","state":{"st';

describe("daemon catalog mark_crashed", () => {
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

	function startCatalog(): { client: DaemonCatalogClient; agentDir: string } {
		const agentDir = mkdtempSync(join(tmpdir(), "pa-d-catalog-crash-"));
		roots.push(agentDir);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		const client = new DaemonCatalogClient(() => {});
		clients.push(client);
		return { client, agentDir };
	}

	function writeTranscript(agentDir: string, extraLines: string[] = []): string {
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: SESSION_ID,
			timestamp: new Date().toISOString(),
			cwd: sessionDir,
		});
		writeFileSync(sessionFile, [header, ...extraLines].join("\n") + "\n");
		return sessionFile;
	}

	function writeTornTranscript(agentDir: string): string {
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: SESSION_ID,
			timestamp: new Date().toISOString(),
			cwd: sessionDir,
		});
		writeFileSync(sessionFile, [header, TORN_TAIL].join("\n"));
		return sessionFile;
	}

	it("writes the crash marker over an active session and stays idempotent", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTranscript(agentDir);

		const first = await client.markCrashed(sessionFile, SESSION_ID);
		expect(first).toBe(true);
		expect((await readSessionInfo(sessionFile))?.state?.status).toBe("crash");

		const before = readFileSync(sessionFile);
		const second = await client.markCrashed(sessionFile, SESSION_ID);
		const after = readFileSync(sessionFile);
		expect(second).toBe(true);
		expect((await readSessionInfo(sessionFile))?.state?.status).toBe("crash");
		expect(Buffer.compare(before, after)).toBe(0);
	}, 30_000);

	it("never overwrites a manual archive", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTranscript(agentDir);
		// The user archived this session by hand; an abnormal-death marker must
		// not turn it back into a recoverable row.
		expect(await client.archive(sessionFile, SESSION_ID)).toBe(true);

		const crashed = await client.markCrashed(sessionFile, SESSION_ID);
		expect(crashed).toBe(false);
		expect((await readSessionInfo(sessionFile))?.state?.status).toBe("archived");
	}, 30_000);

	it("refuses a session id mismatch and leaves the file untouched", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTranscript(agentDir);
		const before = readFileSync(sessionFile);

		const crashed = await client.markCrashed(sessionFile, "some-replacement-session");
		expect(crashed).toBe(false);
		expect(Buffer.compare(before, readFileSync(sessionFile))).toBe(0);
		expect((await readSessionInfo(sessionFile))?.state?.status).toBeUndefined();
	}, 30_000);

	it("repairs a crash-torn tail so the crash marker survives the append", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTornTranscript(agentDir);

		const crashed = await client.markCrashed(sessionFile, SESSION_ID);
		const info = await readSessionInfo(sessionFile);
		const text = readFileSync(sessionFile).toString("utf8");

		expect(crashed).toBe(true);
		expect(info?.state?.status).toBe("crash");
		expect(text.endsWith("\n")).toBe(true);
		expect(
			text
				.split("\n")
				.filter((line) => line.length > 0)
				.at(-1),
		).toContain('"crash"');
	}, 30_000);

	it("refuses to append while another live process holds the session lease", async () => {
		const { client, agentDir } = startCatalog();
		const sessionFile = writeTranscript(agentDir);
		const lease = await acquireSessionLeaseAsync(sessionFile, agentDir, {
			...process.env,
			[SESSION_LEASES_ENABLED_ENV]: "1",
		});
		expect(lease).toBeDefined();
		leases.push(lease as SessionLease);

		const before = readFileSync(sessionFile);
		let crashed: boolean | undefined;
		let refusal: string | undefined;
		try {
			crashed = await client.markCrashed(sessionFile, SESSION_ID);
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}

		expect({
			crashed,
			refused: refusal !== undefined,
			bytesUnchanged: Buffer.compare(before, readFileSync(sessionFile)) === 0,
		}).toEqual({
			crashed: undefined,
			refused: true,
			bytesUnchanged: true,
		});
		expect(refusal).toMatch(/already active/i);
	}, 30_000);
});
