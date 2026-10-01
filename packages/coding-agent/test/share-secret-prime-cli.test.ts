import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectConfiguredShareSecretValues } from "../src/core/share-secret-values.js";
import { findShareUploadSecretFindings } from "../src/core/share-session.js";

/**
 * Regression tests for the Prime CLI credential blind spot: the /share preflight
 * and the traces upload gate compared against auth.json, models.json,
 * settings.json, env and `--api-key`, but this fork's main Prime credential lives
 * only in `~/.prime/config.json`, so a transcript echoing it left the machine
 * unredacted.
 */
describe("share secret values: prime CLI config source", () => {
	/** The Prime CLI key shape holds no prefix the shape detectors know. */
	const PRIME_CLI_KEY = "9f4c2e7a1b8d3f6a5c0e2b4d7f9a1c3e5b8d0f2a4c6e";

	function withTempDirs(run: (dirs: { agentDir: string; primeCliConfigPath: string }) => void): void {
		const root = mkdtempSync(join(tmpdir(), "prime-share-cli-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			const primeCliDir = join(root, "prime-cli");
			mkdirSync(primeCliDir, { recursive: true, mode: 0o700 });
			run({ agentDir, primeCliConfigPath: join(primeCliDir, "config.json") });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("collects the Prime CLI config api_key", () => {
		withTempDirs(({ agentDir, primeCliConfigPath }) => {
			writeFileSync(primeCliConfigPath, JSON.stringify({ api_key: PRIME_CLI_KEY }), { mode: 0o600 });

			const collected = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath,
			});

			expect(collected).toEqual([{ value: PRIME_CLI_KEY, source: "prime CLI config (api_key)" }]);
		});
	});

	it("compares the Prime CLI key against the export even though its shape is unknown", () => {
		withTempDirs(({ agentDir, primeCliConfigPath }) => {
			writeFileSync(primeCliConfigPath, JSON.stringify({ api_key: PRIME_CLI_KEY }), { mode: 0o600 });
			const collected = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath,
			});

			const payload = JSON.stringify({
				header: { version: 1 },
				entries: [{ type: "message", message: { role: "user", content: `the runner printed ${PRIME_CLI_KEY}` } }],
			});
			const html = `<html><body><script id="session-data" type="application/json">${Buffer.from(payload).toString("base64")}</script></body></html>`;

			const findings = findShareUploadSecretFindings(html, { secretValues: collected });
			expect(findings.map((finding) => finding.type)).toContain("Configured credential");
			expect(JSON.stringify(findings)).not.toContain(PRIME_CLI_KEY);
		});
	});

	it("does not double-collect a key that auth.json already holds", () => {
		withTempDirs(({ agentDir, primeCliConfigPath }) => {
			writeFileSync(
				join(agentDir, "auth.json"),
				JSON.stringify({ "prime-inference": { type: "api_key", key: PRIME_CLI_KEY } }),
				{ mode: 0o600 },
			);
			writeFileSync(primeCliConfigPath, JSON.stringify({ api_key: PRIME_CLI_KEY }), { mode: 0o600 });

			const collected = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath,
			});

			const entries = collected.filter((entry) => entry.value === PRIME_CLI_KEY);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.source).toContain("auth.json");
		});
	});

	it("tolerates a missing or malformed Prime CLI config", () => {
		withTempDirs(({ agentDir, primeCliConfigPath }) => {
			const missing = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath,
			});
			expect(missing).toEqual([]);

			writeFileSync(primeCliConfigPath, "{ not json", { mode: 0o600 });
			const malformed = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath,
			});
			expect(malformed).toEqual([]);
		});
	});

	it("primeCliConfigPath: null disables the source", () => {
		withTempDirs(({ agentDir, primeCliConfigPath }) => {
			writeFileSync(primeCliConfigPath, JSON.stringify({ api_key: PRIME_CLI_KEY }), { mode: 0o600 });

			const collected = collectConfiguredShareSecretValues({
				agentDir,
				env: {},
				argv: [],
				primeCliConfigPath: null,
			});

			expect(collected).toEqual([]);
		});
	});
});
