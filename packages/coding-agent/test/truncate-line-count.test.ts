import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { DEFAULT_MAX_LINES, truncateHead, truncateTail } from "../src/core/tools/truncate.js";

/**
 * A trailing newline terminates the last line; it does not start a new one.
 * Counting it as a line made every newline-terminated output read as one line
 * longer than it is, and at exactly the line limit it turned "nothing was cut"
 * into a reported truncation, with a total the reader could never reconcile.
 */

function lines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line-${index}-pad`);
}

/** Output as a command really leaves it: every line terminated, no phantom after. */
function newlineTerminated(count: number): string {
	return `${lines(count).join("\n")}\n`;
}

function unterminated(count: number): string {
	return lines(count).join("\n");
}

describe("line counting at the truncation limit", () => {
	it("does not report a newline-terminated 2000-line output as truncated (head)", () => {
		const content = newlineTerminated(DEFAULT_MAX_LINES);
		const result = truncateHead(content, { maxLines: DEFAULT_MAX_LINES });
		expect(result.truncated).toBe(false);
		expect(result.truncatedBy).toBeNull();
		expect(result.totalLines).toBe(DEFAULT_MAX_LINES);
		expect(result.outputLines).toBe(DEFAULT_MAX_LINES);
		// Nothing was cut, so nothing may be missing - the terminator survives.
		expect(result.content).toBe(content);
		expect(result.outputBytes).toBe(Buffer.byteLength(content, "utf-8"));
	});

	it("does not report a newline-terminated 2000-line output as truncated (tail)", () => {
		const content = newlineTerminated(DEFAULT_MAX_LINES);
		const result = truncateTail(content, { maxLines: DEFAULT_MAX_LINES });
		expect(result.truncated).toBe(false);
		expect(result.truncatedBy).toBeNull();
		expect(result.totalLines).toBe(DEFAULT_MAX_LINES);
		expect(result.outputLines).toBe(DEFAULT_MAX_LINES);
		expect(result.content).toBe(content);
	});

	it("does not report it as truncated through the streaming accumulator", () => {
		const content = newlineTerminated(DEFAULT_MAX_LINES);
		const accumulator = new OutputAccumulator({ tempFilePrefix: "r12-line-count-" });
		accumulator.append(Buffer.from(content, "utf-8"));
		accumulator.finish();
		const snapshot = accumulator.snapshot();
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.truncation.totalLines).toBe(DEFAULT_MAX_LINES);
		expect(snapshot.content).toBe(content);
	});

	it("reports one newline-terminated line over the limit as truncated with the real total", () => {
		const content = newlineTerminated(DEFAULT_MAX_LINES + 1);
		const result = truncateTail(content, { maxLines: DEFAULT_MAX_LINES });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("lines");
		expect(result.totalLines).toBe(DEFAULT_MAX_LINES + 1);
		expect(result.outputLines).toBe(DEFAULT_MAX_LINES);
		expect(result.content).toContain(`line-${DEFAULT_MAX_LINES}-pad`);
	});

	// Positive controls: the newline-free shape always counted correctly, so the
	// same assertions on it pass before the fix and must keep passing after it.
	it("positive control: counts an unterminated 2000-line output as 2000 lines, uncut", () => {
		const content = unterminated(DEFAULT_MAX_LINES);
		const head = truncateHead(content, { maxLines: DEFAULT_MAX_LINES });
		expect(head.truncated).toBe(false);
		expect(head.totalLines).toBe(DEFAULT_MAX_LINES);
		const tail = truncateTail(content, { maxLines: DEFAULT_MAX_LINES });
		expect(tail.truncated).toBe(false);
		expect(tail.totalLines).toBe(DEFAULT_MAX_LINES);
	});

	it("positive control: counts an unterminated over-limit output as truncated", () => {
		const content = unterminated(DEFAULT_MAX_LINES + 1);
		const result = truncateTail(content, { maxLines: DEFAULT_MAX_LINES });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("lines");
		expect(result.totalLines).toBe(DEFAULT_MAX_LINES + 1);
		expect(result.outputLines).toBe(DEFAULT_MAX_LINES);
	});

	it("exec leaves a newline-terminated 2000-line stream whole and unannotated", async () => {
		const expected = `${Array.from({ length: DEFAULT_MAX_LINES }, (_, i) => `l${i}`).join("\n")}\n`;
		const script = `let out=""; for (let i=0;i<${DEFAULT_MAX_LINES};i++) out += "l"+i+"\\n"; process.stdout.write(out);`;
		const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { timeout: 30_000 });
		expect(result.code).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.stdout).toBe(expected);
	});

	it("exec annotates a truncated stream with the real total line count", async () => {
		const total = DEFAULT_MAX_LINES + 1;
		const script = `let out=""; for (let i=0;i<${total};i++) out += "l"+i+"\\n"; process.stdout.write(out);`;
		const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { timeout: 30_000 });
		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		// The old count credited the terminator with a line of its own: 2002 for a
		// stream of 2001. The annotation is what the model reads, so the total it names
		// has to be the number of lines that exist.
		expect(result.stdout).toContain(`[Output truncated: showing last ${DEFAULT_MAX_LINES} of ${total} lines.]`);
		expect(result.stdout).not.toContain(`of ${total + 1} lines`);
	});
});
