import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	psCalls: [] as boolean[],
}));

vi.mock("../src/cli/daemon-ps.js", () => ({
	runPs: async (json: boolean) => {
		mocks.psCalls.push(json);
	},
	runReap: async () => {},
	runShutdownSelection: async () => {},
	discoverDaemons: async () => [],
}));

import { collectReadonlyDoctorChecks, type DoctorCheck, type DoctorCheckRoots } from "../src/cli/doctor-checks.js";
import { handlePublicCommand } from "../src/cli/public-command.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";

const KERNEL_VENV_ENV = "PRIME_AGENT_KERNEL_VENV";
const KERNEL_PYTHON_ENV = "PRIME_AGENT_KERNEL_PYTHON";

interface Fixture {
	roots: DoctorCheckRoots;
	dir: string;
}

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "pi-doctor-"));
	const agentDir = join(dir, "agent");
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	return {
		roots: {
			agentDir,
			authPath: join(agentDir, "auth.json"),
			sessionsDir,
			kernelVenvDir: join(agentDir, "kernel-venv"),
		},
		dir,
	};
}

function disposeFixture(fixture: Fixture): void {
	rmSync(fixture.dir, { recursive: true, force: true });
}

function writeHealthyAuth(roots: DoctorCheckRoots): void {
	writeFileSync(
		roots.authPath,
		JSON.stringify({
			anthropic: { type: "api_key", key: "sk-ant-test-secret-value" },
			openai: { type: "api_key", key: "sk-openai-test-secret-value" },
		}),
	);
}

function writeGoodSession(sessionsDir: string, id: string): string {
	const file = join(sessionsDir, `${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-15T00:00:00.000Z", cwd: "/tmp" })}\n`,
	);
	return file;
}

function writeVenvGeneration(roots: DoctorCheckRoots, suffix = "0123456789ab"): string {
	const generationDir = `${roots.kernelVenvDir}-${suffix}`;
	const binDir = join(generationDir, process.platform === "win32" ? "Scripts" : "bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(generationDir, "pyvenv.cfg"), "home = /usr\n");
	const interpreter = join(binDir, process.platform === "win32" ? "python.exe" : "python");
	writeFileSync(interpreter, "#!/bin/sh\n");
	chmodSync(interpreter, 0o755);
	return interpreter;
}

function byId(checks: readonly DoctorCheck[], id: string): DoctorCheck {
	const check = checks.find((candidate) => candidate.id === id);
	if (!check) throw new Error(`missing doctor check: ${id} (got ${checks.map((c) => c.id).join(", ")})`);
	return check;
}

describe("read-only doctor checks", () => {
	let fixture: Fixture;

	beforeEach(() => {
		fixture = makeFixture();
	});

	afterEach(() => {
		disposeFixture(fixture);
	});

	it("reports every check healthy on a healthy fixture", () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		writeGoodSession(fixture.roots.sessionsDir, "bbbbbbbb");
		writeVenvGeneration(fixture.roots);

		const checks = collectReadonlyDoctorChecks(fixture.roots);

		expect(checks.length).toBeGreaterThanOrEqual(3);
		expect(checks.every((check) => check.status === "ok")).toBe(true);
		expect(byId(checks, "auth").detail).toContain("2 provider credential");
		expect(byId(checks, "kernel-venv").detail).toContain("interpreter");
		expect(byId(checks, "sessions").detail).toContain("2 session file");
	});

	it("flags a missing auth.json as not logged in with login guidance", () => {
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		writeVenvGeneration(fixture.roots);

		const auth = byId(collectReadonlyDoctorChecks(fixture.roots), "auth");

		expect(auth.status).not.toBe("ok");
		expect(auth.detail).toContain("auth.json");
		expect(auth.next).toContain("/login");
	});

	it("flags an unparseable auth.json as failing", () => {
		writeFileSync(fixture.roots.authPath, "{ not valid json");

		const auth = byId(collectReadonlyDoctorChecks(fixture.roots), "auth");

		expect(auth.status).toBe("fail");
		expect(auth.detail).toContain("valid JSON");
		expect(auth.next.length).toBeGreaterThan(0);
	});

	it("flags an auth.json with no usable credentials", () => {
		writeFileSync(fixture.roots.authPath, JSON.stringify({ anthropic: { type: "bogus" } }));

		const auth = byId(collectReadonlyDoctorChecks(fixture.roots), "auth");

		expect(auth.status).not.toBe("ok");
		expect(auth.detail).toContain("no usable");
	});

	it("never echoes stored secrets in auth details", () => {
		writeHealthyAuth(fixture.roots);

		const checks = collectReadonlyDoctorChecks(fixture.roots);
		const rendered = JSON.stringify(checks);

		expect(rendered).not.toContain("sk-ant-test-secret-value");
		expect(rendered).not.toContain("sk-openai-test-secret-value");
		expect(byId(checks, "auth").status).toBe("ok");
	});

	it("flags a kernel venv directory without an interpreter as failing", () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		mkdirSync(fixture.roots.kernelVenvDir, { recursive: true });
		writeFileSync(join(fixture.roots.kernelVenvDir, "pyvenv.cfg"), "home = /usr\n");

		const venv = byId(collectReadonlyDoctorChecks(fixture.roots), "kernel-venv");

		expect(venv.status).toBe("fail");
		expect(venv.detail).toContain("no interpreter");
		expect(venv.next).toContain(fixture.roots.kernelVenvDir);
	});

	it("flags a missing kernel venv as a warning, not a failure", () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");

		const venv = byId(collectReadonlyDoctorChecks(fixture.roots), "kernel-venv");

		expect(venv.status).toBe("warn");
		expect(venv.next.length).toBeGreaterThan(0);
	});

	it("flags a non-executable kernel venv interpreter as failing", () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		const interpreter = writeVenvGeneration(fixture.roots);
		chmodSync(interpreter, 0o644);

		const venv = byId(collectReadonlyDoctorChecks(fixture.roots), "kernel-venv");

		expect(venv.status).toBe("fail");
		expect(venv.detail).toContain("not executable");
	});

	it("checks the PRIME_AGENT_KERNEL_PYTHON override instead of the venv", () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");

		const missing = collectReadonlyDoctorChecks({ ...fixture.roots, kernelPythonOverride: "/nonexistent/python" });
		expect(byId(missing, "kernel-venv").status).toBe("fail");
		expect(byId(missing, "kernel-venv").detail).toContain("PRIME_AGENT_KERNEL_PYTHON");

		const interpreter = writeVenvGeneration(fixture.roots);
		const present = collectReadonlyDoctorChecks({ ...fixture.roots, kernelPythonOverride: interpreter });
		expect(byId(present, "kernel-venv").status).toBe("ok");
	});

	it("flags unparseable session files with paths and next steps", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		const good = writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		const badJson = join(fixture.roots.sessionsDir, "badjson.jsonl");
		writeFileSync(badJson, "{ broken\n");
		const empty = join(fixture.roots.sessionsDir, "empty.jsonl");
		writeFileSync(empty, "");

		const sessions = byId(collectReadonlyDoctorChecks(fixture.roots), "sessions");

		expect(sessions.status).toBe("fail");
		expect(sessions.detail).toContain("2");
		expect(sessions.detail).toContain(badJson);
		expect(sessions.detail).toContain(empty);
		expect(sessions.detail).not.toContain(good);
		expect(sessions.next.length).toBeGreaterThan(0);
	});

	it("treats a missing sessions directory as healthy", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		rmSync(fixture.roots.sessionsDir, { recursive: true, force: true });

		const sessions = byId(collectReadonlyDoctorChecks(fixture.roots), "sessions");

		expect(sessions.status).toBe("ok");
		expect(sessions.detail).toContain("no sessions directory");
	});

	it("flags a sessions path that cannot be listed instead of calling it empty", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		// A file where the sessions directory should be: existsSync is true but
		// readdirSync throws ENOTDIR, the same "the scan saw nothing" shape as an
		// unreadable directory (chmod 000 does not stop the owner on macOS, so a
		// permission fixture would not be red there).
		rmSync(fixture.roots.sessionsDir, { recursive: true, force: true });
		writeFileSync(fixture.roots.sessionsDir, "not a directory\n");

		const sessions = byId(collectReadonlyDoctorChecks(fixture.roots), "sessions");

		expect(sessions.status).not.toBe("ok");
		expect(sessions.detail).not.toContain("directory is empty");
		expect(sessions.detail).toContain("ENOTDIR");
		expect(sessions.next.length).toBeGreaterThan(0);
	});

	it("bounds the session scan to the configured limits", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		for (let index = 0; index < 5; index++) {
			writeGoodSession(fixture.roots.sessionsDir, `file${index}000`);
		}

		const sessions = byId(
			collectReadonlyDoctorChecks(fixture.roots, { maxSessionFiles: 2, maxSessionBytes: 1024 * 1024 }),
			"sessions",
		);

		expect(sessions.status).not.toBe("fail");
		expect(sessions.detail).toContain("2 of 5");
		expect(sessions.next.length).toBeGreaterThan(0);
	});

	it("bounds the session scan by the byte budget", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		for (let index = 0; index < 5; index++) {
			writeGoodSession(fixture.roots.sessionsDir, `file${index}000`);
		}
		const headerBytes = Buffer.byteLength(readFileSync(join(fixture.roots.sessionsDir, "file0000.jsonl"), "utf-8"));

		const sessions = byId(
			collectReadonlyDoctorChecks(fixture.roots, { maxSessionFiles: 10, maxSessionBytes: headerBytes * 2 + 2 }),
			"sessions",
		);

		expect(sessions.status).not.toBe("fail");
		expect(sessions.detail).toContain("2 of 5");
	});

	it("stays read-only: an over-permissive session file is not tightened", () => {
		writeHealthyAuth(fixture.roots);
		writeVenvGeneration(fixture.roots);
		const file = writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		chmodSync(file, 0o644);
		const before = statSync(file).mode;

		collectReadonlyDoctorChecks(fixture.roots);

		expect(statSync(file).mode).toBe(before);
	});
});

describe("doctor public command", () => {
	let fixture: Fixture;
	let savedEnv: Record<string, string | undefined>;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fixture = makeFixture();
		mocks.psCalls.length = 0;
		savedEnv = {
			[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
			[ENV_SESSION_DIR]: process.env[ENV_SESSION_DIR],
			[KERNEL_VENV_ENV]: process.env[KERNEL_VENV_ENV],
			[KERNEL_PYTHON_ENV]: process.env[KERNEL_PYTHON_ENV],
		};
		process.env[ENV_AGENT_DIR] = fixture.roots.agentDir;
		process.env[ENV_SESSION_DIR] = fixture.roots.sessionsDir;
		process.env[KERNEL_VENV_ENV] = fixture.roots.kernelVenvDir;
		delete process.env[KERNEL_PYTHON_ENV];
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		process.exitCode = undefined;
	});

	afterEach(() => {
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		process.exitCode = undefined;
		vi.restoreAllMocks();
		disposeFixture(fixture);
	});

	it("prints the daemon table plus read-only checks with OK/WARN/FAIL markers and Next guidance", async () => {
		writeHealthyAuth(fixture.roots);
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		writeVenvGeneration(fixture.roots);

		await handlePublicCommand(["doctor"]);

		expect(mocks.psCalls).toEqual([false]);
		const lines = logSpy.mock.calls.map((call: unknown[]) => call.join(" "));
		const rendered = lines.join("\n");
		expect(rendered).toContain("health check");
		expect(rendered).toContain("OK");
		expect(rendered).toMatch(/\b(auth|kernel-venv|sessions)\b/);
		expect(rendered).toContain("Next:");
	});

	it("prints one structured JSON document with daemons and checks", async () => {
		writeFileSync(fixture.roots.authPath, "{ not valid json");
		writeGoodSession(fixture.roots.sessionsDir, "aaaaaaaa");
		writeVenvGeneration(fixture.roots);

		await handlePublicCommand(["doctor", "--json"]);

		expect(mocks.psCalls).toEqual([]);
		expect(logSpy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
			daemons: unknown[];
			checks: DoctorCheck[];
		};
		expect(Array.isArray(parsed.daemons)).toBe(true);
		const auth = byId(parsed.checks, "auth");
		expect(auth).toMatchObject({ id: "auth", status: "fail" });
		expect(auth.detail).toContain("valid JSON");
		expect(auth.next.length).toBeGreaterThan(0);
		expect(JSON.stringify(parsed)).not.toContain("sk-");
	});
});
