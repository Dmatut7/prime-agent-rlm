import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import * as sessionManagerModule from "../src/core/session-manager.js";
import { RlmSpawnLedger, withPassiveRlmDescendantInfos } from "../src/modes/daemon/rlm-ledger.js";

const { SessionManager } = sessionManagerModule;

const CHILD_COUNT = 8;
let tempDir = "";
let savedAgentDirEnv: string | undefined;
let readSpy: ReturnType<typeof vi.spyOn> | undefined;

function makeChild(artifactDir: string, parentFile: string, name: string) {
	mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(tempDir, artifactDir);
	manager.newSession({ parentSession: parentFile, rlmDepth: 1 });
	manager.appendSessionInfo(name);
	manager.appendMessage({ role: "user", content: `question for ${name}`, timestamp: 1 });
	manager.flushNow();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing child session file");
	return { manager, file };
}

async function makeFixture() {
	const sessionsDir = join(tempDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	const parent = SessionManager.create(tempDir, sessionsDir);
	parent.newSession();
	parent.appendSessionInfo("root");
	parent.appendMessage({ role: "user", content: "root question", timestamp: 1 });
	parent.flushNow();
	const parentFile = parent.getSessionFile();
	if (!parentFile) throw new Error("Missing parent session file");
	const parentArtifactDir = parent.getSessionArtifactDir();
	if (!parentArtifactDir) throw new Error("Missing parent artifact directory");

	const ledger = new RlmSpawnLedger(tempDir, sessionsDir);
	const children: Array<{ name: string; file: string; id: string }> = [];
	for (let index = 0; index < CHILD_COUNT; index++) {
		const name = `worker-${index}`;
		const child = makeChild(join(parentArtifactDir, `sub-${index}0000000`), parentFile, name);
		await ledger.appendSpawn({
			childId: `sub-${index}0000000`,
			parent: parentFile,
			child: child.file,
			depth: 1,
			name,
		});
		children.push({ name, file: child.file, id: child.manager.getSessionId() });
	}
	const parentInfo = await sessionManagerModule.readSessionInfo(parentFile);
	if (!parentInfo) throw new Error("Missing parent session info");
	return { sessionsDir, ledger, parentFile, parentInfo, children };
}

/**
 * Counts how many transcript reads are in flight at once. The serial walk this
 * replaced could only ever reach 1, which is the whole defect: 450 independent
 * reads, one event-loop round trip apart, on the path that opens the agents view.
 */
function spyOnReadSessionInfo(gateMs: number) {
	const original = sessionManagerModule.readSessionInfo;
	let inFlight = 0;
	let peak = 0;
	readSpy = vi.spyOn(sessionManagerModule, "readSessionInfo").mockImplementation(async (filePath: string) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, gateMs));
		try {
			return await original(filePath);
		} finally {
			inFlight--;
		}
	});
	return { peak: () => peak, calls: () => readSpy?.mock.calls.length ?? 0 };
}

describe("passive RLM descendant merge", () => {
	afterEach(() => {
		readSpy?.mockRestore();
		readSpy = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads independent descendant transcripts concurrently, in edge order", async () => {
		savedAgentDirEnv = process.env[ENV_AGENT_DIR];
		tempDir = mkdtempSync(join(tmpdir(), "prime-passive-scan-"));
		process.env[ENV_AGENT_DIR] = tempDir;
		const { ledger, parentInfo, children } = await makeFixture();
		const probe = spyOnReadSessionInfo(5);

		const streamed: SessionInfo[] = [];
		const merged = await withPassiveRlmDescendantInfos([parentInfo], ledger, {
			onSession: (info) => streamed.push(info),
		});

		expect(probe.peak()).toBeGreaterThanOrEqual(2);
		expect(probe.peak()).toBeLessThanOrEqual(CHILD_COUNT);
		expect(probe.calls()).toBe(CHILD_COUNT);
		// Concurrency must not reorder the catalog: the streamed rows and the
		// returned list both follow ledger order.
		expect(merged.map((info) => info.id)).toEqual([parentInfo.id, ...children.map((child) => child.id)]);
		expect(streamed.map((info) => info.id)).toEqual(children.map((child) => child.id));
		expect(merged.slice(1)).toEqual(
			expect.arrayContaining([expect.objectContaining({ rlmDepth: 1, parentSessionPath: expect.any(String) })]),
		);
		if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	});

	it("reads a descendant already in the saved catalog exactly once", async () => {
		savedAgentDirEnv = process.env[ENV_AGENT_DIR];
		tempDir = mkdtempSync(join(tmpdir(), "prime-passive-scan-"));
		process.env[ENV_AGENT_DIR] = tempDir;
		const { ledger, parentInfo, children } = await makeFixture();
		const duplicate = await sessionManagerModule.readSessionInfo(children[0]!.file);
		if (!duplicate) throw new Error("Missing child session info");
		const probe = spyOnReadSessionInfo(1);

		const merged = await withPassiveRlmDescendantInfos([parentInfo, duplicate], ledger, {});

		expect(probe.calls()).toBe(CHILD_COUNT - 1);
		expect(merged.map((info) => info.id)).toEqual([
			parentInfo.id,
			duplicate.id,
			...children.slice(1).map((child) => child.id),
		]);
		if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	});

	it("still applies the cwd filter to concurrently read descendants", async () => {
		savedAgentDirEnv = process.env[ENV_AGENT_DIR];
		tempDir = mkdtempSync(join(tmpdir(), "prime-passive-scan-"));
		process.env[ENV_AGENT_DIR] = tempDir;
		const { ledger, parentInfo, children } = await makeFixture();
		const probe = spyOnReadSessionInfo(1);

		const elsewhere = await withPassiveRlmDescendantInfos([parentInfo], ledger, { cwd: "/nowhere" });
		expect(elsewhere.map((info) => info.id)).toEqual([parentInfo.id]);

		const here = await withPassiveRlmDescendantInfos([parentInfo], ledger, { cwd: tempDir });
		expect(here.map((info) => info.id)).toEqual([parentInfo.id, ...children.map((child) => child.id)]);
		expect(probe.calls()).toBe(CHILD_COUNT * 2);
		if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	});
});
