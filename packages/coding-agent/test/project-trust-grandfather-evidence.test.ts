import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionsDir } from "../src/config.js";
import { type ProjectTrustPrompt, ProjectTrustStore, resolveProjectTrust } from "../src/core/project-trust.js";
import { findGrandfatherEvidenceSession } from "../src/main.js";

function sessionId(tag: string): string {
	return `01a0bf40${tag.padEnd(8, "0")}80009000a000b0c0`;
}

function writeSessionFile(sessionsDir: string, id: string, cwd: string, timestamp: string): string {
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp,
		cwd,
	};
	const file = join(sessionsDir, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	return file;
}

/**
 * The upgrade grandfather must only trust a directory on evidence that the
 * directory was in use BEFORE the gate landed (the trust store's pinned
 * createdAt). The pre-fix evidence lookup counted any session for the cwd,
 * including sessions created after the gate and the --resume session itself,
 * so a first interactive run that answered "not trusted (this session only)"
 * was silently converted into permanent trust by the next run.
 */
describe("grandfather evidence predates the gate", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let sessionsDir: string;
	let store: ProjectTrustStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-grandfather-evidence-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".prime/agent/extensions"), { recursive: true });
		writeFileSync(join(projectDir, ".prime/agent/extensions", "a.ts"), "export default () => {}");
		sessionsDir = getSessionsDir(agentDir);
		mkdirSync(sessionsDir, { recursive: true });
		store = new ProjectTrustStore(agentDir);
		store.ensureCreated();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("finds a session that started before the gate landed", () => {
		const gateLandedAt = store.createdAt();
		expect(gateLandedAt).not.toBeNull();
		const pre = writeSessionFile(
			sessionsDir,
			sessionId("pre"),
			projectDir,
			new Date(gateLandedAt! - 60_000).toISOString(),
		);

		expect(findGrandfatherEvidenceSession(agentDir, projectDir, gateLandedAt)).toBe(pre);
	});

	it("ignores sessions created after the gate landed, including a resumed one", () => {
		const gateLandedAt = store.createdAt();
		writeSessionFile(sessionsDir, sessionId("post"), projectDir, new Date(gateLandedAt! + 60_000).toISOString());

		expect(findGrandfatherEvidenceSession(agentDir, projectDir, gateLandedAt)).toBeNull();
	});

	it("returns null when the gate never landed (no store timestamp)", () => {
		expect(findGrandfatherEvidenceSession(agentDir, projectDir, null)).toBeNull();
	});

	it("grandfathers a directory whose only evidence predates the gate", async () => {
		const gateLandedAt = store.createdAt();
		writeSessionFile(sessionsDir, sessionId("old"), projectDir, new Date(gateLandedAt! - 86_400_000).toISOString());

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			hasPriorSession: () => findGrandfatherEvidenceSession(agentDir, projectDir, store.createdAt()) !== null,
		});

		expect(resolution).toEqual({ trusted: true, reason: "grandfathered" });
		expect(store.get(projectDir)).toBe(true);
	});

	it("does not grandfather a directory whose sessions all postdate the gate", async () => {
		const gateLandedAt = store.createdAt();
		writeSessionFile(sessionsDir, sessionId("new"), projectDir, new Date(gateLandedAt! + 60_000).toISOString());
		const prompt: ProjectTrustPrompt = async () => ({ trusted: false, remember: false });

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			hasPriorSession: () => findGrandfatherEvidenceSession(agentDir, projectDir, store.createdAt()) !== null,
		});

		expect(resolution).toEqual({ trusted: false, reason: "prompt" });
		expect(store.get(projectDir)).toBeNull();
	});

	it("keeps a session-only refusal session-only on the next run instead of grandfathering it into trust", async () => {
		const gateLandedAt = store.createdAt();
		const prompt: ProjectTrustPrompt = async () => ({ trusted: false, remember: false });
		const hasPriorSession = () => findGrandfatherEvidenceSession(agentDir, projectDir, store.createdAt()) !== null;

		// First run: the human answers "not trusted, this session only".
		const first = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			hasPriorSession,
		});
		expect(first).toEqual({ trusted: false, reason: "prompt" });

		// That run leaves a session transcript behind (started after the gate).
		writeSessionFile(sessionsDir, sessionId("refus"), projectDir, new Date(gateLandedAt! + 120_000).toISOString());

		// Second run: the post-gate session must not flip the refusal into trust.
		const second = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			hasPriorSession,
		});

		expect(second).toEqual({ trusted: false, reason: "prompt" });
		expect(store.get(projectDir)).toBeNull();
	});

	it("does not persist a machine-mode grandfather decision", async () => {
		const gateLandedAt = store.createdAt();
		writeSessionFile(sessionsDir, sessionId("mcold"), projectDir, new Date(gateLandedAt! - 86_400_000).toISOString());

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: false,
			hasPriorSession: () => findGrandfatherEvidenceSession(agentDir, projectDir, store.createdAt()) !== null,
		});

		// The unattended run still works (trusted for the run), but a machine run
		// never persists anything: the next interactive run can still decide.
		expect(resolution).toEqual({ trusted: true, reason: "grandfathered" });
		expect(store.get(projectDir)).toBeNull();
	});
});
