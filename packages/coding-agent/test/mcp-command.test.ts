import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatMcpServer, parseMcpAddArgs, runMcpManagementCommand } from "../src/core/mcp/mcp-command.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("MCP management commands", () => {
	const testDir = join(process.cwd(), "test-mcp-command-tmp");
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	it("preserves exact stdio argv and environment references after --", () => {
		expect(
			parseMcpAddArgs([
				"local",
				"--cwd",
				"/tmp/work tree",
				"--env",
				"TOKEN=SOURCE_TOKEN",
				"--",
				"node",
				"server file.js",
				"--flag=value with spaces",
			]),
		).toEqual({
			name: "local",
			force: false,
			config: {
				type: "stdio",
				command: "node",
				args: ["server file.js", "--flag=value with spaces"],
				cwd: "/tmp/work tree",
				env: { TOKEN: { env: "SOURCE_TOKEN" } },
			},
		});
	});

	it("accepts environment names inherited from Object.prototype", () => {
		const { config } = parseMcpAddArgs([
			"local",
			"--env",
			"__proto__=PROTO_SOURCE",
			"--env",
			"constructor=CONSTRUCTOR_SOURCE",
			"--",
			"node",
		]);
		expect(config).toMatchObject({
			type: "stdio",
			env: { __proto__: { env: "PROTO_SOURCE" }, constructor: { env: "CONSTRUCTOR_SOURCE" } },
		});
	});

	it("validates transport, URL, names, auth, and stdio environment syntax", () => {
		for (const args of [
			["linear", "--url", "https://example.com/mcp"],
			["bad name", "--url", "https://example.com/mcp"],
			["remote", "--url", "file:///tmp/server"],
			["remote", "--url", "https://user:secret@example.com/mcp"],
			["remote", "--url", "https://example.com", "--oauth", "--bearer-token-env-var", "TOKEN"],
			["local", "--env", "TOKEN=literal-value", "--", "node"],
			["local", "--"],
		] as string[][]) {
			expect(() => parseMcpAddArgs(args)).toThrow();
		}
	});

	it("keeps the secrecy boundary while showing operational detail in get", () => {
		const output = formatMcpServer("remote", {
			type: "http",
			url: "https://user.example/private/path",
			bearerTokenEnvVar: "SECRET_TOKEN",
			headers: { Authorization: "Bearer secret", "X-Api-Key": "also-secret" },
		});
		// The boundary: no URL (paths can carry tokens), no env var names, no header
		// names or values.
		expect(output).not.toContain("user.example");
		expect(output).not.toContain("SECRET_TOKEN");
		expect(output).not.toContain("Authorization");
		expect(output).not.toContain("X-Api-Key");
		// The detail `list` does not carry:
		expect(output).toContain("remote: http");
		expect(output).toContain("bearer token from env");
		expect(output).toContain("headers: 2");
	});

	it("persists global-only entries and replaces them wholesale with --force", async () => {
		const manager = SettingsManager.inMemory({});
		await runMcpManagementCommand(["add", "remote", "--url", "https://one.example/mcp", "--oauth"], manager);
		await expect(
			runMcpManagementCommand(["add", "remote", "--url", "https://two.example/mcp"], manager),
		).rejects.toThrow("already exists");
		await runMcpManagementCommand(
			["add", "remote", "--url", "https://two.example/mcp", "--bearer-token-env-var", "TOKEN", "--force"],
			manager,
		);
		expect(manager.getGlobalMcpServers()).toEqual({
			remote: { type: "http", url: "https://two.example/mcp", bearerTokenEnvVar: "TOKEN" },
		});
		expect(manager.getProjectSettings().mcpServers).toBeUndefined();
	});

	it("drops stored mcp:<name> credentials on every add and on remove", async () => {
		const manager = SettingsManager.inMemory({});
		const dropped: string[] = [];
		const authStorage = {
			removeVerified: (provider: string) => dropped.push(provider),
		};
		await runMcpManagementCommand(
			["add", "remote", "--url", "https://one.example/mcp", "--oauth"],
			manager,
			authStorage,
		);
		expect(dropped).toEqual(["mcp:remote"]);
		await runMcpManagementCommand(
			["add", "remote", "--url", "https://two.example/mcp", "--oauth", "--force"],
			manager,
			authStorage,
		);
		expect(dropped).toEqual(["mcp:remote", "mcp:remote"]);
		await runMcpManagementCommand(["remove", "remote"], manager, authStorage);
		expect(dropped).toEqual(["mcp:remote", "mcp:remote", "mcp:remote"]);
		// Without an auth store the same flows still succeed.
		await runMcpManagementCommand(["add", "remote", "--url", "https://three.example/mcp"], manager);
		await runMcpManagementCommand(["remove", "remote"], manager);
	});

	it("aborts an add when the credential drop fails, leaving settings untouched", async () => {
		const manager = SettingsManager.inMemory({});
		const authStorage = {
			removeVerified: () => {
				throw new Error("auth.json write failed");
			},
		};
		await expect(
			runMcpManagementCommand(["add", "remote", "--url", "https://two.example/mcp"], manager, authStorage),
		).rejects.toThrow('Could not remove stored credentials for "remote"');
		expect(manager.getGlobalMcpServers()?.remote).toBeUndefined();
	});

	it("keeps the built-in integration login when removing a catalog-named shadow entry", async () => {
		const manager = SettingsManager.inMemory({});
		// Simulate a hand-edited shadowing entry (add rejects catalog names).
		manager.setGlobalMcpServer("linear", { type: "http", url: "https://shadow.example/mcp" });
		const dropped: string[] = [];
		const authStorage = {
			removeVerified: (provider: string) => dropped.push(provider),
		};
		await runMcpManagementCommand(["remove", "linear"], manager, authStorage);
		// mcp:linear stores the authored Linear login, not a generic-server token.
		expect(dropped).toEqual([]);
	});

	it("atomically persists only user settings while preserving concurrent fields", async () => {
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ mcpServers: { project: {} } }),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light", quietStartup: true }));

		await runMcpManagementCommand(["add", "remote", "--url", "https://example.com/mcp"], manager);

		const globalSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(globalSettings).toMatchObject({
			theme: "light",
			quietStartup: true,
			mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } },
		});
		expect(readFileSync(join(projectDir, ".prime", "agent", "settings.json"), "utf8")).toContain("project");
		expect(() => readFileSync(`${join(agentDir, "settings.json")}.tmp`, "utf8")).toThrow();
	});

	it("does not attribute an earlier unrelated write failure to a later mcp command", async () => {
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		const manager = SettingsManager.create(projectDir, agentDir);
		try {
			// Record an unrelated global-write failure: a directory sits where the
			// settings file belongs, so the queued write can never land.
			mkdirSync(join(agentDir, "settings.json"));
			manager.setExtensionPaths(["-skills/alpha/SKILL.md"]);
			await manager.flush();
			rmSync(join(agentDir, "settings.json"), { recursive: true });

			// The mcp write succeeds; the earlier failure belongs to the toggle that
			// caused it, not to this command.
			const result = await runMcpManagementCommand(["add", "fetch", "--", "uvx", "mcp-server-fetch"], manager);
			expect(result.message).toContain('Added MCP server "fetch"');
		} finally {
			manager.stopWatchingExternalSettings();
		}
	});

	it("allows inspecting and removing hand-edited reserved entries", async () => {
		const manager = SettingsManager.inMemory({
			mcpServers: { linear: { type: "http", url: "https://proxy.example/mcp" } },
		});
		const get = await runMcpManagementCommand(["get", "linear"], manager);
		expect(get.message).toContain("linear: http");
		expect(get.message).not.toContain("proxy.example");
		await runMcpManagementCommand(["remove", "linear"], manager);
		expect(manager.getGlobalMcpServers()).toEqual({});
	});

	it("shows connection details in get that list omits", async () => {
		const manager = SettingsManager.inMemory({
			mcpServers: {
				remote: { type: "http", url: "https://example.test/mcp", oauth: true },
				local: { type: "stdio", command: "node", args: ["server.js"], cwd: "/tmp/work" },
			},
		});

		const getRemote = await runMcpManagementCommand(["get", "remote"], manager);
		expect(getRemote.message).toContain("oauth");

		const getLocal = await runMcpManagementCommand(["get", "local"], manager);
		expect(getLocal.message).toContain("custom cwd");

		// `list` stays a one-line summary; `get` adds the operational flags. Both
		// keep secrets (URL paths, argv) out.
		const list = await runMcpManagementCommand(["list"], manager);
		expect(list.message).not.toContain("oauth");
		expect(list.message).not.toContain("custom cwd");
		expect(getRemote.message).not.toContain("example.test");
		expect(getLocal.message).not.toContain("server.js");
	});

	it("reports get/remove not found and removes live entries", async () => {
		const manager = SettingsManager.inMemory({});
		await expect(runMcpManagementCommand(["get", "missing"], manager)).rejects.toThrow("not found");
		await expect(runMcpManagementCommand(["remove", "missing"], manager)).rejects.toThrow("not found");
		await runMcpManagementCommand(["add", "local", "--", "node", "server.js"], manager);
		await expect(runMcpManagementCommand(["get", "local"], manager)).resolves.toMatchObject({
			message: "local: stdio",
		});
		await runMcpManagementCommand(["remove", "local"], manager);
		expect(manager.getGlobalMcpServers()).toEqual({});
	});
});
