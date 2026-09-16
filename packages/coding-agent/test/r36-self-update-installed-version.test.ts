import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR, SELF_UPDATE_INTERACTIVE_CHILD_ENV, VERSION } from "../src/config.js";
import { main } from "../src/main.js";

// r36 INS-2: the "Updated ... to vY" receipt must not copy the manifest's targetVersion
// when the installed CLI on disk reports a different version. The fake npm below writes
// the version a real install would have produced, so the receipt can be checked against it.
const UPDATE_ARTIFACT_BYTES = Buffer.from("prime-agent release payload");
const UPDATE_ARTIFACT_SHA256 = createHash("sha256").update(UPDATE_ARTIFACT_BYTES).digest("hex");
const UPDATE_DOWNLOAD_BASE_URL = "https://downloads.example.test/prime-agent";
const TARGET_VERSION = "99.99.99";

function stubReleaseFetch(manifest: Record<string, unknown>): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: Request | string | URL) =>
		String(input).endsWith(".json") ? Response.json(manifest) : new Response(UPDATE_ARTIFACT_BYTES),
	);
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function runSelfUpdateInstallChild(args: string[]): Promise<void> {
	const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
	try {
		await main(args);
	} finally {
		restoreEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, previousValue);
	}
}

describe("self-update install receipt version check", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let globalPrefix: string;
	let selfPackageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalDownloadBaseUrl: string | undefined;
	let originalTrustedUpdateOrigins: string | undefined;
	let originalTmpDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;
	let nodeInstallArgsValue: string[] | undefined;

	async function runSelfUpdateWithInstalledVersion(
		installedVersion: string,
	): Promise<{ stdout: string; stderr: string }> {
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) { console.log(path.join(prefix,"lib","node_modules")); process.exit(0); }
fs.writeFileSync(path.join(${JSON.stringify(selfPackageDir)},"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent",version:${JSON.stringify(installedVersion)}}));
fs.writeFileSync(${JSON.stringify(join(tempDir, "install-args.json"))},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [process.execPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = stubReleaseFetch({
			tarball: "prime-agent-current.tgz",
			sha256: UPDATE_ARTIFACT_SHA256,
			version: TARGET_VERSION,
		});
		vi.stubGlobal("fetch", fetchMock);

		const logLines: string[] = [];
		const errorLines: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
			logLines.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			errorLines.push(String(message));
		});
		try {
			await runSelfUpdateInstallChild(["update", "--self", "--force"]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
		nodeInstallArgsValue = JSON.parse(readFileSync(join(tempDir, "install-args.json"), "utf-8")) as string[];
		return { stdout: logLines.join("\n"), stderr: errorLines.join("\n") };
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `r36-self-update-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		globalPrefix = join(tempDir, "global-prefix");
		selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(selfPackageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
		originalTrustedUpdateOrigins = process.env.PRIME_AGENT_TRUSTED_UPDATE_ORIGINS;
		originalTmpDir = process.env.TMPDIR;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		nodeInstallArgsValue = undefined;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.TMPDIR = tempDir;
		// The fork self-update gate keys off this checkout's marker file; these tests
		// exercise the official update path, so the gate is switched off here.
		process.env.PRIME_AGENT_FORK_GATE = "off";
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = UPDATE_DOWNLOAD_BASE_URL;
		process.env.PRIME_AGENT_TRUSTED_UPDATE_ORIGINS = UPDATE_DOWNLOAD_BASE_URL;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.PRIME_AGENT_FORK_GATE;
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv("PI_PACKAGE_DIR", originalPiPackageDir);
		restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalDownloadBaseUrl);
		restoreEnv("PRIME_AGENT_TRUSTED_UPDATE_ORIGINS", originalTrustedUpdateOrigins);
		restoreEnv("TMPDIR", originalTmpDir);
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports the version mismatch when the installed CLI differs from the manifest target", async () => {
		const { stdout, stderr } = await runSelfUpdateWithInstalledVersion("88.0.0");

		// The install really ran through the fake package manager.
		expect(nodeInstallArgsValue?.join(" ")).toContain("prime-agent-current.tgz");
		// The receipt must not claim the manifest's target version as installed.
		expect(stdout).not.toContain(`to v${TARGET_VERSION}`);
		// It must state what actually landed on disk instead.
		expect(stdout).toContain("Updated");
		expect(stderr).toContain("88.0.0");
		expect(stderr).toContain(TARGET_VERSION);
	});

	it("prints the target version when the installed CLI matches the manifest", async () => {
		const { stdout, stderr } = await runSelfUpdateWithInstalledVersion(TARGET_VERSION);

		expect(stdout).toContain(`Updated ${APP_NAME} from v${VERSION} to v${TARGET_VERSION}`);
		expect(stderr).not.toContain("Warning");
	});
});
