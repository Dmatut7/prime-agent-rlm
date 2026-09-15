import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { copyImportedSession, resolveImportDestination } from "../../../src/core/session-import-destination.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { resolveSessionPath } from "../../../src/core/session-resolver.js";

/**
 * `/import` copies a transcript into the session directory under its own basename. Two files in
 * one directory may not carry one session id: `--resume <id>` then resolves to neither of them,
 * and both write into the same `session-artifacts/<id>` directory (kernel snapshot, durable
 * schedule, sub-agent transcripts). A transcript whose file name differs from its header id is
 * the shape that reaches that state, because the destination check only looked at the name.
 */

interface Host {
	tempDir: string;
	sessionDir: string;
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	cleanup: () => Promise<void>;
}

async function createHost(): Promise<Host> {
	const tempDir = join(tmpdir(), `pi-import-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(tempDir, "sessions");
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const savedAgentDirEnv = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = tempDir;

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("imported reply")]);
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
			if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
		},
	};
}

/** Header session ids carried by every transcript in a directory, as `file:id` pairs. */
function headerIds(sessionDir: string): string[] {
	return readdirSync(sessionDir)
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => {
			const head = (readFileSync(join(sessionDir, entry), "utf8").split("\n")[0] ?? "").trim();
			let id: string | undefined;
			try {
				const parsed: unknown = JSON.parse(head);
				if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string") id = parsed.id;
			} catch {
				id = undefined;
			}
			return `${entry}:${id ?? "<none>"}`;
		});
}

/** Just the ids, for the uniqueness assertion. */
function idsOnly(entries: string[]): string[] {
	return entries.map((entry) => entry.slice(entry.indexOf(":") + 1));
}

function writeRegisteredSession(sessionDir: string, cwd: string, text: string): { path: string; id: string } {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("reply"));
	const path = manager.getSessionFile();
	if (!path) throw new Error("registered session file was never written");
	return { path, id: manager.getSessionId() };
}

const hosts: Host[] = [];
afterEach(async () => {
	while (hosts.length > 0) {
		await hosts.pop()?.cleanup();
	}
});

describe("/import with a file name that is not the header id (IT-1)", () => {
	it("keeps the original session uniquely resolvable by its id", async () => {
		const host = await createHost();
		hosts.push(host);
		const registered = writeRegisteredSession(host.sessionDir, host.tempDir, "registered transcript");
		// An exported copy of that transcript, carrying its session id under a different name.
		const incomingPath = join(host.tempDir, "incoming", "export-notes.jsonl");
		mkdirSync(dirname(incomingPath), { recursive: true });
		copyFileSync(registered.path, incomingPath);

		await host.runtime.importFromJsonl(incomingPath);

		// No two transcripts in the directory share one session id.
		const ids = idsOnly(headerIds(host.sessionDir));
		expect(ids.length).toBeGreaterThan(1);
		expect(
			new Set(ids).size,
			`duplicate header ids in ${host.sessionDir}: ${JSON.stringify(headerIds(host.sessionDir))}`,
		).toBe(ids.length);

		// The session the user had is still recoverable by its own id.
		const resolved = await resolveSessionPath(registered.id, host.tempDir, host.sessionDir);
		expect(resolved.type).toBe("local");
		expect((resolved as { path: string }).path).toBe(registered.path);
		expect(readFileSync(registered.path, "utf8")).toContain("registered transcript");

		// And the imported copy is reachable by the id it now carries.
		const importedId = host.runtime.session.sessionId;
		expect(importedId).toBeDefined();
		const imported = await resolveSessionPath(importedId, host.tempDir, host.sessionDir);
		expect((imported as { path: string }).path).toBe(host.runtime.session.sessionFile);
		expect(readFileSync(host.runtime.session.sessionFile ?? "", "utf8")).toContain("registered transcript");
	});

	it("control: an uncontested name-differs-from-id import still keeps its own session id", async () => {
		const host = await createHost();
		hosts.push(host);
		const registered = writeRegisteredSession(host.sessionDir, host.tempDir, "someone else transcript");
		const incomingPath = join(host.tempDir, "incoming", "notes.jsonl");
		mkdirSync(dirname(incomingPath), { recursive: true });
		const source = writeRegisteredSession(join(host.tempDir, "scratch"), host.tempDir, "imported transcript");
		copyFileSync(source.path, incomingPath);

		await host.runtime.importFromJsonl(incomingPath);

		expect(host.runtime.session.sessionId).toBe(source.id);
		expect(host.runtime.session.sessionFile).toBe(join(host.sessionDir, "notes.jsonl"));
		const resolved = await resolveSessionPath(registered.id, host.tempDir, host.sessionDir);
		expect((resolved as { path: string }).path).toBe(registered.path);
	});

	it("the destination refuses a session id another transcript already holds", async () => {
		const host = await createHost();
		hosts.push(host);
		const registered = writeRegisteredSession(host.sessionDir, host.tempDir, "registered transcript");
		const incomingPath = join(host.tempDir, "incoming", "handoff.jsonl");
		mkdirSync(dirname(incomingPath), { recursive: true });
		copyFileSync(registered.path, incomingPath);

		const destination = resolveImportDestination(incomingPath, join(host.sessionDir, "handoff.jsonl"));
		expect(destination.path).toBe(join(host.sessionDir, "handoff.jsonl"));
		expect(destination.reusedExisting).toBe(false);
		expect(destination.sessionId).toBeDefined();
		expect(destination.sessionId).not.toBe(registered.id);

		copyImportedSession(incomingPath, destination.path, {
			renamed: destination.renamed,
			sessionId: destination.sessionId,
		});
		const ids = idsOnly(headerIds(host.sessionDir));
		expect(new Set(ids).size, JSON.stringify(headerIds(host.sessionDir))).toBe(ids.length);
		expect(ids).toContain(registered.id);
	});
});
