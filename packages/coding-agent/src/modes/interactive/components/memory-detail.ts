import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KernelMemoryChange } from "../../../core/kernel/shared.js";
import { theme } from "../theme/theme.js";
import { type DiffRow, diffRowsFromEdit, renderDiffRows, sanitizeDisplayText } from "./diff-rows.js";
import { cleanMemoryTitle } from "./feed-data.js";

/**
 * What a memory change says once opened on the timeline: the memory's own
 * words, wrapped to the width and never cut. A new memory is plain text (no
 * `+`); a changed one shows only the lines that differ under `原来` / `现在`;
 * a deleted one shows what it held.
 */

const SENSITIVE_TEXT = "内容没存：看起来是密钥";

/** The most characters the kernel keeps of one memory text; a longer one is cut to this many, ending in `…`. */
const KERNEL_MEMORY_TEXT_CAP = 4000;
const CUT_NOTE = `（只记录了前 ${KERNEL_MEMORY_TEXT_CAP} 字，完整内容在记忆库里）`;

/** Whether the kernel cut this text at its cap (it is exactly the cap long and ends with the cut mark). */
function cutByKernel(text: string | undefined): boolean {
	return text !== undefined && text.endsWith("…") && [...text].length === KERNEL_MEMORY_TEXT_CAP;
}

/** The verb-plus-kind that heads a memory's timeline row (`记住了`, `改了记忆`, `删了技能`). */
export function memoryHeadLabel(change: KernelMemoryChange): string {
	const noun =
		change.kind === "rules_file"
			? change.scope === "project"
				? "项目规则"
				: "全局规则"
			: change.kind === "skill"
				? "技能"
				: change.kind === "subagent"
					? "子代理设定"
					: change.kind === "prompt_note"
						? "提示"
						: "";
	if (change.op === "created") return `记住了${noun}`;
	return `${change.op === "deleted" ? "删了" : "改了"}${noun || "记忆"}`;
}

/** Whether the change moved from one title to another. */
export function memoryRenamed(change: KernelMemoryChange): boolean {
	return change.previousTitle !== undefined && change.previousTitle !== change.title;
}

function wrapped(text: string, width: number): string[] {
	const parts = wrapTextWithAnsi(text, width);
	return parts.length > 0 ? parts : [""];
}

/** `text` split at its own line breaks, each wrapped to `width`; blank lines stay as blank rows. */
function plainLines(text: string, width: number): string[] {
	return sanitizeDisplayText(text)
		.split("\n")
		.flatMap((line) => wrapped(line.trimEnd() === "" ? "" : theme.fg("timelineSoft", line.trimEnd()), width));
}

/** Every line of an opened memory change, each at most `width` columns wide. */
export function memoryBodyLines(change: KernelMemoryChange, width: number): string[] {
	const room = Math.max(4, width);
	const label = (text: string) => theme.fg("timelineTime", text);
	const lines: string[] = [];
	if (memoryRenamed(change) && change.previousTitle !== undefined) {
		lines.push(
			...wrapped(
				`${label("改名  ")}${theme.fg("timelineSoft", cleanMemoryTitle(change.previousTitle))}${label(" → ")}${theme.fg("text", cleanMemoryTitle(change.title))}`,
				room,
			),
		);
	}
	if (change.textOmitted === "sensitive") {
		lines.push(...wrapped(label(SENSITIVE_TEXT), room));
		return lines;
	}
	const before = change.before?.trimEnd() ?? "";
	const after = change.after?.trimEnd() ?? "";
	const paint = (rows: DiffRow[]) => renderDiffRows(rows, { width: room, indent: 0, wrap: true });
	if (change.op === "created" || (!before && after)) {
		lines.push(...plainLines(after, room));
	} else if (change.op === "deleted" || (before && !after)) {
		lines.push(label("删掉的"));
		lines.push(...paint(before.split("\n").map((text) => ({ kind: "del" as const, text }))));
	} else if (before || after) {
		const rows = diffRowsFromEdit(before, after).filter((row) => row.kind !== "ctx");
		const removed = rows.filter((row) => row.kind === "del");
		const added = rows.filter((row) => row.kind === "add");
		if (removed.length > 0) {
			lines.push(label("原来"));
			lines.push(...paint(removed));
		}
		if (added.length > 0) {
			lines.push(label("现在"));
			lines.push(...paint(added));
		}
		if (removed.length === 0 && added.length === 0) lines.push(label("内容没变"));
	} else {
		lines.push(label("没有记录到内容"));
	}
	if (cutByKernel(change.before) || cutByKernel(change.after)) {
		lines.push(...wrapped(theme.fg("timelineFaint", CUT_NOTE), room));
	}
	return lines;
}
