import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";

/**
 * DAT-2: opening a transcript and appending without repairing a crash-torn tail
 * glues the new line onto the torn one; the glued line stops parsing, and the torn
 * record plus every appended record vanish from every later read. The write-owning
 * open points (resume, fork, import, rename) must repair first, like main.ts and the
 * daemon paths already do.
 */

interface Harness {
	tempDir: string;
	sessionDir: string;
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	cleanup: () => Promise<void>;
}

function writeSessionFile(path: string, cwd: string, texts: string[]): string {
	const scratch = join(dirname(path), `.scratch-${Math.random().toString(36).slice(2)}`);
	mkdirSync(scratch, { recursive: true });
	const manager = SessionManager.create(cwd, scratch);
	for (const text of texts) {
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage(text));
	}
	const created = manager.getSessionFile();
	if (!created) throw new Error("scratch session file was never written");
	mkdirSync(dirname(path), { recursive: true });
	renameSync(created, path);
	rmSync(scratch, { recursive: true, force: true });
	return readFileSync(path, "utf8");
}

/** Tear the file's final byte: a complete record that lost only its newline. */
function tearTrailingNewline(path: string): void {
	const content = readFileSync(path);
	if (content.length === 0 || content[content.length - 1] !== 0x0a) {
		throw new Error("test setup: session file does not end with a newline");
	}
	writeFileSync(path, content.subarray(0, content.length - 1));
}

/** Tear the last line mid-JSON: a genuinely partial record no repair can save. */
function tearMidLine(path: string): void {
	const content = readFileSync(path);
	const lastNewline = content.lastIndexOf(0x0a);
	if (lastNewline === -1) throw new Error("test setup: no line boundary");
	const lastLine = content.subarray(lastNewline + 1);
	writeFileSync(path, content.subarray(0, lastNewline + 1 + Math.floor((lastLine.length - 1) / 2)));
}

async function createRuntimeHost(): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-dat2-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(tempDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("second reply")]);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, sessionDir),
	});
	await runtime.session.bindExtensions({});

	return {
		tempDir,
		sessionDir,
		runtime,
		cleanup: async () => {
			await runtime.dispose().catch(() => undefined);
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
			}
		},
	};
}

function messageText(session: AgentSession, needle: string): boolean {
	return session.messages.some((message) => JSON.stringify(message).includes(needle));
}

/** Serialized assistant-message entries, the records a torn tail actually loses. */
function assistantEntries(path: string): string[] {
	return loadEntriesFromFile(path)
		.filter(
			(entry) =>
				entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "assistant",
		)
		.map((entry) => JSON.stringify(entry));
}

const hosts: Harness[] = [];

afterEach(async () => {
	while (hosts.length > 0) {
		await hosts.pop()?.cleanup();
	}
});

describe("repair before open+append", () => {
	it("switchSession (resume) keeps both the torn record and the newly appended lines readable", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const targetPath = join(host.sessionDir, "resume-target.jsonl");
		writeSessionFile(targetPath, host.tempDir, ["torn tail record"]);
		tearTrailingNewline(targetPath);

		await host.runtime.switchSession(targetPath);
		await host.runtime.session.prompt("second turn");

		// The runtime saw the whole transcript, including the torn record...
		expect(messageText(host.runtime.session, "torn tail record")).toBe(true);
		// ...and a reload from disk keeps the torn record's assistant message AND
		// the whole new turn: no glued line, no silently dropped record.
		const assistants = assistantEntries(targetPath);
		expect(assistants.some((entry) => entry.includes("torn tail record"))).toBe(true);
		const persisted = JSON.stringify(loadEntriesFromFile(targetPath));
		expect(persisted).toContain("second turn");
		expect(persisted).toContain("second reply");
	});

	it("renameSavedSession (in-process connection) appends without gluing onto a torn tail", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const savedPath = join(host.sessionDir, "saved-session.jsonl");
		writeSessionFile(savedPath, host.tempDir, ["saved torn record"]);
		tearTrailingNewline(savedPath);

		const connection = new InProcessAgentConnection(host.runtime);
		await connection.renameSavedSession(savedPath, "renamed session");

		// The torn record's assistant message survives AND the session_info line is
		// readable: pre-fix, the append glued onto the torn line and both vanished.
		const assistants = assistantEntries(savedPath);
		expect(assistants.some((entry) => entry.includes("saved torn record"))).toBe(true);
		const persisted = JSON.stringify(loadEntriesFromFile(savedPath));
		expect(persisted).toContain("renamed session");
		const renamed = SessionManager.open(savedPath);
		expect(renamed.getSessionName()).toBe("renamed session");
	});

	it("switchSession (resume) with a mid-line torn tail drops only the partial record, not the new turn", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const targetPath = join(host.sessionDir, "resume-mid-torn.jsonl");
		writeSessionFile(targetPath, host.tempDir, ["intact record", "torn record"]);
		tearMidLine(targetPath);

		await host.runtime.switchSession(targetPath);
		await host.runtime.session.prompt("second turn");

		// The partial record is gone by design, but the repair kept the next append
		// from gluing onto it: the intact record and the whole new turn survive.
		const persisted = JSON.stringify(loadEntriesFromFile(targetPath));
		expect(persisted).toContain("intact record");
		expect(persisted).toContain("second turn");
		expect(persisted).toContain("second reply");
	});

	it("control: an untorn switch+append keeps everything readable", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const targetPath = join(host.sessionDir, "clean-target.jsonl");
		writeSessionFile(targetPath, host.tempDir, ["clean record"]);

		await host.runtime.switchSession(targetPath);
		await host.runtime.session.prompt("clean second turn");

		const persisted = JSON.stringify(loadEntriesFromFile(targetPath));
		expect(persisted).toContain("clean record");
		expect(persisted).toContain("clean second turn");
		expect(basename(targetPath)).toBe("clean-target.jsonl");
	});
});
