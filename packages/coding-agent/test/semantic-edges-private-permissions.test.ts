import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticEdgeRecorder } from "../src/core/semantic-edges.js";

/**
 * F71: the semantic-edge ledger lives in the same private store tree as the
 * session transcripts, but it was written with bare node:fs primitives —
 * mkdirSync without a mode (0755) and appendFileSync (0644, symlink-following)
 * — bypassing the private-file hardening every other writer in that tree uses.
 */

let tempRoot: string;

afterEach(() => {
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

function freshDir(): string {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-semantic-private-"));
	return tempRoot;
}

describe("SemanticEdgeRecorder private-file hardening", () => {
	it("writes the ledger 0600 inside a 0700 directory", () => {
		const dir = freshDir();
		const ledgerPath = join(dir, "semantic-edges.jsonl");
		const recorder = new SemanticEdgeRecorder({ ledgerPath, sessionId: "session-a" });
		const requestId = recorder.startTurnRequest();
		recorder.finishRequest(requestId);

		if (process.platform !== "win32") {
			expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		}
	});

	it("keeps append semantics: every written event line is present", () => {
		const dir = freshDir();
		const ledgerPath = join(dir, "semantic-edges.jsonl");
		const recorder = new SemanticEdgeRecorder({ ledgerPath, sessionId: "session-b" });
		const first = recorder.startTurnRequest();
		recorder.finishRequest(first);
		const second = recorder.startTurnRequest();
		recorder.finishRequest(second);

		const lines = readFileSync(ledgerPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines.length).toBe(5);
		expect(lines.map((line) => JSON.parse(line).type)).toEqual([
			"session_registered",
			"request_started",
			"request_finished",
			"request_started",
			"request_finished",
		]);
	});

	it("refuses to append through a symlink planted at the ledger path", () => {
		const dir = freshDir();
		const ledgerPath = join(dir, "semantic-edges.jsonl");
		const target = join(dir, "captured.jsonl");
		writeFileSync(target, "", "utf-8");
		if (process.platform === "win32") {
			// symlinkSync needs privileges on win32; the refusal is POSIX behaviour.
			return;
		}
		symlinkSync(target, ledgerPath);

		const recorder = new SemanticEdgeRecorder({ ledgerPath, sessionId: "session-c" });

		// The write must fail closed (ledger disabled), not follow the link.
		expect(recorder.enabled).toBe(false);
		expect(readFileSync(target, "utf-8")).toBe("");
	});

	it("truncates a torn tail without following a symlinked ledger", () => {
		const dir = freshDir();
		const ledgerPath = join(dir, "semantic-edges.jsonl");
		// One valid terminated line for another session, then a torn tail.
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({ type: "session_registered", session_id: "session-old" })}\n{"type":"request_star`,
			"utf-8",
		);

		const recorder = new SemanticEdgeRecorder({ ledgerPath, sessionId: "session-d" });
		expect(recorder.enabled).toBe(true);

		const lines = readFileSync(ledgerPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0);
		// The torn tail was discarded, not terminated into a corrupt line.
		expect(lines.map((line) => JSON.parse(line).type)).toEqual(["session_registered", "session_registered"]);
		if (process.platform !== "win32") {
			expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
		}
	});

	it("terminates an unterminated-but-valid final line before appending", () => {
		const dir = freshDir();
		const ledgerPath = join(dir, "semantic-edges.jsonl");
		// Valid JSON final line that lacks its newline (a crash mid-append after
		// the JSON but before the terminator).
		writeFileSync(ledgerPath, `${JSON.stringify({ type: "session_registered", session_id: "session-e" })}`, "utf-8");

		const recorder = new SemanticEdgeRecorder({ ledgerPath, sessionId: "session-e" });
		expect(recorder.enabled).toBe(true);
		// Idempotent registration: the repaired line counts, no second registration.
		const lines = readFileSync(ledgerPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines.map((line) => JSON.parse(line).type)).toEqual(["session_registered"]);
	});

	it("creates the ledger directory 0700 when it does not exist yet", () => {
		const dir = freshDir();
		const nested = join(dir, "sessions", "deep");
		const recorder = new SemanticEdgeRecorder({
			ledgerPath: join(nested, "semantic-edges.jsonl"),
			sessionId: "session-f",
		});

		expect(recorder.enabled).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(nested).mode & 0o777).toBe(0o700);
		}
	});
});
