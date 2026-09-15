import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolation mirrors test/tools-manager.test.ts: the tools directory is redirected through
// a config.js mock, the host platform through an os mock, zip unpacking through an
// extract-zip mock, and every response byte through a URL-routed fetch stub. Nothing in
// this file reaches the network.
const toolState = vi.hoisted(() => ({
	toolsDir: `/tmp/prime-agent-tools-pinning-${process.pid}`,
	platform: "linux",
	architecture: "x64",
	extractZip: async (_source: string, _options: { dir: string }): Promise<void> => {},
}));

vi.mock("../src/config.js", () => ({
	APP_NAME: "prime-agent",
	getBinDir: () => toolState.toolsDir,
}));

vi.mock("node:os", () => ({
	arch: () => toolState.architecture,
	platform: () => toolState.platform,
}));

vi.mock("extract-zip", () => ({
	default: (source: string, options: { dir: string }) => toolState.extractZip(source, options),
}));

// Namespace import so this file still evaluates against an implementation that has no pin
// table (the red run). Pin values are read from the module under test, never copied here.
import * as toolsManager from "../src/utils/tools-manager.js";

type ToolsManagerModule = typeof toolsManager & {
	PINNED_TOOL_VERSIONS?: Record<"fd" | "rg", string>;
	PINNED_TOOL_SHA256?: Record<string, string>;
};

const pins = toolsManager as ToolsManagerModule;
const pinnedVersions: Record<string, string> = pins.PINNED_TOOL_VERSIONS ?? {};
const pinnedSha256: Record<string, string> = pins.PINNED_TOOL_SHA256 ?? {};
const PINNED_TARGETS = ["darwin|arm64", "darwin|x64", "linux|arm64", "linux|x64", "win32|arm64", "win32|x64"];

const originalPath = process.env.PATH;
const originalOffline = process.env.PI_OFFLINE;
const originalFloating = process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING;
const pathDir = join(toolState.toolsDir, "path");

// Provisioning extracts tar.gz archives with the host `tar`, and these tests stub PATH to
// an otherwise empty directory, so the fixture builder and the implementation share one
// resolvable tar.
const hostTarPath = ["/usr/bin/tar", "/bin/tar"].find((candidate) => existsSync(candidate)) ?? "";
const HOST_CAN_EXTRACT_TARBALLS = hostTarPath !== "";

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeExecutable(filePath: string, exitCode = 0): void {
	writeFileSync(filePath, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
	chmodSync(filePath, 0o755);
}

// A real tar.gz built with the host tar, so the production extraction path is exercised.
function makeTarGz(binaryName: string, exitCode = 0): Uint8Array {
	const stage = join(toolState.toolsDir, `build_${process.pid}_${Math.random().toString(36).slice(2, 10)}`);
	mkdirSync(join(stage, "pkg"), { recursive: true });
	writeExecutable(join(stage, "pkg", binaryName), exitCode);
	const archive = join(stage, "pkg.tar.gz");
	const result = spawnSync(hostTarPath, ["czf", archive, "-C", stage, "pkg"], { stdio: "pipe" });
	if (result.error || result.status !== 0) {
		const reason = result.error?.message ?? result.stderr?.toString().trim() ?? String(result.status);
		throw new Error(`fixture tar.gz build failed: ${reason}`);
	}
	const bytes = new Uint8Array(readFileSync(archive));
	rmSync(stage, { recursive: true, force: true });
	return bytes;
}

function archiveRequests(urls: string[]): string[] {
	return urls.filter((url) => url.includes("/releases/download/") && !url.endsWith(".sha256"));
}

function checksumRequests(urls: string[]): string[] {
	return urls.filter((url) => url.endsWith(".sha256"));
}

function isExecutableFile(filePath: string): boolean {
	return existsSync(filePath) && (statSync(filePath).mode & 0o111) !== 0;
}

function provisioningLeftovers(): string[] {
	return readdirSync(toolState.toolsDir).filter((name) => name !== "path");
}

interface Route {
	match: RegExp;
	reply: () => { status?: number; body?: Uint8Array | string };
}

// URL-routed fetch stub. Records every requested URL, so each case can state exactly which
// endpoints provisioning is allowed to hit.
function stubFetch(routes: Route[]) {
	const urls: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		urls.push(url);
		for (const route of routes) {
			if (route.match.test(url)) {
				const { status = 200, body = "" } = route.reply();
				return new Response(body, { status });
			}
		}
		return new Response("unexpected request", { status: 599 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { urls, fetchMock };
}

describe("tools-manager release pinning", () => {
	beforeEach(() => {
		rmSync(toolState.toolsDir, { recursive: true, force: true });
		mkdirSync(pathDir, { recursive: true });
		if (HOST_CAN_EXTRACT_TARBALLS) {
			const tarShim = join(pathDir, "tar");
			if (!existsSync(tarShim)) symlinkSync(hostTarPath, tarShim);
		}
		process.env.PATH = pathDir;
		delete process.env.PI_OFFLINE;
		delete process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING;
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

	it("pins a version and a digest for every supported tool target", () => {
		expect(Object.keys(pinnedVersions).sort()).toEqual(["fd", "rg"]);
		for (const tool of ["fd", "rg"] as const) {
			expect(pinnedVersions[tool], `pinned ${tool} version`).toMatch(/^\d+\.\d+\.\d+$/);
			for (const target of PINNED_TARGETS) {
				expect(pinnedSha256[`${tool}|${target}`], `${tool} digest for ${target}`).toMatch(/^[0-9a-f]{64}$/);
			}
		}
		expect(Object.keys(pinnedSha256).length).toBe(PINNED_TARGETS.length * 2);
	});

	it("provisions ripgrep from the pinned release instead of asking GitHub for the latest", async () => {
		const pinnedRg = pinnedVersions.rg ?? "";
		// Deliberately wrong bytes: this case is only about which URLs get requested.
		const { urls } = stubFetch([{ match: /.*/, reply: () => ({ body: new Uint8Array([0xde, 0xad]) }) }]);

		await toolsManager.ensureToolWithStatus("rg");

		expect(urls.length, `expected a download request, saw ${JSON.stringify(urls)}`).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url, `must not resolve versions through the GitHub API: ${url}`).not.toContain("api.github.com");
			expect(url, `must not track a moving release tag: ${url}`).not.toContain("releases/latest");
		}
		expect(pinnedRg, "the implementation must export the pinned ripgrep version it downloads").toMatch(
			/^\d+\.\d+\.\d+$/,
		);
		expect(urls[0]).toMatch(new RegExp(`/releases/download/v?${pinnedRg}/`));
	});

	it("provisions fd from its own pinned release version", async () => {
		const pinnedFd = pinnedVersions.fd ?? "";
		const { urls } = stubFetch([{ match: /.*/, reply: () => ({ body: new Uint8Array([0xde, 0xad]) }) }]);

		await toolsManager.ensureToolWithStatus("fd");

		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) expect(url, url).not.toContain("releases/latest");
		expect(pinnedFd, "the implementation must export the pinned fd version it downloads").toMatch(/^\d+\.\d+\.\d+$/);
		expect(urls[0]).toMatch(new RegExp(`/releases/download/v?${pinnedFd}/`));
		expect(urls[0]).toContain(`fd-v${pinnedFd}-`);
	});

	it.skipIf(!HOST_CAN_EXTRACT_TARBALLS)(
		"rejects a tampered archive before extracting, chmodding or running it",
		async () => {
			toolState.platform = "win32";
			let extractCalls = 0;
			toolState.extractZip = async (_source, options) => {
				extractCalls += 1;
				writeExecutable(join(options.dir, "rg.exe"));
			};
			// A well-formed archive whose bytes are not the ones the pin describes.
			const tampered = makeTarGz("rg.exe");
			tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
			const digest = sha256Of(tampered);
			expect(digest).not.toBe(pinnedSha256["rg|win32|x64"]);
			// The api.github.com route exists only so that an implementation which still resolves
			// versions through the API runs end to end: it then installs these tampered bytes.
			stubFetch([
				{
					match: /api\.github\.com/,
					reply: () => ({ body: JSON.stringify({ tag_name: `v${pinnedVersions.rg ?? "15.2.0"}` }) }),
				},
				{ match: /releases\/download/, reply: () => ({ body: tampered }) },
			]);

			const result = await toolsManager.ensureToolWithStatus("rg");

			expect(result.status).toBe("unavailable");
			if (result.status === "unavailable") {
				expect(result.reason).toBe("download_failed");
				expect(result.detail).toMatch(/sha256/i);
			}
			expect(extractCalls, "an archive that fails its checksum must never be unpacked").toBe(0);
			expect(isExecutableFile(join(toolState.toolsDir, "rg.exe"))).toBe(false);
			expect(provisioningLeftovers()).toEqual([]);
		},
	);

	it.skipIf(!HOST_CAN_EXTRACT_TARBALLS)("installs an archive only after its checksum has been checked", async () => {
		// The floating escape hatch plus its checksum endpoint: this drives the whole
		// download -> verify -> extract -> chmod -> version-probe pipeline to success.
		process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING = "1";
		const archive = makeTarGz("rg");
		const digest = sha256Of(archive);
		const { urls } = stubFetch([
			{
				match: /api\.github\.com.*releases\/latest$/,
				reply: () => ({ body: JSON.stringify({ tag_name: "15.9.9" }) }),
			},
			{
				match: /\.sha256$/,
				reply: () => ({ body: `${digest}  ripgrep-15.9.9-x86_64-unknown-linux-musl.tar.gz\n` }),
			},
			{ match: /releases\/download/, reply: () => ({ body: archive }) },
		]);

		const result = await toolsManager.ensureToolWithStatus("rg");

		expect(result).toEqual({ status: "available", path: join(toolState.toolsDir, "rg") });
		expect(isExecutableFile(join(toolState.toolsDir, "rg"))).toBe(true);
		expect(checksumRequests(urls).length, `expected one checksum fetch in ${JSON.stringify(urls)}`).toBe(1);
		expect(archiveRequests(urls).length, `expected one archive fetch in ${JSON.stringify(urls)}`).toBe(1);
		expect(urls.indexOf(checksumRequests(urls)[0] as string)).toBeLessThan(
			urls.indexOf(archiveRequests(urls)[0] as string),
		);
		expect(provisioningLeftovers()).toEqual(["rg"]);
	});

	it("refuses a floating release whose published checksum cannot be fetched", async () => {
		process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING = "1";
		const { urls } = stubFetch([
			{
				match: /api\.github\.com.*releases\/latest$/,
				reply: () => ({ body: JSON.stringify({ tag_name: "99.0.0" }) }),
			},
			{ match: /\.sha256$/, reply: () => ({ status: 404, body: "Not Found" }) },
			{ match: /releases\/download/, reply: () => ({ body: makeTarGz("rg") }) },
		]);

		const result = await toolsManager.ensureToolWithStatus("rg");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") expect(result.reason).toBe("download_failed");
		expect(archiveRequests(urls), "no payload may be fetched before its checksum resolves").toEqual([]);
		expect(existsSync(join(toolState.toolsDir, "rg"))).toBe(false);
	});

	it("refuses a target with no pinned digest instead of downloading it unverified", async () => {
		toolState.architecture = "arm"; // no asset name and no digest for linux/arm
		const { urls, fetchMock } = stubFetch([{ match: /.*/, reply: () => ({ body: new Uint8Array([1]) }) }]);

		const result = await toolsManager.ensureToolWithStatus("rg");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") {
			expect(["unsupported_platform", "download_failed", "manual_install_required"]).toContain(result.reason);
			expect(result.detail).toMatch(/manual/i);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(urls).toEqual([]);
		expect(existsSync(join(toolState.toolsDir, "rg"))).toBe(false);
	});

	it("deletes the downloaded archive when its digest does not match", async () => {
		const { urls } = stubFetch([
			{
				match: /api\.github\.com/,
				reply: () => ({ body: JSON.stringify({ tag_name: `v${pinnedVersions.fd ?? "10.5.0"}` }) }),
			},
			{ match: /releases\/download/, reply: () => ({ body: new Uint8Array([1, 2, 3]) }) },
		]);

		const result = await toolsManager.ensureToolWithStatus("fd");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") expect(result.detail).toMatch(/sha256/i);
		expect(urls.length).toBe(1);
		expect(provisioningLeftovers()).toEqual([]);
	});
});
