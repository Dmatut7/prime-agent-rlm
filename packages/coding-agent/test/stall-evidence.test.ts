import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getLogger, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentLogPath } from "../src/config.js";
import { installFileLogSink } from "../src/core/logging.js";
import {
	formatStallDiagnosticsPointer,
	formatStallDiagnosticsWhere,
	getStallEvidencePath,
	isStallEvidenceMessage,
	resolveStallDiagnosticsPointer,
	STALL_EVIDENCE_MAX_BYTES,
	setStallRuntimeDaemonWorker,
} from "../src/core/stall-evidence.js";
import {
	buildStallAbortMessage,
	buildStallAbortUnsettledMessage,
	buildStallWarnMessage,
} from "../src/core/stall-watchdog.js";

const log = getLogger("coding-agent.stall-evidence-test");
let agentDir = "";

function evidenceLines(): string[] {
	if (!existsSync(getStallEvidencePath())) return [];
	return readFileSync(getStallEvidencePath(), "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "stall-evidence-"));
	process.env[ENV_AGENT_DIR] = agentDir;
	setStallRuntimeDaemonWorker(false);
	installFileLogSink();
});

afterEach(() => {
	setLogSink(undefined);
	delete process.env[ENV_AGENT_DIR];
	rmSync(agentDir, { recursive: true, force: true });
});

describe("stall evidence retention (DO-1c)", () => {
	it("tees stall watchdog entries into a bounded stall-only file next to agent.jsonl", () => {
		log.warn("stall watchdog: no activity while turn running", {
			stage: "warn",
			silentMs: 300_000,
			sessionId: "session-abc",
			diagnostics: { silentMs: 300_000, unfinishedActions: 2 },
		});

		const lines = evidenceLines();
		expect(lines.length).toBe(1);
		// The tee keeps the whole structured record, not a summary of it.
		expect(lines[0]).toContain("session-abc");
		expect(lines[0]).toContain('"unfinishedActions":2');
		// Positive control: the shared log still gets the entry too.
		expect(readFileSync(getAgentLogPath(), "utf8")).toContain("stall watchdog: no activity");
	});

	it("leaves unrelated entries out of the stall evidence file", () => {
		log.warn("some other problem worth logging", { detail: "not a stall" });

		expect(evidenceLines()).toEqual([]);
		// Positive control: the classifier does accept the watchdog's own message prefix.
		expect(isStallEvidenceMessage("stall watchdog: aborting silent turn")).toBe(true);
		expect(isStallEvidenceMessage("some other problem worth logging")).toBe(false);
	});

	it("keeps the evidence file bounded but retains the rotated generation", () => {
		const path = getStallEvidencePath();
		// Cross the cap with stall-shaped records only, then add one more.
		const filler = JSON.stringify({ msg: "stall watchdog: no activity while turn running", pad: "x".repeat(4096) });
		const generations = Math.ceil((STALL_EVIDENCE_MAX_BYTES * 1.2) / (filler.length + 1));
		for (let i = 0; i < generations; i += 1) {
			log.warn("stall watchdog: no activity while turn running", { pad: "x".repeat(4096), seq: i });
		}
		expect(statSync(path).size).toBeLessThanOrEqual(STALL_EVIDENCE_MAX_BYTES + 8192);
		expect(existsSync(`${path}.old`)).toBe(true);
		// The retention floor: a stall record is bounded by the stall traffic itself, never by
		// how much unrelated chatter the shared agent.jsonl saw.
		expect(evidenceLines().length).toBeGreaterThan(0);
	});

	it("survives a pre-existing oversized evidence file without throwing", () => {
		const path = getStallEvidencePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "y".repeat(STALL_EVIDENCE_MAX_BYTES + 1024), { mode: 0o600 });
		log.error("stall watchdog: aborting silent turn", { stage: "abort" });
		expect(existsSync(`${path}.old`)).toBe(true);
		expect(evidenceLines().length).toBeGreaterThan(0);
	});
});

describe("stall diagnostics pointer copy (DO-1a)", () => {
	it("names the real landing spots, never a bare 'daemon log'", () => {
		const pointer = resolveStallDiagnosticsPointer();
		expect(pointer.evidencePath).toBe(join(agentDir, "logs", "stall-evidence.jsonl"));
		expect(pointer.agentLogPath).toBe(join(agentDir, "logs", "agent.jsonl"));
		expect(formatStallDiagnosticsWhere(pointer)).toContain("stall-evidence.jsonl");
		expect(formatStallDiagnosticsPointer(pointer)).toContain("agent.jsonl");
	});

	it("warn copy points at the real files and says there is no daemon when there is none", () => {
		setStallRuntimeDaemonWorker(false);
		const message = buildStallWarnMessage({ silentMs: 300_000, abortAfterSeconds: 900 });
		expect(message).toContain(getStallEvidencePath());
		expect(message).toContain(getAgentLogPath());
		expect(message).not.toContain("check the daemon log");
		expect(message).toContain("without a daemon");
	});

	it("warn copy distinguishes a daemon worker and disowns the supervisor log", () => {
		setStallRuntimeDaemonWorker(true);
		const message = buildStallWarnMessage({ silentMs: 300_000 });
		expect(message).toContain("daemon worker");
		expect(message).toContain(getStallEvidencePath());
		expect(message).toMatch(/supervisor log .*never|not the daemon supervisor log/);
		expect(message).not.toContain("check the daemon log");
		// The direct-run clause must not leak into the daemon-run copy.
		expect(message).not.toContain("without a daemon");
	});

	it("all three warn variants and both abort copies carry the pointer", () => {
		const cases = [
			buildStallWarnMessage({ silentMs: 300_000 }),
			buildStallWarnMessage({ silentMs: 300_000, abortAfterSeconds: 900 }),
			buildStallWarnMessage({
				silentMs: 300_000,
				abortAfterSeconds: 900,
				exemption: {
					reason: "vouched",
					reasons: ["live_bash_handles"],
					since: 0,
					usedMs: 1000,
					budgetMs: 10_000,
					remainingMs: 9000,
					exhausted: false,
				},
			}),
			buildStallAbortMessage({ silentMs: 900_000 }),
			buildStallAbortUnsettledMessage({ silentMs: 900_000 }),
		];
		expect(cases.length).toBe(5);
		for (const message of cases) {
			expect(message).toContain("stall-evidence.jsonl");
			expect(message).not.toContain("check the daemon log");
		}
		// The abort copies used to assert "diagnostics were logged" unconditionally; the write is
		// best-effort, so the copy must say so instead of vouching for it.
		expect(buildStallAbortMessage({ silentMs: 900_000 })).toContain("best-effort");
		expect(buildStallAbortUnsettledMessage({ silentMs: 900_000 })).toContain("best-effort");
	});

	it("accepts an injected pointer so callers and tests are not tied to the process env", () => {
		const message = buildStallAbortMessage({
			silentMs: 900_000,
			diagnosticsPointer: {
				evidencePath: "/tmp/fake-agent/logs/stall-evidence.jsonl",
				agentLogPath: "/tmp/fake-agent/logs/agent.jsonl",
				daemonWorker: true,
			},
		});
		expect(message).toContain("/tmp/fake-agent/logs/stall-evidence.jsonl");
		expect(message).toContain("daemon worker");
	});
});
