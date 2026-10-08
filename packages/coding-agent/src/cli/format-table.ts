import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Width budget for `formatTable`: how many terminal columns the table may take,
 * and which columns to sacrifice when the natural table is wider.
 */
export interface TableWidthBudget<T extends Record<string, string>> {
	/** Visible columns available. Undefined keeps the legacy unbounded table. */
	width?: number;
	/** Columns to drop when over budget, least valuable first. Unlisted columns are never dropped. */
	dropOrder?: readonly (keyof T)[];
}

/**
 * A plain two-space-separated table with padded columns. Without a width budget
 * the output is the legacy unbounded table. With one, columns leave in
 * `dropOrder` until the table fits; the survivors then give up width widest-first
 * (truncated with an ellipsis, headers kept whole) until every line fits.
 */
export function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
	budget: TableWidthBudget<T> = {},
): string {
	if (budget.width === undefined) {
		const widths = columns.map((column) =>
			Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
		);
		const lines = [columns.map((column, index) => String(column).padEnd(widths[index]!)).join("  ")];
		for (const row of rows) {
			const line = columns
				.map((column, index) => {
					const value = String(row[column]).padEnd(widths[index]!);
					return formatCell ? formatCell(row, column, value) : value;
				})
				.join("  ");
			lines.push(line);
		}
		return lines.join("\n");
	}

	const width = budget.width;
	const active = [...columns];
	const widths = active.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => visibleWidth(String(row[column])))),
	);
	const totalWidth = () => widths.reduce((sum, cellWidth) => sum + cellWidth, 0) + 2 * (active.length - 1);

	for (const drop of budget.dropOrder ?? []) {
		if (totalWidth() <= width || active.length <= 1) break;
		const index = active.indexOf(drop);
		if (index === -1) continue;
		active.splice(index, 1);
		widths.splice(index, 1);
	}
	// Every column keeps at least its header whole; a column narrower than that
	// reads as a different table.
	while (totalWidth() > width) {
		let widest = -1;
		for (let index = 0; index < active.length; index++) {
			const floor = String(active[index]!).length;
			if (widths[index]! > floor && (widest === -1 || widths[widest]! < widths[index]!)) {
				widest = index;
			}
		}
		if (widest === -1) break;
		const floor = String(active[widest]!).length;
		widths[widest] = Math.max(floor, widths[widest]! - (totalWidth() - width));
	}

	const renderCell = (value: string, index: number) => truncateToWidth(value, widths[index]!, "…", true);
	const lines = [active.map((column, index) => renderCell(String(column), index)).join("  ")];
	for (const row of rows) {
		const line = active
			.map((column, index) => {
				const value = renderCell(String(row[column]), index);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}
