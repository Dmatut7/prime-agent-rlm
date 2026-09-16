import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../src/config.js";
import { prepareDaemonUpdateRestart } from "../src/package-manager-cli.js";

// Mirrors the r36 audit reproduction (/tmp/r36_stale_run.mts): a coordinator that died
// mid-update leaves a prepared manifest behind. The daemon supervisor only restores a
// prepared checkpoint inside a 30-minute window (UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS);
// the client reuse paths must not revive sessions from arbitrarily older manifests.
const STALE_MANIFEST_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function writePreparedManifest(agentDir: string, socketPath: string, root: string): string {
	const manifestPath = getDaemonUpdateRestartManifestPath(socketPath, agentDir);
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(
		manifestPath,
		JSON.stringify({
			formatVersion: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "stale-active",
					sessionId: "stale-session",
					sessionFile: join(root, "stale-session.jsonl"),
					cwd: root,
					config: { cwd: root, agentDir: root },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		}),
	);
	return manifestPath;
}

describe("prepared daemon update restart manifest age gate", () => {
	let tempDir: string;
	let agentDir: string;
	let socketPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `r36-stale-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		socketPath = join(tempDir, "no-such-daemon.sock");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discards a manifest older than the restore window instead of reusing it", async () => {
		const manifestPath = writePreparedManifest(agentDir, socketPath, tempDir);
		const stale = new Date(Date.now() - STALE_MANIFEST_AGE_MS);
		utimesSync(manifestPath, stale, stale);
		const errorLines: string[] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			errorLines.push(String(message));
		});

		try {
			// The daemon is unreachable, so without a reusable manifest this must fail; returning
			// the stale manifest here is the r36 finding (sessions revived days later).
			await expect(prepareDaemonUpdateRestart(socketPath, agentDir)).rejects.toThrow();
			expect(existsSync(manifestPath)).toBe(false);
			// The cleanup is logged, not silent.
			expect(errorLines.join("\n")).toContain("stale");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("still reuses a fresh manifest when the daemon is unreachable", async () => {
		const manifestPath = writePreparedManifest(agentDir, socketPath, tempDir);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			expect(statSync(manifestPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
			const manifest = await prepareDaemonUpdateRestart(socketPath, agentDir);
			expect(manifest.sessions[0]?.activeSessionId).toBe("stale-active");
			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
