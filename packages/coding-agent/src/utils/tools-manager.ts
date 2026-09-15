import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import extractZip from "extract-zip";
import { APP_NAME, getBinDir } from "../config.js";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 5_000;
const RIPGREP_INSTALL_URL = "https://github.com/BurntSushi/ripgrep#installation";

// Managed helper binaries are downloaded and then executed, so both the release
// version and the exact asset bytes are pinned in this file. Nothing here queries
// `api.github.com/repos/<repo>/releases/latest` any more: that endpoint hands out
// whatever upstream publishes at the moment, and the old code ran those bytes with
// no integrity check at all.
//
// To refresh a pin: download the asset for each (tool, platform, architecture) over
// HTTPS from the pinned release, record `sha256 <asset>`, and confirm ripgrep values
// against the official `<asset>.sha256` sidecars published in the same release.
// `sharkdp/fd` publishes no sidecars, so its digests are recorded from the release
// assets themselves (trust-on-first-use) and every digest below is tagged with the
// URL it was taken from. A missing or malformed entry is a hard failure, never a
// "download it anyway" fallback.
export const PINNED_TOOL_VERSIONS: Record<ManagedTool, string> = {
	fd: "10.5.0",
	rg: "15.2.0",
};

// Keyed by `<tool>|<platform>|<architecture>`, using node:os `platform()` / `arch()`
// values (darwin|linux|win32, arm64|x64). Platforms and architectures not listed here
// are refused before anything is downloaded.
export const PINNED_TOOL_SHA256: Record<string, string> = {
	// b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-aarch64-apple-darwin.tar.gz
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|darwin|arm64": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
	// 7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-apple-darwin.tar.gz
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|darwin|x64": "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
	// c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|linux|arm64": "c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c",
	// a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|linux|x64": "a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95",
	// a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-aarch64-pc-windows-msvc.zip
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|win32|arm64": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
	// a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7  https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip
	//     checksum source: HTTPS release asset (fd publishes no sidecar)
	"fd|win32|x64": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
	// 3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz
	//     checksum source: official ripgrep-15.2.0-aarch64-apple-darwin.tar.gz.sha256 sidecar
	"rg|darwin|arm64": "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
	// af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz
	//     checksum source: official ripgrep-15.2.0-x86_64-apple-darwin.tar.gz.sha256 sidecar
	"rg|darwin|x64": "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
	// a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz
	//     checksum source: official ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz.sha256 sidecar
	"rg|linux|arm64": "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
	// 33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz
	//     checksum source: official ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz.sha256 sidecar
	"rg|linux|x64": "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
	// e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-pc-windows-msvc.zip
	//     checksum source: official ripgrep-15.2.0-aarch64-pc-windows-msvc.zip.sha256 sidecar
	"rg|win32|arm64": "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
	// 71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5  https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip
	//     checksum source: official ripgrep-15.2.0-x86_64-pc-windows-msvc.zip.sha256 sidecar
	"rg|win32|x64": "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
};

export type ManagedTool = "fd" | "rg";
export type ToolUnavailableReason = "offline" | "manual_install_required" | "unsupported_platform" | "download_failed";

export interface ToolAvailableResult {
	status: "available";
	path: string;
}

export interface ToolUnavailableResult {
	status: "unavailable";
	reason: ToolUnavailableReason;
	platform: string;
	architecture: string;
	detail?: string;
}

export type ToolEnsureResult = ToolAvailableResult | ToolUnavailableResult;

function isEnvFlagEnabled(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isOfflineModeEnabled(): boolean {
	return isEnvFlagEnabled(process.env.PI_OFFLINE);
}

// Escape hatch, off by default. `PRIME_AGENT_TOOLS_ALLOW_FLOATING=1` resolves the
// version from `api.github.com/repos/<repo>/releases/latest` again. This is a
// DEGRADED path, kept only so operators can track upstream without a code change: the
// version is whatever upstream publishes at that moment. It still has to produce a
// pinned digest, or one from the release's own `<asset>.sha256` sidecar; a floating
// download is never executed unverified.
function isFloatingVersionEnabled(): boolean {
	return isEnvFlagEnabled(process.env.PRIME_AGENT_TOOLS_ALLOW_FLOATING);
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Release tag prefix (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
	installHint: string; // Shown when a pinned asset is missing or failed verification
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		installHint: "Install fd manually: https://github.com/sharkdp/fd#installation",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		installHint: RIPGREP_INSTALL_URL,
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return architecture === "x64" ? `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz` : null;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

// Check that a command both launches and reports a successful version.
function commandWorks(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe", timeout: COMMAND_TIMEOUT_MS });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ManagedTool): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath) && commandWorks(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandWorks(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Degraded path only (see isFloatingVersionEnabled): ask GitHub which release is latest.
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

// Fetch the checksum that the release itself publishes next to the asset
// (`<asset>.sha256`). Both the `<hex>  <file>` and the Windows `CertUtil: -hashfile`
// layouts are accepted; the first bare 64-hex token in the file wins.
function parsePublishedChecksum(body: string, assetName: string): string {
	const match = body.match(/\b[0-9a-fA-F]{64}\b/);
	if (!match) {
		throw new Error(`No SHA256 checksum found in the published checksum file for ${assetName}`);
	}
	return match[0].toLowerCase();
}

async function fetchPublishedChecksum(downloadUrl: string, assetName: string): Promise<string> {
	const response = await fetch(`${downloadUrl}.sha256`, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Could not fetch the published SHA256 checksum for ${assetName} (HTTP ${response.status})`);
	}
	return parsePublishedChecksum(await response.text(), assetName);
}

// Digests are computed in-process with node:crypto, so verification cannot be skipped
// by a missing external sha256sum/shasum. Anything other than an exact match (unreadable
// file, malformed pin, mismatching digest) throws, and the caller deletes the download.
function assertPinnedChecksum(sha256: string, assetName: string): string {
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error(`Pinned SHA256 for ${assetName} is not a 64-character hex digest; refusing to install`);
	}
	return sha256;
}

function verifyFileChecksum(filePath: string, expectedSha256: string, assetName: string): void {
	const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
	if (digest !== expectedSha256) {
		throw new Error(`SHA256 mismatch for ${assetName}: expected ${expectedSha256}, got ${digest}`);
	}
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

// Download and install a tool
class UnsupportedToolPlatformError extends Error {}
class UnverifiedToolAssetError extends Error {}

function manualInstallHint(config: ToolConfig): string {
	return `Install ${config.name} manually: ${config.installHint}`;
}

async function downloadTool(tool: ManagedTool): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();
	const floating = isFloatingVersionEnabled();

	// Pinned by default: the version is a constant here, not a GitHub API answer.
	const pinnedVersion = PINNED_TOOL_VERSIONS[tool];
	const version = floating ? await getLatestVersion(config.repo) : pinnedVersion;
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new UnsupportedToolPlatformError(
			`No pinned ${config.name} asset for ${plat}/${architecture}. ${manualInstallHint(config)}`,
		);
	}

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const pinKey = `${tool}|${plat}|${architecture}`;

	// Resolve the digest to check the download against before touching it. On the pinned
	// path the digest must come from the pin table; an unpinned target is refused rather
	// than downloaded unverified.
	let expectedSha256: string | undefined = PINNED_TOOL_SHA256[pinKey];
	if (version !== pinnedVersion) expectedSha256 = undefined; // floating to a newer release: re-check via its sidecar
	if (expectedSha256) {
		assertPinnedChecksum(expectedSha256, assetName);
	} else if (!floating) {
		throw new UnverifiedToolAssetError(
			`No pinned SHA256 for ${assetName} (${plat}/${architecture}); refusing to download an unverified binary. ${manualInstallHint(config)}`,
		);
	}

	mkdirSync(TOOLS_DIR, { recursive: true });

	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	if (!expectedSha256) {
		expectedSha256 = assertPinnedChecksum(await fetchPublishedChecksum(downloadUrl, assetName), assetName);
	}

	// Download, then verify. Extraction, chmod and the version probe all happen only
	// after the digest matched; any failure deletes the download and never executes it.
	await downloadFile(downloadUrl, archivePath);
	try {
		verifyFileChecksum(archivePath, expectedSha256, assetName);
	} catch (error) {
		rmSync(archivePath, { force: true });
		throw error;
	}

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			const extractResult = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
			if (extractResult.error || extractResult.status !== 0) {
				const errMsg = extractResult.error?.message ?? extractResult.stderr?.toString().trim() ?? "unknown error";
				throw new Error(`Failed to extract ${assetName}: ${errMsg}`);
			}
		} else if (assetName.endsWith(".zip")) {
			await extractZip(archivePath, { dir: extractDir });
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			rmSync(binaryPath, { force: true });
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
		if (!commandWorks(binaryPath)) {
			rmSync(binaryPath, { force: true });
			throw new Error(`Installed ${config.name} binary failed its version check`);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

function getRipgrepInstallHint(platformName: string): string {
	switch (platformName) {
		case "darwin":
			return "Install it with: brew install ripgrep";
		case "linux":
			return `Install it with your package manager (for example, sudo apt install ripgrep or sudo dnf install ripgrep). See ${RIPGREP_INSTALL_URL}`;
		case "win32":
			return "Install it with: winget install BurntSushi.ripgrep.MSVC";
		case "android":
			return "Install it with: pkg install ripgrep";
		default:
			return `Install ripgrep manually: ${RIPGREP_INSTALL_URL}`;
	}
}

export function formatMissingRipgrepMessage(result: ToolUnavailableResult): string {
	let reason: string;
	switch (result.reason) {
		case "offline":
			reason = "Automatic installation was skipped because PI_OFFLINE is enabled.";
			break;
		case "manual_install_required":
			reason = "Prime Agent cannot install this helper automatically in Termux.";
			break;
		case "unsupported_platform": {
			reason = `Automatic installation is unavailable for ${result.platform}/${result.architecture}.`;
			const detail = result.detail?.replace(/\s+/g, " ").trim();
			if (detail) reason = `${reason} ${detail}`;
			break;
		}
		case "download_failed": {
			const detail = result.detail?.replace(/\s+/g, " ").trim();
			reason = detail
				? `Prime Agent could not install it automatically: ${detail}`
				: "Prime Agent could not install it automatically.";
			break;
		}
	}

	return [
		"ripgrep (rg) is an optional search helper. Without it, model-run file searches may be slower or fail; Prime Agent and subagents remain available.",
		reason,
		getRipgrepInstallHint(result.platform),
	].join("\n");
}

// Ensure a tool is available, downloading if necessary, and retain why provisioning failed.
export async function ensureToolWithStatus(tool: ManagedTool, silent: boolean = true): Promise<ToolEnsureResult> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return { status: "available", path: existingPath };
	}

	const config = TOOLS[tool];
	const platformName = platform();
	const architecture = arch();

	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return { status: "unavailable", reason: "offline", platform: platformName, architecture };
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platformName === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return {
			status: "unavailable",
			reason: "manual_install_required",
			platform: platformName,
			architecture,
		};
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return { status: "available", path };
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return {
			status: "unavailable",
			reason: e instanceof UnsupportedToolPlatformError ? "unsupported_platform" : "download_failed",
			platform: platformName,
			architecture,
			detail: e instanceof Error ? e.message : String(e),
		};
	}
}

// Compatibility wrapper for callers that only need the resolved executable path.
export async function ensureTool(tool: ManagedTool, silent: boolean = true): Promise<string | undefined> {
	const result = await ensureToolWithStatus(tool, silent);
	return result.status === "available" ? result.path : undefined;
}
