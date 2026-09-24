import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/** Rows the block may take above the prompt, title included. */
export const DUTY_LOG_MAX_ROWS = 6;

/**
 * The duty log shown above the prompt: an accent title row, then dim fact
 * rows indented one column. The incidents row may wrap onto a second row;
 * every other row truncates, and the block never exceeds
 * {@link DUTY_LOG_MAX_ROWS} rows (the last fact rows drop first).
 */
export class DutyLogBlock implements Component {
	constructor(private readonly lines: readonly string[]) {}

	invalidate(): void {
		// Rendered from the fixed lines.
	}

	render(width: number): string[] {
		const [title, ...facts] = this.lines;
		if (!title) return [];
		const safeWidth = Math.max(1, width);
		const rows = [truncateToWidth(` ${theme.fg("accent", title)}`, safeWidth, "…")];
		for (const fact of facts) {
			if (rows.length >= DUTY_LOG_MAX_ROWS) break;
			const room = DUTY_LOG_MAX_ROWS - rows.length;
			const wrapped =
				fact.startsWith("出问题") && room > 1 ? wrapTextWithAnsi(fact, Math.max(1, safeWidth - 2)) : [];
			if (wrapped.length > 1) {
				const shown = wrapped.slice(0, 2);
				if (wrapped.length > 2) shown[1] = truncateToWidth(`${shown[1]}…`, Math.max(1, safeWidth - 2), "…");
				for (const row of shown) rows.push(this.factRow(row, safeWidth));
			} else {
				rows.push(this.factRow(fact, safeWidth));
			}
		}
		return [...rows.slice(0, DUTY_LOG_MAX_ROWS), ""];
	}

	private factRow(text: string, width: number): string {
		const row = truncateToWidth(`  ${text}`, width, "…");
		return theme.fg("dim", row) + " ".repeat(Math.max(0, width - visibleWidth(row)));
	}
}
