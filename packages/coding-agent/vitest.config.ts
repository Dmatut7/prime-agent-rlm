import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The daemon supervisor's owner registry is user-wide authority state: it lives in
 * the real home directory on purpose. A test daemon that resolves that root without
 * an override therefore leaves owner records in the developer's real
 * `~/.prime/supervisor-owners`, where `status`, endpoint discovery and the
 * same-agent-dir startup gate read them as live supervisors. Every test process — and
 * every daemon it spawns, which inherits this environment — writes into one run-scoped
 * temp root instead.
 */
const testSupervisorRegistryDir = mkdtempSync(join(tmpdir(), "prime-agent-test-supervisor-registry-"));

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcMcp = fileURLToPath(new URL("../ai/src/mcp.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		env: {
			DO_NOT_TRACK: "1",
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: testSupervisorRegistryDir,
		},
		tags: [
			{
				name: "process-stress",
				description: "Slow real-process stress and wall-clock scheduling coverage",
			},
			{
				name: "kernel-heavy",
				description: "Boots a real Python kernel and syncs skills into the shared venv",
			},
		],
		// Kernel-heavy tests are excluded from the default sharded run: several files
		// booting real kernels in one shard starve the neighbouring kernel tests that
		// rely on the 30s default timeout. `test:kernel` runs them on their own.
		tagsFilter: ["!process-stress", "!kernel-heavy"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
