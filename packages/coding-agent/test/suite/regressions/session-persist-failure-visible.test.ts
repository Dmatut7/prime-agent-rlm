import { constants, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.js";
import { createHarness, type Harness } from "../harness.js";

const fsMocks = vi.hoisted(() => ({
	failNextJsonlAppend: false,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: (
			path: Parameters<typeof actual.openSync>[0],
			flags: Parameters<typeof actual.openSync>[1],
			mode?: number,
		) => {
			if (
				fsMocks.failNextJsonlAppend &&
				typeof path === "string" &&
				path.endsWith(".jsonl") &&
				typeof flags === "number" &&
				(flags & constants.O_APPEND) !== 0 &&
				(flags & constants.O_EXCL) === 0
			) {
				fsMocks.failNextJsonlAppend = false;
				throw Object.assign(new Error("injected append failure"), { code: "EIO" });
			}
			return actual.openSync(path, flags, mode);
		},
	};
});

describe("issue: session append failures are visible and recoverable", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		fsMocks.failNextJsonlAppend = false;
		harness?.cleanup();
		harness = undefined;
	});

	it("surfaces a failed append and backfills it on the next successful persist", async () => {
		harness = await createHarness({ persistSession: true });
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => events.push(event));

		// Turn one writes the transcript via a full rewrite (no append yet).
		harness.setResponses([fauxAssistantMessage("first reply")]);
		await harness.session.prompt("turn one");

		// Turn two: the user message hits the append path; inject one disk failure.
		fsMocks.failNextJsonlAppend = true;
		harness.setResponses([fauxAssistantMessage("second reply")]);
		await harness.session.prompt("turn two");
		await new Promise((resolve) => setTimeout(resolve, 0));

		// (b) The failure is user-visible instead of vanishing into the queue's catch.
		const persistFailures = events.filter((event) => event.type === "session_persist_failed");
		expect(persistFailures.length).toBeGreaterThan(0);
		expect(persistFailures[0]).toMatchObject({ type: "session_persist_failed", error: "injected append failure" });

		// Liveness: the failed event did not stall the queue; the second turn completed.
		const assistantTexts = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message.content));
		expect(assistantTexts.some((text) => text.includes("first reply"))).toBe(true);
		expect(assistantTexts.some((text) => text.includes("second reply"))).toBe(true);

		// (a)+(c) The flushed mark was dropped, so the next persist rewrote the full
		// transcript and backfilled the entry whose append failed.
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing session file");
		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain("turn one");
		expect(content).toContain("first reply");
		expect(content).toContain("turn two");
		expect(content).toContain("second reply");
	});

	it("backs off failure reports exponentially regardless of error text", async () => {
		harness = await createHarness({ persistSession: true });
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => events.push(event));
		const session = harness.session as unknown as {
			_reportSessionPersistFailure(error: unknown): void;
			_resetSessionPersistFailureBackoff(): void;
		};

		session._reportSessionPersistFailure(new Error("disk full"));
		session._reportSessionPersistFailure(new Error("different error text"));
		session._reportSessionPersistFailure(new Error("disk full"));

		// Distinct errors must not each reach the UI: only the first passes the
		// backoff window.
		expect(events.filter((event) => event.type === "session_persist_failed")).toHaveLength(1);

		// A successful write ends the episode: the next failure reports at once.
		session._resetSessionPersistFailureBackoff();
		session._reportSessionPersistFailure(new Error("disk full again"));
		expect(events.filter((event) => event.type === "session_persist_failed")).toHaveLength(2);
	});
});
