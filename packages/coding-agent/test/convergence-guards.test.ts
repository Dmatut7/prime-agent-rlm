import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wave-10 audit drift gates (docs/fork → /tmp/wave10/audit-drift.md): the repo recorded
 * these duplications and dead symbols across three audits without converging them, so the
 * convergence is pinned here as an executable gate instead of another document.
 */

const SRC = resolve(__dirname, "../src");

function readSrc(relPath: string): string {
	return readFileSync(join(SRC, relPath), "utf8");
}

function allSourceFiles(directory: string = SRC): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...allSourceFiles(path));
		} else if (entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("process liveness has a single source", () => {
	// These files carried local kill(pid, 0) liveness copies whose zombie and error
	// semantics had drifted apart; the shared implementations live in utils/child-process.ts.
	const convergedFiles = [
		"core/session-lease.ts",
		"core/turn-liveness.ts",
		"core/kernel/bootstrap.ts",
		"cli/daemon-ps.ts",
		"cli/daemon-update-restart.ts",
		"modes/daemon/daemon-mode.ts",
		"modes/daemon/daemon-supervisor-ownership.ts",
	];

	it.each(convergedFiles)("%s has no local kill(pid, 0) liveness probe", (relPath) => {
		expect(readSrc(relPath)).not.toMatch(/process\.kill\([^)]*,\s*0\)/);
	});

	it("utils/child-process.ts remains the definition site", () => {
		const source = readSrc("utils/child-process.ts");
		expect(source).toContain("export function isProcessAlive(");
		expect(source).toContain("export function processIdExists(");
	});
});

describe("timer waits have a single source", () => {
	// These files carried local setTimeout promise wrappers; the shared, abort-aware
	// implementation (including unref and resolve-on-abort options) lives in utils/sleep.ts.
	const convergedFiles = [
		"core/agent-traces.ts",
		"cli/daemon-launch.ts",
		"cli/daemon-ps.ts",
		"cli/daemon-update-restart.ts",
		"modes/agent-connection/daemon-agent-connection.ts",
		"modes/daemon/daemon-client.ts",
		"modes/daemon/daemon-mode.ts",
		"modes/daemon/daemon-socket.ts",
		"modes/daemon/daemon-supervisor.ts",
		"modes/daemon/daemon-supervisor-ownership.ts",
		"modes/daemon/supervisor-availability.ts",
	];

	it.each(convergedFiles)("%s defines no local delay/sleep wrapper", (relPath) => {
		expect(readSrc(relPath)).not.toMatch(/function (delay|sleep|unrefDelay)\(/);
	});

	it("utils/sleep.ts remains the definition site", () => {
		expect(readSrc("utils/sleep.ts")).toContain("export function sleep(");
	});
});

describe("wave-10 dead symbols stay deleted", () => {
	// Zero-reference symbols removed in wave-12 (audit-drift.md §3): the MCP
	// connection-outcome family (dead since introduction, unlike the documented
	// refinement-notice reservation), and the r3 F26 stragglers. The MCP custom-type
	// constant itself stays: input-classification and the LLM filter still classify
	// persisted legacy entries by it.
	const deletedSymbols = [
		"createMcpConnectionOutcomeMessage",
		"formatMcpConnectionOutcomeNotice",
		"formatMcpDisconnectionNotice",
		"isMcpDisconnectionOutcome",
		"isMcpConnectionOutcomeMessage",
		"McpConnectionOutcomeMessage",
		"McpOutcomeDetails",
		"McpConnectionOutcomeDetails",
		"McpDisconnectionOutcomeDetails",
		"McpConnectionVerificationState",
		"McpConnectionOutcomeSource",
		"McpConnectionActivationState",
		"McpDisconnectionState",
		"computeEditDiff",
		"uploadAgentTraceSession",
		"AgentTraceSessionUploadOptions",
		"kernelSnapshotReferencePath",
		"isLightTheme",
		"resolveHeaders",
		"resolveHeadersOrThrow",
		"clearPrimeCliCredentials",
		"getNewEntries",
		"compareVersions",
		"liveSnapshotReferences",
	];

	const sources = allSourceFiles().map((path) => ({ path, source: readFileSync(path, "utf8") }));
	expect(sources.length).toBeGreaterThan(0);

	it.each(deletedSymbols)("%s has no definition or reference under src/", (symbol) => {
		const pattern = new RegExp(`\\b${symbol}\\b`);
		const hits = sources.filter(({ source }) => pattern.test(source)).map(({ path }) => path);
		expect(hits).toEqual([]);
	});

	it("artifact-total-cap no longer branches on unproducible live snapshot references", () => {
		expect(readSrc("core/retention/artifact-total-cap.ts")).not.toMatch(/\bliveSnapshotReferences\b/);
	});
});
