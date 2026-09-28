import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";

/**
 * One file's change as display rows, whatever form it arrived in: a unified
 * diff from the kernel (`KernelFileChange.diff`), the numbered diff the edit
 * tool writes, or an old/new pair from the edit skill. Every card, inline
 * preview and the pager render these rows the same way.
 */
export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "gap";

export interface DiffRow {
	kind: DiffRowKind;
	/** Line number in the new file (old file for removed lines); absent for hunk and gap rows. */
	line?: number;
	/** Line text, or the hunk's section heading. */
	text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;
const NUMBERED_LINE = /^([+\- ])\s*(\d+) (.*)$/;
const NUMBERED_GAP = /^ \s*\.\.\.$/;

/** Terminal control characters in file content must never reach the screen raw. */
export function sanitizeDisplayText(text: string): string {
	return text.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, "");
}

/** A standard unified diff (`--- a/x`, `+++ b/x`, `@@ -1,3 +1,4 @@`) as rows. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const raw of diff.split("\n")) {
		const header = HUNK_HEADER.exec(raw);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			inHunk = true;
			rows.push({ kind: "hunk", line: newLine, text: sanitizeDisplayText(header[3] ?? "").trim() });
			continue;
		}
		if (!inHunk) continue;
		if (raw.startsWith("\\")) continue;
		const sign = raw[0];
		const text = sanitizeDisplayText(raw.slice(1));
		if (sign === "+") {
			rows.push({ kind: "add", line: newLine, text });
			newLine++;
		} else if (sign === "-") {
			rows.push({ kind: "del", line: oldLine, text });
			oldLine++;
		} else if (sign === " " || raw === "") {
			if (raw === "" && rows.at(-1)?.kind === "hunk") continue;
			rows.push({ kind: "ctx", line: newLine, text });
			oldLine++;
			newLine++;
		} else if (raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
			inHunk = false;
		}
	}
	while (rows.at(-1)?.kind === "ctx" && rows.at(-1)?.text === "") rows.pop();
	return rows;
}

/** The edit tool's numbered diff (`+12 text`, `-12 text`, ` 12 text`, `   ...`) as rows. */
export function parseNumberedDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const raw of diff.split("\n")) {
		if (NUMBERED_GAP.test(raw)) {
			rows.push({ kind: "gap", text: "" });
			continue;
		}
		const match = NUMBERED_LINE.exec(raw);
		if (!match) continue;
		const kind: DiffRowKind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
		rows.push({ kind, line: Number(match[2]), text: sanitizeDisplayText(match[3] ?? "") });
	}
	return rows;
}

/** An old/new replacement (the edit skill's diff display) as rows with two lines of context. */
export function diffRowsFromEdit(oldStr: string, newStr: string, startLine = 1): DiffRow[] {
	return parseNumberedDiff(generateDiffString(oldStr, newStr, 2, startLine).diff);
}

export function countDiffRows(rows: readonly DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added++;
		else if (row.kind === "del") removed++;
	}
	return { added, removed };
}

/** The first removed and first added line: the two-line preview under a feed row. */
export function previewDiffRows(rows: readonly DiffRow[], max = 2): DiffRow[] {
	const removed = rows.find((row) => row.kind === "del" && row.text.trim());
	const added = rows.find((row) => row.kind === "add" && row.text.trim());
	return [removed, added].filter((row): row is DiffRow => row !== undefined).slice(0, max);
}

export interface DiffRenderOptions {
	/** Columns available for the whole row. */
	width: number;
	/** Blank columns before the line number. */
	indent: number;
	/** Wrap long lines onto continuation rows (the pager) instead of cutting them. */
	wrap?: boolean;
	/** Heading shown on hunk rows that carry no section of their own (`credits.py`). */
	fileLabel?: string;
}

function lineNumberWidth(rows: readonly DiffRow[]): number {
	let max = 0;
	for (const row of rows) if (row.line !== undefined && row.line > max) max = row.line;
	return Math.max(3, String(max).length);
}

/**
 * Rows as terminal lines: faint line numbers, changed lines in their meaning
 * color on a subtle tint (truecolor only; 256-color quantizes a dark tint to
 * black, so the text color carries it alone there), context faint.
 */
export function renderDiffRows(rows: readonly DiffRow[], options: DiffRenderOptions): string[] {
	const width = Math.max(1, options.width);
	const numberWidth = lineNumberWidth(rows);
	const pad = " ".repeat(Math.max(0, Math.min(options.indent, width - 1)));
	const gutterWidth = pad.length + numberWidth + 3;
	const textWidth = Math.max(4, width - gutterWidth);
	const tint = theme.colorMode === "truecolor";
	const lines: string[] = [];
	for (const row of rows) {
		if (row.kind === "hunk") {
			const where =
				row.line !== undefined
					? `${options.fileLabel ? `${options.fileLabel}:` : "第 "}${row.line}${options.fileLabel ? "" : " 行"}`
					: "";
			const heading = [where, row.text].filter((part) => part.length > 0).join("  ");
			lines.push(truncateToWidth(`${pad}${theme.fg("dim", `@@ ${heading}`)}`, width, "…"));
			continue;
		}
		if (row.kind === "gap") {
			lines.push(truncateToWidth(`${pad}${" ".repeat(numberWidth)}  ${theme.fg("dim", "⋮")}`, width, ""));
			continue;
		}
		const number = theme.fg("dim", (row.line === undefined ? "" : String(row.line)).padStart(numberWidth, " "));
		const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
		const segments = options.wrap
			? wrapTextWithAnsi(row.text, textWidth)
			: [truncateToWidth(row.text, textWidth, "…")];
		if (segments.length === 0) segments.push("");
		segments.forEach((segment, index) => {
			const head = index === 0 ? `${pad}${number} ` : " ".repeat(gutterWidth - 2);
			const signText = index === 0 ? sign : " ";
			if (row.kind === "ctx") {
				lines.push(truncateToWidth(`${head}${theme.fg("dim", ` ${segment}`)}`, width, ""));
				return;
			}
			const color = row.kind === "add" ? "diffAddedText" : "diffRemovedText";
			const body = `${signText} ${segment}`;
			const bodyWidth = Math.min(width - visibleWidth(head), Math.max(visibleWidth(body) + 1, 0));
			const padded = body + " ".repeat(Math.max(0, bodyWidth - visibleWidth(body)));
			const colored = theme.fg(color, padded);
			const painted = tint
				? theme.bg(row.kind === "add" ? "diffAddedLineBg" : "diffRemovedLineBg", colored)
				: colored;
			lines.push(truncateToWidth(`${head}${painted}`, width, ""));
		});
	}
	return lines;
}
