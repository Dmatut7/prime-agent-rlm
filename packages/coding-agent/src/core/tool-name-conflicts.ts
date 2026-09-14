import type { ResourceDiagnostic } from "./diagnostics.js";

/** Where a registered tool definition came from. */
export type ToolSourceKind = "builtin" | "extension" | "sdk" | "acp-mcp";

export interface ToolNameSource {
	/** Tool name as it is exposed to the model. */
	name: string;
	kind: ToolSourceKind;
	/** Human readable origin, e.g. `<builtin:ipython>`, `<sdk:bash>` or an extension file path. */
	label: string;
	/** Path used for diagnostics rendering. Extension sources pass their file path. */
	path?: string;
}

export interface ToolNameConflict {
	name: string;
	winner: ToolNameSource;
	/** Sources that lost the name and whose tool can never be called. */
	losers: ToolNameSource[];
	/** A tool name derived from `name` that no registered tool currently occupies. */
	availableName: string;
}

export interface ToolNameConflictResult {
	winnerByKey: Map<string, ToolNameSource>;
	conflicts: ToolNameConflict[];
	diagnostics: ResourceDiagnostic[];
}

function sourceKindLabel(kind: ToolSourceKind): string {
	return kind === "acp-mcp" ? "ACP MCP" : kind;
}

/** First unused name of the form `<name>2`, `<name>3`, ... */
export function findAvailableToolName(name: string, occupied: ReadonlySet<string>): string {
	let suffix = 2;
	while (occupied.has(`${name}${suffix}`)) {
		suffix++;
	}
	return `${name}${suffix}`;
}

export function formatToolNameConflict(conflict: ToolNameConflict): string {
	const describe = (source: ToolNameSource) => `${source.label} (${sourceKindLabel(source.kind)} tool)`;
	const providedBy = [conflict.winner, ...conflict.losers].map(describe).join(" and ");
	const unreachable = conflict.losers.map(describe).join(", ");
	const shadowsBuiltIn = conflict.losers.some((loser) => loser.kind === "builtin");
	return (
		`Tool name conflict for "${conflict.name}": provided by ${providedBy}. Using ${describe(conflict.winner)}; ` +
		`${unreachable} is unreachable and cannot be called. Rename one of the conflicting tools (the name "${conflict.availableName}" is free).` +
		(shadowsBuiltIn
			? ' Internal code that resolves a tool by name (for example goal continuation, which looks up "ipython") keeps driving the shadowing tool.'
			: "")
	);
}

/**
 * Report tool name collisions without changing which tool wins.
 *
 * `resolution` mirrors the registry that owns the ordering:
 * - `"last-wins"` matches the session tool registry (built-ins first, custom tools applied after, so a
 *   custom tool overrides the built-in name it reuses).
 * - `"first-wins"` matches the extension runner, where the first extension to register a name keeps it.
 */
export function detectToolNameConflicts(
	entries: readonly ToolNameSource[],
	resolution: "first-wins" | "last-wins" = "last-wins",
): ToolNameConflictResult {
	const winnerByKey = new Map<string, ToolNameSource>();
	const losersByKey = new Map<string, ToolNameSource[]>();
	const seenNames = new Set<string>();

	for (const entry of entries) {
		seenNames.add(entry.name);
		const existing = winnerByKey.get(entry.name);
		if (!existing) {
			winnerByKey.set(entry.name, entry);
			continue;
		}
		const losers = losersByKey.get(entry.name) ?? [];
		if (resolution === "last-wins") {
			losers.push(existing);
			winnerByKey.set(entry.name, entry);
		} else {
			losers.push(entry);
		}
		losersByKey.set(entry.name, losers);
	}

	const occupied = new Set(seenNames);
	const conflicts: ToolNameConflict[] = [];
	for (const [name, losers] of losersByKey) {
		const winner = winnerByKey.get(name);
		if (!winner) continue;
		conflicts.push({ name, winner, losers, availableName: findAvailableToolName(name, occupied) });
	}

	const diagnostics: ResourceDiagnostic[] = conflicts.map((conflict) => ({
		type: "warning",
		message: formatToolNameConflict(conflict),
		path: conflict.losers[0]?.path ?? conflict.winner.path,
	}));

	return { winnerByKey, conflicts, diagnostics };
}
