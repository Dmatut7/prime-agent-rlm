import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, resolveBuiltinSlashCommandName } from "../src/core/slash-commands.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const HOUR = 3_600_000;

type DutyLogHarness = {
	connectionState: { sessionFile?: string };
	settingsManager: { getDutyLogAfterMinutes: () => number };
	subagentSnapshots: Map<string, unknown>;
	rlmNodeId: string | undefined;
	dutyLogContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showDutyLog(options: { automatic: boolean }): Promise<void>;
	lastOwnerKeyAt: number;
	dutyLogReturnRoute(data: string): undefined;
};

function transcript(lastOwnerAt: number): string {
	const lines = [
		{ type: "session", id: "s", cwd: "/w" },
		{
			type: "message",
			id: "u",
			parentId: null,
			timestamp: new Date(lastOwnerAt).toISOString(),
			message: { role: "user", content: "干活", timestamp: lastOwnerAt },
		},
		{
			type: "message",
			id: "a",
			parentId: "u",
			timestamp: new Date(lastOwnerAt + 60_000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "做完了。" }],
				stopReason: "stop",
				model: "glm-5.3-prime",
				timestamp: lastOwnerAt + 60_000,
			},
		},
	];
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("InteractiveMode duty log", () => {
	beforeAll(() => initTheme("dark"));
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function harness(awayMs: number, thresholdMinutes = 120): DutyLogHarness {
		const dir = mkdtempSync(join(tmpdir(), "duty-log-mode-"));
		dirs.push(dir);
		const sessionFile = join(dir, "s.jsonl");
		writeFileSync(sessionFile, transcript(Date.now() - awayMs));
		const fake = {
			connectionState: { sessionFile },
			settingsManager: { getDutyLogAfterMinutes: () => thresholdMinutes },
			subagentSnapshots: new Map(),
			rlmNodeId: undefined,
			dutyLogContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			lastOwnerKeyAt: Date.now(),
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return fake as unknown as DutyLogHarness;
	}

	it("shows itself only after the owner has been away longer than the setting", async () => {
		const recent = harness(30 * 60_000);
		await recent.showDutyLog({ automatic: true });
		expect(recent.dutyLogContainer.children).toHaveLength(0);

		const away = harness(5 * HOUR);
		await away.showDutyLog({ automatic: true });
		expect(away.dutyLogContainer.children).toHaveLength(1);
		const rows = away.dutyLogContainer.render(100).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(rows[0]).toMatch(/^ 值班记录 · 离开 5 小时/);
	});

	it("shows itself on the first key after the owner left the TUI attached and idle past the setting", async () => {
		// Attached for two days: no start, attach or resume ever happens, so the first key after
		// the idle gap is the moment the owner came back.
		const mode = harness(2 * 24 * HOUR);
		mode.lastOwnerKeyAt = Date.now() - 2 * 24 * HOUR;
		// A terminal cell-size reply and a mouse report are not the owner pressing a key.
		expect(mode.dutyLogReturnRoute("\x1b[6;18;9t")).toBeUndefined();
		expect(mode.dutyLogReturnRoute("\x1b[<35;10;5M")).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mode.dutyLogContainer.children).toHaveLength(0);

		expect(mode.dutyLogReturnRoute("a")).toBeUndefined();
		await vi.waitFor(() => expect(mode.dutyLogContainer.children).toHaveLength(1));
		const rows = mode.dutyLogContainer.render(100).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(rows[0]).toMatch(/^ 值班记录 · 离开 2 天/);

		// The next keys are typing, not another return.
		mode.dutyLogContainer.clear();
		mode.dutyLogReturnRoute("b");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mode.dutyLogContainer.children).toHaveLength(0);
	});

	it("stays off automatically when the setting is 0, but answers /dutylog", async () => {
		const mode = harness(5 * HOUR, 0);
		await mode.showDutyLog({ automatic: true });
		expect(mode.dutyLogContainer.children).toHaveLength(0);
		await mode.showDutyLog({ automatic: false });
		expect(mode.dutyLogContainer.children).toHaveLength(1);
	});

	it("says so when nothing happened or there is no transcript", async () => {
		const quiet = harness(5 * HOUR);
		writeFileSync(quiet.connectionState.sessionFile as string, "");
		await quiet.showDutyLog({ automatic: false });
		expect(quiet.showStatus).toHaveBeenCalledWith("你离开之后这个会话没有新的动静");

		const none = harness(HOUR);
		none.connectionState.sessionFile = undefined;
		await none.showDutyLog({ automatic: false });
		expect(none.showStatus).toHaveBeenCalledWith("这个会话没有记录文件，没有值班记录可看");
		await none.showDutyLog({ automatic: true });
		expect(none.showStatus).toHaveBeenCalledTimes(1);
	});

	it("is a builtin command reachable as /dutylog and /值班", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "dutylog")?.description).toContain("值班记录");
		expect(resolveBuiltinSlashCommandName("值班")).toBe("dutylog");
	});
});
