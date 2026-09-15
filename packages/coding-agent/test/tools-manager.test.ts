import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolState = vi.hoisted(() => ({
	toolsDir: `/tmp/prime-agent-tools-manager-${process.pid}`,
	platform: "linux",
	architecture: "x64",
	extractZip: async (_source: string, _options: { dir: string }): Promise<void> => {},
}));

vi.mock("../src/config.js", () => ({
	APP_NAME: "prime-agent",
	getBinDir: () => toolState.toolsDir,
}));

vi.mock("os", () => ({
	arch: () => toolState.architecture,
	platform: () => toolState.platform,
}));

vi.mock("extract-zip", () => ({
	default: (source: string, options: { dir: string }) => toolState.extractZip(source, options),
}));

import {
	ensureToolWithStatus,
	formatMissingRipgrepMessage,
	getToolPath,
	type ToolUnavailableResult,
} from "../src/utils/tools-manager.js";

const originalPath = process.env.PATH;
const originalOffline = process.env.PI_OFFLINE;
const originalFloating = process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING;
const pathDir = join(toolState.toolsDir, "path");

function writeExecutable(filePath: string, exitCode = 0): void {
	writeFileSync(filePath, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
	chmodSync(filePath, 0o755);
}

function unavailable(
	platform: string,
	reason: ToolUnavailableResult["reason"] = "download_failed",
): ToolUnavailableResult {
	return { status: "unavailable", reason, platform, architecture: "x64" };
}

describe("tools manager", () => {
	beforeEach(() => {
		rmSync(toolState.toolsDir, { recursive: true, force: true });
		mkdirSync(pathDir, { recursive: true });
		process.env.PATH = pathDir;
		delete process.env.PI_OFFLINE;
		toolState.platform = "linux";
		toolState.architecture = "x64";
		toolState.extractZip = async () => {};
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		if (originalFloating === undefined) delete process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING;
		else process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING = originalFloating;
		rmSync(toolState.toolsDir, { recursive: true, force: true });
	});

	it("accepts managed and PATH tools only when their version check succeeds", () => {
		const managedPath = join(toolState.toolsDir, "rg");
		writeExecutable(managedPath);
		expect(getToolPath("rg")).toBe(managedPath);

		writeExecutable(managedPath, 1);
		const pathBinary = join(pathDir, "rg");
		writeExecutable(pathBinary);
		expect(getToolPath("rg")).toBe("rg");

		writeExecutable(pathBinary, 1);
		expect(getToolPath("rg")).toBeNull();
	});

	it("reports offline and Termux provisioning constraints", async () => {
		process.env.PI_OFFLINE = "1";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "offline",
			platform: "linux",
		});

		delete process.env.PI_OFFLINE;
		toolState.platform = "android";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "manual_install_required",
			platform: "android",
		});
	});

	it("distinguishes unsupported targets from download failures", async () => {
		toolState.platform = "freebsd";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "unsupported_platform",
		});

		toolState.platform = "linux";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("network unavailable"))),
		);
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "download_failed",
			detail: "network unavailable",
		});
	});

	it("validates a downloaded binary before reporting it available", async () => {
		toolState.platform = "win32";
		// Downloads are digest-pinned now, so this case reaches the binary check through the
		// floating path: its checksum sidecar is what lets a synthetic archive be well-formed.
		process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING = "1";
		writeExecutable(join(toolState.toolsDir, "rg.exe"), 1);
		const archive = new Uint8Array([1]);
		const digest = createHash("sha256").update(archive).digest("hex");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ tag_name: "15.1.0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(`${digest}  ripgrep-15.1.0-x86_64-pc-windows-msvc.zip\n`, { status: 200 }))
			.mockResolvedValueOnce(new Response(archive, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		toolState.extractZip = async (_source, options) => {
			writeExecutable(join(options.dir, "rg.exe"));
		};

		await expect(ensureToolWithStatus("rg")).resolves.toEqual({
			status: "available",
			path: join(toolState.toolsDir, "rg.exe"),
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("removes a downloaded binary that fails its version check", async () => {
		toolState.platform = "win32";
		// X-11: the version probe only runs after a digest-verified download, and on the
		// pinned lane the digest must match the pin table, which a fixture archive never
		// does. The case used to idle there: the checksum refusal produced the same
		// assertions while extraction and the version probe never ran, so the test only
		// executed its proposition when the parent environment happened to set the
		// floating flag - and then the same parent env also decided the digest lane, a
		// self-attestation. The floating lane is the only lane whose digest a fixture can
		// satisfy (its published sidecar), so this case declares the flag explicitly
		// instead of inheriting the parent environment; the afterEach restore keeps the
		// parent environment - and the pin-table digest lane - authoritative for every
		// other case in this file.
		process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING = "1";
		const archive = new Uint8Array([1]);
		const digest = createHash("sha256").update(archive).digest("hex");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ tag_name: "15.1.0" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(new Response(`${digest}  ripgrep-15.1.0-x64-pc-windows-msvc.zip\n`, { status: 200 }))
				.mockResolvedValueOnce(new Response(archive, { status: 200 })),
		);
		let extractCalls = 0;
		toolState.extractZip = async (_source, options) => {
			extractCalls += 1;
			writeExecutable(join(options.dir, "rg.exe"), 1);
		};

		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "download_failed",
		});
		expect(existsSync(join(toolState.toolsDir, "rg.exe"))).toBe(false);
		expect(extractCalls, "version-probe removal path was exercised").toBeGreaterThan(0);
	});

	it("formats actionable platform-specific ripgrep warnings", () => {
		const mac = formatMissingRipgrepMessage(unavailable("darwin"));
		const linux = formatMissingRipgrepMessage(unavailable("linux"));
		const windows = formatMissingRipgrepMessage(unavailable("win32"));
		const termux = formatMissingRipgrepMessage(unavailable("android", "manual_install_required"));

		expect(mac).toContain("brew install ripgrep");
		expect(linux).toContain("sudo apt install ripgrep");
		expect(linux).toContain("sudo dnf install ripgrep");
		expect(windows).toContain("winget install BurntSushi.ripgrep.MSVC");
		expect(termux).toContain("pkg install ripgrep");
		expect(mac).toContain("Prime Agent and subagents remain available");
	});
});
