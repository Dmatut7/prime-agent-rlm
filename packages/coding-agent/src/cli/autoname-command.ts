/**
 * `prime-agent autoname` - backfill readable names onto sessions that never
 * got one. Root and message-triggered sessions created before auto-naming (or
 * with it disabled) carry no `session_info` entry, so rosters and pickers fall
 * back to UUIDs. This command plans the same name the runtime hook would have
 * derived (the first inbound content), prints it dry-run first, and writes
 * only with --apply - through the owned-file write lease, exactly like daemon
 * catalog renames.
 *
 * Deliberately skipped: transcripts without any assistant reply (still
 * discardable empty drafts; naming them would pin garbage rows), and legacy
 * version files (the append fast path refuses them and the fallback would
 * migrate-rewrite PM history just to decorate it).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, getSessionsDir } from "../config.js";
import { deriveAutoSessionName, scanSessionNamingFacts, uniquifyAutoName } from "../core/session-auto-name.js";
import {
	appendOwnedFastEntryAsync,
	appendSessionInfoToExistingFile,
	CURRENT_SESSION_VERSION,
} from "../core/session-manager.js";

export interface AutonamePlanRow {
	sessionId: string;
	file: string;
	source: "first-inbound" | "skipped";
	reason?: "named" | "empty-draft" | "legacy-version" | "no-source";
	name?: string;
	auto?: boolean;
}

/** The plan for one transcript, given the names already taken by siblings. */
export function planAutonameForFile(file: string, sessionId: string, taken: Set<string>): AutonamePlanRow {
	return planAutonameForFileWithFacts(file, sessionId, taken, scanSessionNamingFacts(file));
}

export function planAutonameForDir(sessionsDir: string): AutonamePlanRow[] {
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return [];
	}
	const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
	// Seed the taken set with every settled name so planned names never collide
	// with an existing sibling (name-based agent-message routing throws on twins).
	const taken = new Set<string>();
	const factsByFile = new Map<string, ReturnType<typeof scanSessionNamingFacts>>();
	for (const entry of files) {
		const facts = scanSessionNamingFacts(join(sessionsDir, entry));
		factsByFile.set(entry, facts);
		if (facts.nameInfo) taken.add(facts.nameInfo.name);
	}
	const rows: AutonamePlanRow[] = [];
	for (const entry of files) {
		const file = join(sessionsDir, entry);
		const sessionId = entry.slice(0, -".jsonl".length);
		const row = planAutonameForFileWithFacts(file, sessionId, taken, factsByFile.get(entry)!);
		rows.push(row);
	}
	return rows;
}

function planAutonameForFileWithFacts(
	file: string,
	sessionId: string,
	taken: Set<string>,
	facts: ReturnType<typeof scanSessionNamingFacts>,
): AutonamePlanRow {
	if (facts.nameInfo) {
		return { sessionId, file, source: "skipped", reason: "named" };
	}
	if (!facts.hasAssistant) {
		return { sessionId, file, source: "skipped", reason: "empty-draft" };
	}
	if (facts.headerVersion !== CURRENT_SESSION_VERSION) {
		return { sessionId, file, source: "skipped", reason: "legacy-version" };
	}
	const derived = facts.derivedName;
	if (!derived) {
		return { sessionId, file, source: "skipped", reason: "no-source" };
	}
	const name = uniquifyAutoName(derived, taken);
	taken.add(name);
	return { sessionId, file, source: "first-inbound", name, auto: true };
}

export async function runAutonameCommand(args: string[]): Promise<number> {
	const apply = args.includes("--apply");
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--json");
	if (unknown.length > 0) {
		console.error("Usage: prime-agent autoname [--apply] [--json]");
		return 1;
	}
	const sessionsDir = getSessionsDir();
	const rows = planAutonameForDir(sessionsDir);
	const planned = rows.filter((row) => row.source === "first-inbound" && row.name);
	const skipped = rows.filter((row) => row.source === "skipped");
	const skippedByReason: Record<string, number> = {};
	for (const row of skipped) {
		if (row.reason === "named") continue;
		const reason = row.reason ?? "other";
		skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
	}
	if (json) {
		// Report-only on purpose: a machine-readable plan must never write as a
		// side effect of asking for JSON.
		console.log(JSON.stringify({ sessionsDir, planned, skipped, skippedByReason }, null, 2));
		return 0;
	}
	if (planned.length === 0) {
		console.log("No unnamed session transcript needs a name; nothing to do.");
	} else {
		console.log(`${planned.length} unnamed session(s) in ${sessionsDir} would be named:`);
		for (const row of planned) {
			console.log(`  ${row.sessionId.slice(0, 8)}  ${row.name}`);
		}
		if (Object.keys(skippedByReason).length > 0) {
			const detail = Object.entries(skippedByReason)
				.map(([reason, count]) => `${reason}: ${count}`)
				.join(", ");
			console.log(`Skipped (${detail}) - see "prime-agent autoname --json" for the list.`);
		}
	}
	if (!apply) {
		if (planned.length > 0) console.log("Dry run: re-run with --apply to write these names.");
		return 0;
	}
	const agentDir = getAgentDir();
	let written = 0;
	const failures: string[] = [];
	for (const row of planned) {
		if (!row.name) continue;
		const name = row.name;
		try {
			await appendOwnedFastEntryAsync(
				row.file,
				agentDir,
				() => appendSessionInfoToExistingFile(row.file, name, { auto: true }),
				(manager) => {
					manager.appendSessionInfo(name, { auto: true });
				},
			);
			written += 1;
		} catch (error) {
			failures.push(`${row.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.log(`Wrote ${written} name(s).`);
	for (const failure of failures) console.error(`  failed ${failure}`);
	return failures.length > 0 && written === 0 ? 1 : 0;
}
