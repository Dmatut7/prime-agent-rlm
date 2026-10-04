import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.js";
import { formatResumeHint, resumeHintConnectionFromArgs } from "../src/modes/interactive/resume-hint.js";

const SESSION_ID = "0196c2e4-7f01-7abc-8def-0123456789ab";

const sessionDir = mkdtempSync(join(tmpdir(), "resume-hint-test-"));
const existingSessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
writeFileSync(existingSessionFile, `{"type":"session","id":"${SESSION_ID}"}\n`);

afterAll(() => {
	rmSync(sessionDir, { recursive: true, force: true });
});

describe("formatResumeHint", () => {
	test("returns hint with --resume and the session id for a persisted session", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			userMessages: 3,
		});
		expect(hint).toBeDefined();
		expect(hint).toContain(`${APP_NAME} --resume ${SESSION_ID}`);
	});

	test("returns undefined for an in-memory session", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: undefined,
			userMessages: 3,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when the session has no user messages", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			userMessages: 0,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when the session file was never flushed to disk", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: join(sessionDir, "never-written.jsonl"),
			userMessages: 1,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when stats are unavailable", () => {
		expect(formatResumeHint(undefined)).toBeUndefined();
	});

	// wave-47 B: the hint must replay the connection flags this session was
	// started with; copying a bare `--resume` would attach to the default daemon.
	test("replays explicit connection flags so the hint reconnects to the same daemon", () => {
		const hint = formatResumeHint(
			{ sessionId: SESSION_ID, sessionFile: existingSessionFile, userMessages: 3 },
			{ daemonSocket: "/tmp/wave46/v.sock", sessionDir: "/tmp/wave46/sessions" },
		);
		expect(hint).toContain(
			`${APP_NAME} --daemon-socket /tmp/wave46/v.sock --session-dir /tmp/wave46/sessions --resume ${SESSION_ID}`,
		);
	});

	test("quotes a flag value that needs quoting", () => {
		const hint = formatResumeHint(
			{ sessionId: SESSION_ID, sessionFile: existingSessionFile, userMessages: 3 },
			{ sessionDir: "/tmp/my dir/sessions" },
		);
		expect(hint).toContain(`--session-dir '/tmp/my dir/sessions' --resume ${SESSION_ID}`);
		expect(hint).not.toContain("--daemon-socket");
	});

	test("keeps the bare form when no connection flags were given", () => {
		const hint = formatResumeHint({ sessionId: SESSION_ID, sessionFile: existingSessionFile, userMessages: 3 }, {});
		expect(hint).toContain(`${APP_NAME} --resume ${SESSION_ID}`);
		expect(hint).not.toContain("--daemon-socket");
		expect(hint).not.toContain("--session-dir");
	});
});

describe("resumeHintConnectionFromArgs", () => {
	test("is undefined when neither connection flag was parsed", () => {
		expect(resumeHintConnectionFromArgs({})).toBeUndefined();
	});

	test("carries only the flags that were parsed", () => {
		expect(resumeHintConnectionFromArgs({ daemonSocket: "/tmp/v.sock" })).toEqual({
			daemonSocket: "/tmp/v.sock",
		});
		expect(resumeHintConnectionFromArgs({ sessionDir: "/tmp/s" })).toEqual({ sessionDir: "/tmp/s" });
		expect(resumeHintConnectionFromArgs({ daemonSocket: "/tmp/v.sock", sessionDir: "/tmp/s" })).toEqual({
			daemonSocket: "/tmp/v.sock",
			sessionDir: "/tmp/s",
		});
	});
});
