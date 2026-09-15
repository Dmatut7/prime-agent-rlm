import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import {
	acquireSessionLeaseAsync,
	SESSION_LEASES_ENABLED_ENV,
	type SessionLease,
} from "../../src/core/session-lease.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";

/**
 * K3P-5 (round-30 K3 review F5): the two rename paths repaired and appended to
 * saved session files without holding the write lease, unlike the catalog
 * precedent (`daemon-catalog-process.ts`), which refuses to append without one:
 * truncating a live writer's in-flight append corrupts its record.
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

async function createRuntimeHost(): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-k3p5-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(tempDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider();
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

const hosts: Harness[] = [];

afterEach(async () => {
	while (hosts.length > 0) {
		await hosts.pop()?.cleanup();
	}
});

describe("rename under a write lease", () => {
	it("refuses to repair+append a saved session whose lease another writer holds", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const savedPath = join(host.sessionDir, "lease-held.jsonl");
		writeSessionFile(savedPath, host.tempDir, ["held record"]);
		const before = readFileSync(savedPath, "utf8");

		// A live writer holds the lease on the saved file: its in-flight append
		// owns the tail, and a rename-side repair must not truncate under it.
		const lease: SessionLease | undefined = await acquireSessionLeaseAsync(
			savedPath,
			host.runtime.services.agentDir,
			{
				...process.env,
				[SESSION_LEASES_ENABLED_ENV]: "1",
			},
		);
		expect(lease).toBeDefined();

		const connection = new InProcessAgentConnection(host.runtime);
		await expect(connection.renameSavedSession(savedPath, "must not land")).rejects.toThrow(/lease|active/i);

		// Nothing was appended and nothing was truncated.
		expect(readFileSync(savedPath, "utf8")).toBe(before);
		lease?.release();
	});

	it("control: with no competing lease the rename still repairs and appends", async () => {
		const host = await createRuntimeHost();
		hosts.push(host);
		const savedPath = join(host.sessionDir, "lease-free.jsonl");
		writeSessionFile(savedPath, host.tempDir, ["free record"]);

		const connection = new InProcessAgentConnection(host.runtime);
		await connection.renameSavedSession(savedPath, "renamed under lease");

		const persisted = JSON.stringify(loadEntriesFromFile(savedPath));
		expect(persisted).toContain("renamed under lease");
		expect(persisted).toContain("free record");
	});
});
