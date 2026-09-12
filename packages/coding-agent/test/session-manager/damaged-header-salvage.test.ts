import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

const SESSION_ID = "01damaged-head-session";

function transcriptLines(): string[] {
	return [
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "first question", timestamp: 1 },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:02Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 2,
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-01-01T00:00:03Z",
			message: { role: "user", content: "second question", timestamp: 3 },
		}),
	];
}

const PRE_V2_MESSAGE_COUNT = 4;

/** v1 body: entries carry no id/parentId, the migration assigns both. */
function preV2BodyLines(): string[] {
	const messages = [];
	for (let index = 0; index < PRE_V2_MESSAGE_COUNT; index++) {
		messages.push(
			index % 2 === 0
				? { role: "user", content: `question ${index}`, timestamp: index }
				: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${index}` }],
						api: "test",
						provider: "test",
						model: "test",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						stopReason: "stop",
						timestamp: index,
					},
		);
	}
	return messages.map((message, index) =>
		JSON.stringify({ type: "message", timestamp: `2026-01-01T00:00:0${index}Z`, message }),
	);
}

function readLines(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("setSessionFile with a damaged first line", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createSessionFile(name: string, content: string): { file: string; dir: string } {
		const root = mkdtempSync(join(tmpdir(), "prime-damaged-head-"));
		roots.push(root);
		const dir = join(root, "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, content);
		return { file, dir };
	}

	it.each([
		["a torn header line", '{"type":"session","version":3,"id":"01damaged-head-ses'],
		["a zero-filled header line", `\u0000\u0000\u0000\u0000${JSON.stringify({ type: "session", id: SESSION_ID })}`],
	])("salvages the transcript behind %s", (_name, damagedHead) => {
		const { file, dir } = createSessionFile(
			`${SESSION_ID}.jsonl`,
			`${damagedHead}\n${transcriptLines().join("\n")}\n`,
		);

		const manager = SessionManager.open(file, dir);

		// The salvaged transcript survives, and the id stays in sync with the file name.
		expect(manager.getSessionId()).toBe(SESSION_ID);
		expect(manager.getHeader()).toMatchObject({ type: "session", id: SESSION_ID, version: 3 });
		expect(manager.getHeader()?.cwd).toBe(manager.getCwd());
		expect(manager.getEntries().map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
		expect(manager.getBranch()).toHaveLength(3);
		expect(manager.buildSessionContext().messages).toHaveLength(3);

		const persisted = readLines(file);
		expect(persisted).toHaveLength(4);
		expect(persisted[0]).toMatchObject({ type: "session", id: SESSION_ID });
		expect(persisted.slice(1).map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
		expect(readFileSync(file, "utf8")).not.toContain("\u0000");

		// Appends land on the salvaged leaf instead of on a truncated file.
		manager.appendMessage({ role: "user", content: "after recovery", timestamp: 4 });
		manager.flushNow();
		const afterAppend = readLines(file);
		expect(afterAppend).toHaveLength(5);
		expect(afterAppend[4].parentId).toBe("m3");
		expect(afterAppend[3].id).toBe("m3");
	});

	it("keeps the salvaged session id and entries across reloads", () => {
		const damagedHead = '{"type":"session","version":3,"id":"01damaged';
		const { file, dir } = createSessionFile(
			`${SESSION_ID}.jsonl`,
			`${damagedHead}\n${transcriptLines().join("\n")}\n`,
		);

		const first = SessionManager.open(file, dir);
		const second = SessionManager.open(file, dir);

		expect(second.getSessionId()).toBe(first.getSessionId());
		expect(second.getEntries().map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
	});

	it("salvages a pre-v2 transcript behind a torn header into a navigable tree", () => {
		const preV2SessionId = "01pre-v2-damaged-head";
		// v1 on disk: the header carries no version, the entries no id/parentId.
		const damagedHead = '{"type":"session","id":"01pre-v2-dam';
		const { file, dir } = createSessionFile(
			`${preV2SessionId}.jsonl`,
			`${damagedHead}\n${preV2BodyLines().join("\n")}\n`,
		);

		const manager = SessionManager.open(file, dir);

		expect(manager.getSessionId()).toBe(preV2SessionId);
		const entries = manager.getEntries();
		expect(entries).toHaveLength(PRE_V2_MESSAGE_COUNT);
		// The migration assigned ids: nothing is keyed under undefined.
		for (const entry of entries) {
			expect(typeof entry.id).toBe("string");
			expect(entry.id.length).toBeGreaterThan(0);
		}
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(PRE_V2_MESSAGE_COUNT);
		// Fully navigable: the leaf is set and the branch walks back to the root.
		expect(manager.getLeafId()).toBe(entries[PRE_V2_MESSAGE_COUNT - 1].id);
		expect(manager.getBranch()).toHaveLength(PRE_V2_MESSAGE_COUNT);
		expect(manager.buildSessionContext().messages).toHaveLength(PRE_V2_MESSAGE_COUNT);

		const persisted = readLines(file);
		expect(persisted).toHaveLength(PRE_V2_MESSAGE_COUNT + 1);
		expect(persisted[0]).toMatchObject({ type: "session", id: preV2SessionId, version: 3 });
		const persistedBody = persisted.slice(1);
		expect(persistedBody.every((entry) => typeof entry.id === "string")).toBe(true);
		expect(persistedBody[0].parentId).toBeNull();
		for (let index = 1; index < persistedBody.length; index++) {
			expect(persistedBody[index].parentId).toBe(persistedBody[index - 1].id);
		}

		// The rewritten file is current-version: a reload keeps the same ids and
		// stays navigable instead of migrating a second time.
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getSessionId()).toBe(preV2SessionId);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(reopened.getBranch()).toHaveLength(PRE_V2_MESSAGE_COUNT);
	});

	it("still writes a fresh header for a genuinely empty file", () => {
		const { file, dir } = createSessionFile("empty.jsonl", "");

		const manager = SessionManager.open(file, dir);

		expect(manager.getSessionId()).toBeTruthy();
		expect(manager.getEntries()).toHaveLength(0);
		const persisted = readLines(file);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
	});

	it("still truncates a file whose intact head is not a session header", () => {
		const headless = JSON.stringify({
			type: "message",
			id: "abc",
			parentId: "orphaned",
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "no header here", timestamp: 1 },
		});
		const { file, dir } = createSessionFile("no-header.jsonl", `${headless}\n`);

		const manager = SessionManager.open(file, dir);

		expect(manager.getEntries()).toHaveLength(0);
		const persisted = readLines(file);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
	});

	it("still writes a fresh header when nothing after the damaged head parses", () => {
		const { file, dir } = createSessionFile("garbage.jsonl", "not json at all\nstill not json\n");

		const manager = SessionManager.open(file, dir);

		expect(manager.getEntries()).toHaveLength(0);
		const persisted = readLines(file);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
	});
});
