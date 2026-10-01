import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type {
	AgentConnectionSessionMessageEntry,
	AgentConnectionSessionTreeNode,
} from "../src/modes/agent-connection/index.js";
import { joinHintSegments, SegmentedHintText } from "../src/modes/interactive/components/segmented-hint.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Hint rows are " · "-joined segments of key hints. Width truncation must drop whole
 * trailing segments: cutting a segment in half slices a key name ("Ctrl+D" → "Ctr") on
 * the one line whose whole job is telling the user which keys exist (ux-80 F6).
 */

const SEGMENTS = [
	"↑/↓ 移动",
	"←/→ 翻页",
	"^←/^→ 折叠/切分支",
	"Ctrl+D/Ctrl+T 筛选",
	"Shift+T 标签时间",
	"Enter 回到这里",
];

describe("joinHintSegments", () => {
	it("joins every segment when the row fits", () => {
		const full = SEGMENTS.join(" · ");
		expect(joinHintSegments(SEGMENTS, visibleWidth(full))).toBe(full);
	});

	it("drops whole trailing segments behind an ellipsis", () => {
		const kept = SEGMENTS.slice(0, 3).join(" · ");
		const width = visibleWidth(`${kept} · …`);
		const result = joinHintSegments(SEGMENTS, width);
		expect(result).toBe(`${kept} · …`);
		expect(visibleWidth(result)).toBeLessThanOrEqual(width);
	});

	it("never emits half a segment at any width", () => {
		const full = SEGMENTS.join(" · ");
		for (let width = 1; width <= visibleWidth(full); width++) {
			const result = joinHintSegments(SEGMENTS, width);
			expect(visibleWidth(result)).toBeLessThanOrEqual(width);
			// A key name is either whole or gone: "Ctr" without the rest of its segment.
			if (!result.includes("Ctrl+D/Ctrl+T 筛选")) {
				expect(result).not.toContain("Ctr");
			}
			if (result.endsWith("…") && result !== "…") {
				const withoutMarker = result.slice(0, -1).replace(/ · $/, "");
				// The kept part is a prefix at a segment boundary, or the hard-cut fallback of
				// a first segment that alone exceeds the width.
				const boundaryPrefix = SEGMENTS.map((_, count) => SEGMENTS.slice(0, count + 1).join(" · ")).some(
					(prefix) => prefix === withoutMarker,
				);
				const hardCutFirstSegment = visibleWidth(SEGMENTS[0] ?? "") > width;
				expect(boundaryPrefix || hardCutFirstSegment).toBe(true);
			}
		}
	});

	it("keeps the first segment whole when only it fits without the ellipsis", () => {
		const width = visibleWidth(SEGMENTS[0] ?? "");
		expect(joinHintSegments(SEGMENTS, width)).toBe(SEGMENTS[0]);
	});

	it("hard-cuts with an ellipsis when even the first segment overflows", () => {
		const result = joinHintSegments(["Ctrl+D/Ctrl+T 筛选"], 6);
		expect(result.endsWith("…")).toBe(true);
		expect(visibleWidth(result)).toBeLessThanOrEqual(6);
	});

	it("handles empty input and zero width", () => {
		expect(joinHintSegments([], 20)).toBe("");
		expect(joinHintSegments(SEGMENTS, 0)).toBe("");
	});
});

describe("SegmentedHintText", () => {
	it("renders the joined segments as one line within the width", () => {
		const component = new SegmentedHintText(SEGMENTS);
		const full = SEGMENTS.join(" · ");
		expect(component.render(visibleWidth(full))).toEqual([full]);
		const narrow = component.render(20);
		expect(narrow).toHaveLength(1);
		expect(visibleWidth(narrow[0] ?? "")).toBeLessThanOrEqual(20);
	});
});

describe("TreeSelectorComponent hint line", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function message(id: string, content: string): AgentConnectionSessionMessageEntry {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content, timestamp: Date.now() },
		};
	}

	function treeOf(entries: AgentConnectionSessionMessageEntry[]): AgentConnectionSessionTreeNode[] {
		return entries.map((entry) => ({ entry, children: [] }));
	}

	it("drops whole key-hint segments at 80 columns instead of cutting a key in half", () => {
		const selector = new TreeSelectorComponent(
			treeOf([message("user-1", "hello")]),
			"user-1",
			24,
			() => {},
			() => {},
		);

		const line = stripAnsi(selector.render(80).join("\n"))
			.split("\n")
			.find((value) => value.includes("翻页"));
		expect(line).toBeDefined();
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(80);
		// The truncation actually happens at 80 columns: the last hint cannot survive.
		expect(line).not.toContain("Enter 回到这里");
		// …and it is signalled with an ellipsis after a complete segment, never mid-key.
		expect(line?.trimEnd().endsWith("…")).toBe(true);
		expect(line).not.toContain("Ctr");
	});
});
