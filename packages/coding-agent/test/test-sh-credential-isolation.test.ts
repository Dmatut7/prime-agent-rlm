import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `test.sh` is the local entry point for the whole suite, and it isolates credentials by pointing
 * the suite at a throwaway agent directory. It used to do that by *moving* the developer's real
 * `auth.json` files aside and moving them back from an `EXIT` trap - and a trap does not run for
 * SIGKILL, a panic or a power loss, so a crash during the suite left the credentials parked in
 * `.bak` and the next run found no live store at all.
 *
 * The pin is behavioural, not textual: `test.sh` runs with a fixture `HOME` and an `npm` stub that
 * records what the suite sees *while it runs*. A regression to the move-and-restore shape is
 * visible from inside that run (the real store is gone), and so is a regression that drops the
 * redirection (the suite would be given the developer's real agent directory again).
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_SH = join(REPO_ROOT, "test.sh");

const REAL_STORE = ".prime/agent/auth.json";
const LEGACY_STORE = ".pi/agent/auth.json";
const SENTINEL = '{"fixture":"this file must survive the suite byte for byte"}\n';

/** Host state that would decide the outcome for us: the run must not inherit a redirected agent dir. */
const HOST_STATE = /^(PI_|PRIME_AGENT_|RLM_|CREDENTIAL_PROBE_)/;

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || HOST_STATE.test(name)) continue;
		env[name] = value;
	}
	return env;
}

interface Fixture {
	home: string;
	bin: string;
	probeLog: string;
}

function makeFixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "test-sh-creds-home-"));
	const bin = mkdtempSync(join(tmpdir(), "test-sh-creds-bin-"));
	createdDirs.push(home, bin);
	for (const relative of [REAL_STORE, LEGACY_STORE]) {
		mkdirSync(join(home, relative, ".."), { recursive: true });
		writeFileSync(join(home, relative), SENTINEL);
	}
	const probeLog = join(bin, "probe.log");
	// The suite's own `npm test` is replaced: this case is about what the credential stores look
	// like from inside the run, not about the suites themselves.
	writeFileSync(
		join(bin, "npm"),
		`#!/bin/sh
{
  printf 'agent-dir-env=%s\\n' "\${PRIME_AGENT_CODING_AGENT_DIR:-unset}"
  printf 'agent-dir-env-pi=%s\\n' "\${PI_CODING_AGENT_DIR:-unset}"
  if [ -n "\${PRIME_AGENT_CODING_AGENT_DIR:-}" ] && [ -d "\${PRIME_AGENT_CODING_AGENT_DIR}" ]; then
    printf 'agent-dir-exists=yes\\n'
  else
    printf 'agent-dir-exists=no\\n'
  fi
  for store in "${REAL_STORE}" "${LEGACY_STORE}"; do
    if [ -f "$HOME/$store" ]; then printf 'store=%s present\\n' "$store"; else printf 'store=%s MOVED-AWAY\\n' "$store"; fi
  done
  printf 'invoked=%s\\n' "$*"
} >> "$CREDENTIAL_PROBE_LOG"
exit 0
`,
	);
	chmodSync(join(bin, "npm"), 0o755);
	return { home, bin, probeLog };
}

function runTestSh(fixture: Fixture): { status: number | null; signal: string | null; output: string } {
	const result = spawnSync("bash", [TEST_SH], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...hostEnv(),
			HOME: fixture.home,
			PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
			CREDENTIAL_PROBE_LOG: fixture.probeLog,
		},
	});
	return { status: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Polls until the probe log appears: the stub writes it before parking. */
async function waitForProbe(path: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the npm stub never wrote ${path}`);
}

describe("test.sh credential isolation", () => {
	it("never moves the developer's credential stores, and redirects the suite instead", () => {
		const fixture = makeFixture();
		const result = runTestSh(fixture);
		// Refused or killed is not a proof: the suite has to have reached its own `npm test`.
		expect(result.signal).toBe(null);
		expect(result.status).toBe(0);
		const probe = readFileSync(fixture.probeLog, "utf8");
		// `npm test` hands the stub "test" as its first argument.
		expect(probe).toMatch(/^invoked=test$/m);
		// The two real stores were still in place while the suite ran: with the move-and-restore
		// shape this line reads MOVED-AWAY, which is exactly the state a SIGKILL would freeze.
		expect(probe).toContain(`store=${REAL_STORE} present`);
		expect(probe).toContain(`store=${LEGACY_STORE} present`);
		// And the suite was pointed somewhere else, a directory that existed at the time.
		const agentDir = probe.match(/^agent-dir-env=(.+)$/m)?.[1];
		expect(agentDir).toBeDefined();
		expect(agentDir).not.toBe("unset");
		expect(agentDir).not.toContain(fixture.home);
		expect(probe).toContain("agent-dir-exists=yes");
	});

	it("leaves the stores byte-identical and no .bak behind", () => {
		const fixture = makeFixture();
		const result = runTestSh(fixture);
		expect(result.status).toBe(0);
		for (const relative of [REAL_STORE, LEGACY_STORE]) {
			expect(readFileSync(join(fixture.home, relative), "utf8")).toBe(SENTINEL);
			// The old shape parked the live store here for the duration of the run.
			expect(existsSync(join(fixture.home, `${relative}.bak`))).toBe(false);
		}
	});

	it("survives a SIGKILL mid-suite without stranding the credentials", async () => {
		const fixture = makeFixture();
		// SIGKILL is the case a trap cannot cover: the old shape moved the real stores aside and
		// restored them from an `EXIT` trap, so a kill -9 during the suite left them in `.bak`.
		const child = spawn("bash", [TEST_SH], {
			cwd: REPO_ROOT,
			detached: true,
			stdio: "ignore",
			env: {
				...hostEnv(),
				HOME: fixture.home,
				PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
				CREDENTIAL_PROBE_LOG: fixture.probeLog,
				CREDENTIAL_PROBE_PARK: "1",
			},
		});
		try {
			await waitForProbe(fixture.probeLog);
			const probe = readFileSync(fixture.probeLog, "utf8");
			expect(probe).toContain(`store=${REAL_STORE} present`);
			// Killed the way an interrupted run dies: SIGKILL on the script and on the suite it had
			// started, so no `trap ... EXIT` and no stub cleanup can run.
			child.kill("SIGKILL");
			const stubPid = Number(probe.match(/^stub-pid=(\d+)$/m)?.[1]);
			if (Number.isFinite(stubPid)) {
				try {
					process.kill(stubPid, "SIGKILL");
				} catch {
					// Already gone: the assertion below is about the fixture, not about this pid.
				}
			}
		} finally {
			child.kill("SIGKILL");
		}
		for (const relative of [REAL_STORE, LEGACY_STORE]) {
			expect(existsSync(join(fixture.home, relative))).toBe(true);
			expect(readFileSync(join(fixture.home, relative), "utf8")).toBe(SENTINEL);
		}
	});
});
