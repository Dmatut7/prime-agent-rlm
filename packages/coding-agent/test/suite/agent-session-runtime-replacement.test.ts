import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { copyImportedSession, resolveImportDestination } from "../../src/core/session-import-destination.js";
import { SessionManager } from "../../src/core/session-manager.js";

interface HarnessOptions {
	/** Throw from the runtime factory on these build indexes (0 = the bootstrap build). */
	failBuilds?: number[];
}

interface Harness {
	tempDir: string;
	sessionDir: string;
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	reboundSessions: AgentSession[];
	buildIndexes: number[];
	cleanup: () => Promise<void>;
}

/** Write a real, loadable session file at `path` carrying `texts` as user/assistant pairs. */
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

function messageText(session: AgentSession, needle: string): boolean {
	return session.messages.some((message) => JSON.stringify(message).includes(needle));
}

async function createRuntimeHost(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-runtime-replacement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(tempDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage("restored reply"),
		fauxAssistantMessage("second reply"),
		fauxAssistantMessage("third reply"),
	]);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const buildIndexes: number[] = [];
	const failBuilds = new Set(options.failBuilds ?? []);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const index = buildIndexes.length;
		buildIndexes.push(index);
		if (failBuilds.has(index)) {
			throw new Error(`build failed at ${index}`);
		}
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

	const reboundSessions: AgentSession[] = [];
	runtime.setRebindSession(async (session) => {
		reboundSessions.push(session);
	});

	return {
		tempDir,
		sessionDir,
		runtime,
		reboundSessions,
		buildIndexes,
		cleanup: async () => {
			await runtime.dispose().catch(() => undefined);
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
			}
		},
	};
}

describe("AgentSessionRuntime replacement failures and import destinations", () => {
	const hosts: Harness[] = [];

	afterEach(async () => {
		while (hosts.length > 0) {
			await hosts.pop()?.cleanup();
		}
	});

	describe("import destination collisions", () => {
		it("keeps the registered session file when an import reuses its basename with different content", async () => {
			const host = await createRuntimeHost();
			hosts.push(host);
			const existingPath = join(host.sessionDir, "import-target.jsonl");
			const existingContent = writeSessionFile(existingPath, host.tempDir, ["registered transcript"]);
			const registeredSessionId = SessionManager.open(existingPath).getSessionId();

			const incomingPath = join(host.tempDir, "incoming", "import-target.jsonl");
			writeSessionFile(incomingPath, host.tempDir, ["imported transcript"]);
			const incomingContent = readFileSync(incomingPath, "utf8");

			await host.runtime.importFromJsonl(incomingPath);

			// The registered transcript survives byte for byte.
			expect(readFileSync(existingPath, "utf8")).toBe(existingContent);
			// The import landed on its own file and became the live session.
			const importedPath = host.runtime.session.sessionFile;
			expect(typeof importedPath).toBe("string");
			expect(importedPath).not.toBe(existingPath);
			expect(basename(importedPath ?? "")).not.toBe("import-target.jsonl");
			expect(messageText(host.runtime.session, "imported transcript")).toBe(true);
			expect(messageText(host.runtime.session, "registered transcript")).toBe(false);
			expect(readFileSync(importedPath ?? "", "utf8")).toContain("imported transcript");
			// Two transcripts of different sessions must not share one session id: the
			// renamed copy gets its own, aligned with its new file stem.
			expect(host.runtime.session.sessionId).not.toBe(registeredSessionId);
			expect(host.runtime.session.sessionId).not.toBe(SessionManager.open(incomingPath).getSessionId());
			expect(host.runtime.session.sessionId).toBe(basename(importedPath ?? "", ".jsonl"));
			const registeredIds = readdirSync(host.sessionDir)
				.filter((entry) => entry.endsWith(".jsonl"))
				.map((entry) => SessionManager.open(join(host.sessionDir, entry)).getSessionId());
			expect(registeredIds.length).toBeGreaterThan(1);
			expect(new Set(registeredIds).size).toBe(registeredIds.length);
			// The incoming source is left alone.
			expect(readFileSync(incomingPath, "utf8")).toBe(incomingContent);
		});

		it("re-importing byte-identical content reuses the existing file instead of duplicating it", async () => {
			const host = await createRuntimeHost();
			hosts.push(host);
			const existingPath = join(host.sessionDir, "same-content.jsonl");
			writeSessionFile(existingPath, host.tempDir, ["identical transcript"]);
			const incomingPath = join(host.tempDir, "incoming", "same-content.jsonl");
			mkdirSync(dirname(incomingPath), { recursive: true });
			writeFileSync(incomingPath, readFileSync(existingPath));
			const before = readdirSync(host.sessionDir).sort();

			await host.runtime.importFromJsonl(incomingPath);

			expect(host.runtime.session.sessionFile).toBe(existingPath);
			expect(readdirSync(host.sessionDir).sort()).toEqual(before);
			expect(messageText(host.runtime.session, "identical transcript")).toBe(true);
		});

		it("skips taken suffixes and refuses an occupied destination", async () => {
			const host = await createRuntimeHost();
			hosts.push(host);
			const incomingPath = join(host.tempDir, "incoming", "occupied.jsonl");
			const incomingContent = writeSessionFile(incomingPath, host.tempDir, ["incoming transcript"]);

			// The requested name and its first suffix are both taken by other sessions.
			const takenBase = join(host.sessionDir, "occupied.jsonl");
			const takenSuffix = join(host.sessionDir, "occupied-2.jsonl");
			writeSessionFile(takenBase, host.tempDir, ["base transcript"]);
			writeSessionFile(takenSuffix, host.tempDir, ["suffix transcript"]);

			expect(resolveImportDestination(incomingPath, takenBase).path).toBe(join(host.sessionDir, "occupied-3.jsonl"));
			expect(() => copyImportedSession(incomingPath, takenSuffix, { renamed: true })).toThrow(
				"Refusing to overwrite an existing session file",
			);
			expect(readFileSync(takenSuffix, "utf8")).not.toBe(incomingContent);
			expect(readFileSync(takenSuffix, "utf8")).toContain("suffix transcript");
		});

		it("control: an uncontested import still lands on the requested basename", async () => {
			const host = await createRuntimeHost();
			hosts.push(host);
			const incomingPath = join(host.tempDir, "incoming", "fresh-import.jsonl");
			writeSessionFile(incomingPath, host.tempDir, ["fresh transcript"]);

			await host.runtime.importFromJsonl(incomingPath);

			expect(host.runtime.session.sessionFile).toBe(join(host.sessionDir, "fresh-import.jsonl"));
			expect(messageText(host.runtime.session, "fresh transcript")).toBe(true);
		});
	});

	describe("failed replacement builds", () => {
		it("restores a usable session when newSession's build fails after teardown", async () => {
			const host = await createRuntimeHost({ failBuilds: [1] });
			hosts.push(host);
			const previousSession = host.runtime.session;
			const previousFile = previousSession.sessionFile;
			host.reboundSessions.length = 0;

			await expect(host.runtime.newSession()).rejects.toThrow("build failed at 1");

			const restored = host.runtime.session;
			expect(restored === previousSession).toBe(false);
			expect(restored.sessionFile).toBe(previousFile);
			expect(host.reboundSessions.at(-1) === restored).toBe(true);
			await restored.prompt("still alive");
			expect(restored.getLastAssistantText()).toBe("restored reply");
		});

		it("restores the previous session when switchSession's build fails after teardown", async () => {
			const host = await createRuntimeHost({ failBuilds: [1] });
			hosts.push(host);
			const targetPath = join(host.sessionDir, "switch-target.jsonl");
			writeSessionFile(targetPath, host.tempDir, ["switch target transcript"]);
			const previousSession = host.runtime.session;
			const previousFile = previousSession.sessionFile;

			await expect(host.runtime.switchSession(targetPath)).rejects.toThrow("build failed at 1");

			const restored = host.runtime.session;
			expect(restored === previousSession).toBe(false);
			expect(restored.sessionFile).toBe(previousFile);
			expect(messageText(restored, "switch target transcript")).toBe(false);
			await restored.prompt("still alive");
			expect(restored.getLastAssistantText()).toBe("restored reply");
		});

		it("control: a successful switch replaces the session without a rollback build", async () => {
			const host = await createRuntimeHost();
			hosts.push(host);
			const targetPath = join(host.sessionDir, "good-target.jsonl");
			writeSessionFile(targetPath, host.tempDir, ["good target transcript"]);
			const previousSession = host.runtime.session;

			await host.runtime.switchSession(targetPath);

			expect(host.runtime.session === previousSession).toBe(false);
			expect(host.runtime.session.sessionFile).toBe(targetPath);
			expect(host.buildIndexes).toEqual([0, 1]);
		});
	});
});
