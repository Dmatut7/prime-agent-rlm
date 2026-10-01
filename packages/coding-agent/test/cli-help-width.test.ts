import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCommandHelp, formatTopLevelHelp } from "../src/cli/command-registry.js";
import type { RunningDaemonProbe } from "../src/cli/daemon-launch.js";
import {
	confirmDaemonSessionLoss,
	type DaemonSessionLossCopy,
	formatConfirmPromptText,
} from "../src/cli/daemon-stop-confirm.js";
import { reportDiagnostics, STARTUP_SESSION_LOSS_COPY } from "../src/main.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function linesOf(text: string): string[] {
	return text.split("\n");
}

function expectLinesWithin(text: string, width: number): void {
	for (const line of linesOf(text)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "columns");

function setStdinTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

function setStderrColumns(value: number | undefined): void {
	Object.defineProperty(process.stderr, "columns", { value, configurable: true, writable: true });
}

afterEach(() => {
	vi.restoreAllMocks();
	if (ttyDescriptor) {
		Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
	}
	if (stderrColumnsDescriptor) {
		Object.defineProperty(process.stderr, "columns", stderrColumnsDescriptor);
	} else {
		delete (process.stderr as { columns?: number }).columns;
	}
});

describe("formatTopLevelHelp with a known width", () => {
	it("wraps every line to 80 columns without splitting words", () => {
		const help = formatTopLevelHelp(80);
		expectLinesWithin(help, 80);
		expect(help).toContain("reached");
		expect(help).toContain("(default: 3)");
		expect(help).toContain("(default: 7200000)");
		// The mid-word folds from the 80-column walkthrough must not exist.
		for (const fragment of ["\nached", "\nult:", "\nlt: ", "\n: 50)"]) {
			expect(help).not.toContain(fragment);
		}
	});

	it("indents continuation lines under the summary column instead of flush left", () => {
		const help = formatTopLevelHelp(80);
		// A wrapped description continuation never reads as a fresh command/option.
		expect(help).not.toMatch(/^--fix$/m);
		// Autonomous group: longest option "--autonomous-max-continuations <n>" (34)
		// puts the summary column at 2 + 34 + 2 = 38.
		expect(help).toMatch(/^ {38}\S/m);
		// Commands section: longest name puts the summary column at 13.
		expect(help).toMatch(/^ {13}--fix$/m);
	});

	it("needs no continuation lines at 120 columns", () => {
		const wrapped = formatTopLevelHelp(120);
		expectLinesWithin(wrapped, 120);
		expect(linesOf(wrapped).length).toBe(linesOf(formatTopLevelHelp()).length);
	});

	it("stacks option above summary when the aligned column leaves no room", () => {
		const help = formatTopLevelHelp(40);
		expectLinesWithin(help, 40);
		expect(help).toContain("--autonomous-max-continuations <n>");
		expect(help).toContain("Continue until gates pass");
	});

	it("keeps the legacy byte-for-byte layout when no width is known", () => {
		const help = formatTopLevelHelp();
		expect(help).toContain("  --autonomous-gate-retries <n>       Set positive retries per failed gate (default: 3)");
		expect(help).toContain("  -h, --help     Show this help");
	});
});

describe("formatCommandHelp with a known width", () => {
	it("wraps the usage line, description, and option summaries to 80 columns", () => {
		const help = formatCommandHelp(["doctor"], 80);
		expect(help).toBeDefined();
		expectLinesWithin(help!, 80);
		// Usage synopsis wraps with a 4-column hanging indent.
		expect(help).toMatch(/^ {4}--socket-dir <dir>\] \[--orphans\]$/m);
		// Description paragraph keeps words whole.
		expect(help).toContain("transcript");
		expect(help).toContain("processes");
	});

	it("re-aligns option summaries to one column when wrapping", () => {
		const help = formatCommandHelp(["doctor"], 80)!;
		const socketLine = linesOf(help).find((line) => line.startsWith("  --socket <path>"))!;
		const socketDirLine = linesOf(help).find((line) => line.startsWith("  --socket-dir <dir>"))!;
		expect(socketLine.indexOf("Clean only")).toBeGreaterThan(0);
		expect(socketLine.indexOf("Clean only")).toBe(socketDirLine.indexOf("Clean only"));
	});

	it("aligns option summaries without wrapping when no width is known", () => {
		const help = formatCommandHelp(["doctor"])!;
		const socketLine = linesOf(help).find((line) => line.startsWith("  --socket <path>"))!;
		const socketDirLine = linesOf(help).find((line) => line.startsWith("  --socket-dir <dir>"))!;
		expect(socketLine.indexOf("Clean only")).toBeGreaterThan(0);
		expect(socketLine.indexOf("Clean only")).toBe(socketDirLine.indexOf("Clean only"));
		// No width -> no wrap: one line per option, no indented continuations.
		expect(linesOf(help).some((line) => /^ {4,}\S/.test(line))).toBe(false);
	});
});

describe("stale-daemon conflict copy", () => {
	it("points at --daemon-socket as the keep-it-running path on every variant", () => {
		expect(STARTUP_SESSION_LOSS_COPY.busyDetail(3)).toContain("--daemon-socket");
		expect(STARTUP_SESSION_LOSS_COPY.busyDetail(1)).toContain("--daemon-socket");
		expect(STARTUP_SESSION_LOSS_COPY.unlistableDetail).toContain("--daemon-socket");
		expect(STARTUP_SESSION_LOSS_COPY.nonTtyHint).toContain("--daemon-socket");
		expect(STARTUP_SESSION_LOSS_COPY.nonTtyHint).toContain("prime-agent shutdown");
	});
});

describe("reportDiagnostics wrapping", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("wraps long diagnostics to the stderr width", () => {
		setStderrColumns(40);
		reportDiagnostics([{ type: "info", message: "word ".repeat(30).trim() }]);
		const printed = String(vi.mocked(console.error).mock.calls[0]?.[0]);
		expect(printed).toContain("\n");
		expectLinesWithin(printed, 40);
	});

	it("indents diagnostic continuations under the message, past the prefix", () => {
		setStderrColumns(40);
		reportDiagnostics([{ type: "warning", message: "word ".repeat(30).trim() }]);
		const printed = String(vi.mocked(console.error).mock.calls[0]?.[0]);
		const lines = linesOf(printed);
		expect(lines[0]!.startsWith("Warning: ")).toBe(true);
		for (const continuation of lines.slice(1)) {
			expect(continuation.startsWith(" ".repeat("Warning: ".length))).toBe(true);
		}
	});

	it("prints one line when the stderr width is unknown", () => {
		setStderrColumns(undefined);
		const message = "word ".repeat(30).trim();
		reportDiagnostics([{ type: "error", message }]);
		const printed = String(vi.mocked(console.error).mock.calls[0]?.[0]);
		expect(printed).toBe(`Error: ${message}`);
	});
});

const LONG_COPY: DaemonSessionLossCopy = {
	busyDetail: (count) =>
		`A background service from a different Prime Agent version is running with ${count} busy sessions. Stopping it will terminate them.`,
	unlistableDetail:
		"A background service from a different Prime Agent version is running and its sessions could not be listed. Stopping it may terminate active sessions.",
	question: "Stop it and continue?",
	nonTtyHint:
		'Run "prime-agent shutdown" to stop it, then retry, or re-run with --daemon-socket <path> to keep it running.',
};

function busySession(): SessionSummary {
	return {
		isSessionActive: true,
		isStreaming: true,
		isCompacting: false,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	} as unknown as SessionSummary;
}

describe("confirmDaemonSessionLoss wrapping", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		setStdinTTY(false);
	});

	it("wraps the non-TTY conflict message to the stderr width", async () => {
		setStderrColumns(50);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [busySession()] };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: LONG_COPY })).toBe(false);
		const printed = String(vi.mocked(console.error).mock.calls[0]?.[0]);
		expect(printed).toContain("\n");
		expectLinesWithin(printed, 50);
		expect(printed).toContain("--daemon-socket");
	});

	it("prints one line when the stderr width is unknown", async () => {
		setStderrColumns(undefined);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [busySession()] };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: LONG_COPY })).toBe(false);
		const printed = String(vi.mocked(console.error).mock.calls[0]?.[0]);
		expect(printed).not.toContain("\n");
	});
});

describe("formatConfirmPromptText", () => {
	it('reserves room for the " [y/N] " suffix readline appends', () => {
		const wrapped = formatConfirmPromptText("word ".repeat(30).trim(), 40);
		for (const line of linesOf(wrapped)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(33);
		}
	});

	it("returns the message unchanged when no width is known", () => {
		const message = "word ".repeat(30).trim();
		expect(formatConfirmPromptText(message, undefined)).toBe(message);
	});
});
