import type { Api, Model } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionListTable } from "../src/cli/daemon-list-format.js";
import type { SessionActivity, SessionLifecycle, SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

describe("formatSessionListTable", () => {
	it("sorts sessions by status and renders compact suffix ids", () => {
		const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
		const table = stripAnsi(
			formatSessionListTable(
				[
					makeSummary({
						name: "sleep",
						id: "019e71ec-e08a-75a9-b573-fc10e9f8380f",
						lifecycle: "archived",
						activity: "idle",
					}),
					makeSummary({ name: "tool", id: "ccccddddeeee", lifecycle: "live", activity: "working" }),
					makeSummary({
						name: "crash",
						id: "019e71ec-e08a-75a9-b573-abcdef123456",
						lifecycle: "archived",
						activity: "idle",
					}),
					makeSummary({ name: "idle", id: "bbbbccccdddd", lifecycle: "live", activity: "idle" }),
					makeSummary({ name: "model", id: "ddddeeeeffff", lifecycle: "live", activity: "working" }),
					makeSummary({
						name: "user",
						id: "aaaabbbbcccc",
						lifecycle: "live",
						activity: "idle",
						clients: 1,
						model: { provider: "openai-codex", id: "gpt-5.5" } as Model<Api>,
					}),
				],
				nowMs,
			),
		);

		const lines = table.split("\n");
		expect(lines[0]!.trim().split(/\s+/)).toEqual(["name", "id", "status", "age", "model", "messages", "clients"]);
		expect(lines.slice(1).map((line) => line.trim().split(/\s+/).slice(0, 3))).toEqual([
			["tool", "ccccddddeeee", "working"],
			["model", "ddddeeeeffff", "working"],
			["idle", "bbbbccccdddd", "idle"],
			["user", "aaaabbbbcccc", "idle"],
			["sleep", "fc10e9f8380f", "archived"],
			["crash", "abcdef123456", "archived"],
		]);
		expect(table).toContain("openai-codex/gpt-5.5");
		expect(table).not.toContain("/tmp/project");
		expect(table).not.toContain("019e71ec-e08a");
	});
});

function makeSummary(options: {
	name: string;
	id: string;
	lifecycle: SessionLifecycle;
	activity: SessionActivity;
	clients?: number;
	model?: Model<Api>;
}): SessionSummary {
	return {
		id: options.id,
		lifecycle: options.lifecycle,
		activity: options.activity,
		isSessionActive: options.activity === "working",
		sessionId: options.id,
		sessionName: options.name,
		cwd: "/tmp/project",
		model: options.model,
		isStreaming: options.lifecycle === "live" && options.activity === "working",
		isCompacting: false,
		attachedClients: options.clients ?? 0,
		messageCount: 2,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		modified: "2026-05-29T10:00:00.000Z",
	};
}

describe("formatSessionListTable width budget", () => {
	const nowMs = Date.parse("2026-05-29T12:00:00.000Z");

	it("keeps the full column set when no width is given", () => {
		const table = stripAnsi(
			formatSessionListTable(
				[makeSummary({ name: "s", id: "aaaabbbbcccc", lifecycle: "live", activity: "idle" })],
				nowMs,
			),
		);
		expect(table.split("\n")[0]!.trim().split(/\s+/)).toEqual([
			"name",
			"id",
			"status",
			"age",
			"model",
			"messages",
			"clients",
		]);
	});

	it("drops low-priority columns to fit the terminal width, keeping name and status", () => {
		const sessions = [
			makeSummary({
				name: "中文会话名",
				id: "aaaabbbbcccc",
				lifecycle: "live",
				activity: "working",
				clients: 2,
				model: { provider: "openai-codex", id: "gpt-5.5" } as Model<Api>,
			}),
		];
		const width = 40;
		const table = stripAnsi(formatSessionListTable(sessions, nowMs, { width }));
		const lines = table.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const header = lines[0]!.trim().split(/\s+/);
		expect(header).toContain("name");
		expect(header).toContain("status");
		// Sacrificed in drop order: clients, messages, model, age, id.
		expect(header).not.toContain("clients");
		expect(header).not.toContain("messages");
		expect(header).not.toContain("model");
		expect(lines[1]).toContain("working");
	});

	it("truncates the name with an ellipsis when even the kept columns overflow", () => {
		const sessions = [
			makeSummary({
				name: "a-very-long-session-name-that-cannot-fit",
				id: "aaaabbbbcccc",
				lifecycle: "live",
				activity: "idle",
			}),
		];
		const width = 24;
		const table = stripAnsi(formatSessionListTable(sessions, nowMs, { width }));
		const lines = table.split("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(lines[1]).toContain("…");
		expect(lines[1]).toContain("idle");
	});
});
