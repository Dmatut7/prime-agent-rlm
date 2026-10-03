import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelFileChange } from "../src/core/kernel/shared.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ChangeEntry } from "../src/modes/interactive/components/feed-data.js";
import { type TimelineFacts, timelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import { STRIP_EDITS, type StripSource, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Change attribution in the turn strip: what this session changed (`own`) is counted and
 * listed as before; what only appeared in the workspace while the turn ran (`ambient` -
 * another window or process, per the kernel's command-window timing) is shown on its own
 * line, never folded into the session's count.
 */

const AT = new Date(2026, 8, 29, 19, 6, 20).getTime();

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

function file(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
	return {
		key: "/w/src/a.ts",
		path: "src/a.ts",
		kind: "modified",
		scope: "project",
		added: 12,
		removed: 3,
		rows: [],
		truncated: false,
		binary: false,
		firstAt: AT - 60_000,
		...overrides,
	};
}

function facts(overrides: Partial<TimelineFacts> = {}): TimelineFacts {
	return {
		thinkCount: 0,
		commandCount: 0,
		readCount: 0,
		stepCount: 1,
		subagentCount: 0,
		errorCount: 0,
		projectChanges: [],
		scratchChanges: [],
		memories: [],
		trackingIncomplete: false,
		...overrides,
	};
}

function strip(data: TimelineFacts, extra: Partial<StripSource> = {}) {
	const timeline = new TurnTimeline();
	const component = new TurnStripComponent({ timeline, facts: () => data, requestRender: vi.fn(), ...extra });
	return { component, timeline };
}

describe("turn strip change attribution", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the legacy wording when every change is the session's own", () => {
		const { component } = strip(facts({ projectChanges: [file()] }));
		const text = plain(component.render(100)).join("\n");
		expect(text).toContain("✎ 改了 1 个文件");
		expect(text).not.toContain("本会话");
		expect(text).not.toContain("另有");
	});

	it("shows ambient workspace changes on their own line and never in the session's count", () => {
		const { component } = strip(
			facts({ ambientChanges: [file({ key: "/w/ext.ts", path: "ext.ts", origin: "ambient" })] }),
		);
		const text = plain(component.render(100)).join("\n");
		expect(text).toContain("工作区另有 1 个变动");
		expect(text).not.toContain("改了 1 个文件");
	});

	it("counts only this session's files in the head when both kinds are present", () => {
		const { component } = strip(
			facts({
				projectChanges: [file(), file({ key: "/w/b.go", path: "b.go" })],
				ambientChanges: [file({ key: "/w/ext.ts", path: "ext.ts", origin: "ambient" })],
			}),
		);
		const text = plain(component.render(100)).join("\n");
		expect(text).toContain("本会话改了 2 个文件");
		expect(text).toContain("工作区另有 1 个变动");
	});

	it("lists ambient files in their own section when the edits open, own rows first", () => {
		const { component } = strip(
			facts({
				projectChanges: [file()],
				ambientChanges: [file({ key: "/w/ext.ts", path: "ext.ts", origin: "ambient" })],
			}),
		);
		component.activate(STRIP_EDITS);
		const text = plain(component.render(100)).join("\n");
		expect(text.indexOf("src/a.ts")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("ext.ts")).toBeGreaterThan(text.indexOf("src/a.ts"));
		expect(text).toContain("别的窗口或进程");
	});

	it("opens to the ambient file list when the session changed nothing itself", () => {
		const { component } = strip(
			facts({ ambientChanges: [file({ key: "/w/ext.ts", path: "ext.ts", origin: "ambient" })] }),
		);
		component.activate(STRIP_EDITS);
		const text = plain(component.render(100)).join("\n");
		expect(text).toContain("ext.ts");
	});

	it("keeps the commit note working when only ambient changes exist", () => {
		const { component } = strip(
			facts({
				commitId: "abc1234",
				ambientChanges: [file({ key: "/w/ext.ts", path: "ext.ts", origin: "ambient" })],
			}),
		);
		const text = plain(component.render(100)).join("\n");
		expect(text).toContain("已提交 abc1234");
		expect(text).toContain("工作区另有 1 个变动");
	});
});

describe("timelineFacts attribution split", () => {
	function kernelChange(path: string, origin?: KernelFileChange["origin"]): KernelFileChange {
		return {
			path,
			kind: "modified",
			scope: "project",
			added: 1,
			removed: 0,
			source: "shell",
			at: AT,
			...(origin ? { origin } : {}),
		};
	}

	it("puts ambient records in ambientChanges and keeps projectChanges this session's own", () => {
		const timeline = new TurnTimeline();
		timeline.stepData.set("tc1", {
			activities: [],
			memoryChanges: [],
			legacyDiffs: [],
			fileChanges: [
				kernelChange("/work/app/own.ts"),
				kernelChange("/work/app/cmd.ts", "own"),
				kernelChange("/work/app/ext.ts", "ambient"),
			],
		});
		const steps = new Map([
			["tc1", { toolCallId: "tc1", toolName: "ipython", args: { code: "pass" }, status: "done" as const }],
		]);
		const out = timelineFacts(timeline, [], { now: 0, cwd: "/work/app", steps, live: false, stopped: false });
		expect(out.projectChanges.map((change) => change.path)).toEqual(["own.ts", "cmd.ts"]);
		expect(out.ambientChanges?.map((change) => change.path)).toEqual(["ext.ts"]);
	});
});
