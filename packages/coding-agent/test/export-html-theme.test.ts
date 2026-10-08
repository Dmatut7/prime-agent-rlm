import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * The CLI `session export` path (main.ts) reads the configured theme through
 * SettingsManager and hands it to the exporter; before that wiring a user with
 * theme=light in settings got a dark export (the auto-detected default).
 */
describe("session export honors the configured theme", () => {
	let tempRoot: string;
	let agentDir: string;
	let sessionFile: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "prime-export-theme-"));
		agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;

		const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.flushNow();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing test session file");
		sessionFile = file;
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	it("exports with the settings theme, not the auto-detected default", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
		const themeName = SettingsManager.create(tempRoot).getTheme();
		expect(themeName).toBe("light");

		const output = join(tempRoot, "out.html");
		await exportFromFile(sessionFile, { outputPath: output, themeName });
		const html = readFileSync(output, "utf8");

		// light.json's explicit export background; the dark default is #18181e.
		expect(html).toContain("--exportPageBg: #f8f8f8");
		expect(html).not.toContain("--exportPageBg: #18181e");
	});

	it("still exports with the default theme when settings name a theme that cannot load", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "no-such-theme" }));
		const themeName = SettingsManager.create(tempRoot).getTheme();
		expect(themeName).toBe("no-such-theme");

		const output = join(tempRoot, "out.html");
		await expect(exportFromFile(sessionFile, { outputPath: output, themeName })).resolves.toBe(output);
		expect(readFileSync(output, "utf8")).toContain("--exportPageBg:");
	});
});

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");

describe("CLI session export honors the configured theme", () => {
	let tempRoot: string;
	let agentDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "prime-export-cli-theme-"));
		agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("prime-agent session export renders the settings theme", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
		const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.flushNow();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Missing test session file");
		const output = join(tempRoot, "out.html");

		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(resolveRun, reject) => {
				const child = spawn(process.execPath, [tsxPath, cliPath, "session", "export", sessionFile, output], {
					env: {
						...process.env,
						[ENV_AGENT_DIR]: agentDir,
						HOME: agentDir,
						TSX_TSCONFIG_PATH: tsconfigPath,
						PI_STDIN_TIMEOUT_MS: "300",
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => resolveRun({ code, stdout, stderr }));
			},
		);

		expect(result.code, `CLI failed: ${result.stderr}`).toBe(0);
		const html = readFileSync(output, "utf8");
		expect(html).toContain("--exportPageBg: #f8f8f8");
	}, 90_000);
});
