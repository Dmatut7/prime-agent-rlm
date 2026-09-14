// Delete primitive shared by every retention class.
//
// Two steps, never one: rename into a trash name, then remove the trash entry.
// A crash between the steps leaves a `.retention-trash-*` entry, which is inert
// (no reader resolves it) and is reclaimed by the next sweep that owns the
// parent directory.
import { lstatSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RetentionClassContext, RetentionSkip } from "./types.js";
import { SKIP } from "./types.js";

/** Prefix of the intermediate name used by the rename-then-remove delete. */
export const RETENTION_TRASH_PREFIX = ".retention-trash-";

export interface ReclaimRequest {
	path: string;
	kind: "file" | "dir";
	bytes: number;
	entries: number;
	/**
	 * `dev:ino:size:mtimeMs` captured when the candidate was judged. The delete
	 * refuses a path whose identity changed since then: the judgement saw a
	 * snapshot, and a rewritten file is a different object.
	 */
	signature?: string;
}

export interface ReclaimOutcome {
	reclaimed: number;
	bytes: number;
	skipped: RetentionSkip[];
	capped: boolean;
}

/** Identity of a path for the judgment/delete race check. */
export function statSignature(path: string): string | undefined {
	try {
		const stats = lstatSync(path);
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	}
}

function isTrashName(name: string): boolean {
	return name.startsWith(RETENTION_TRASH_PREFIX);
}

/** Name of the trash entry a path renames to; unique per attempt. */
function trashPathFor(path: string): string {
	return join(
		dirname(path),
		`${RETENTION_TRASH_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	);
}

/**
 * Reclaim judged candidates, spending from the shared per-sweep budget.
 * Every candidate ends up in exactly one of: reclaimed, skipped, or `cap-hit`.
 */
export async function reclaimWithinBudget(
	context: Pick<RetentionClassContext, "budget" | "dryRun">,
	requests: readonly ReclaimRequest[],
): Promise<ReclaimOutcome> {
	const skipped: RetentionSkip[] = [];
	let reclaimed = 0;
	let bytes = 0;
	let capped = false;
	for (const request of requests) {
		if (context.budget.remainingEntries <= 0 || context.budget.remainingBytes <= 0) {
			capped = true;
			context.budget.capped = true;
			skipped.push({ path: request.path, reason: SKIP.capHit, detail: "per-sweep cap reached" });
			continue;
		}
		if (request.bytes > context.budget.remainingBytes) {
			// Never overshoot the breaker: one candidate larger than what is left is left
			// alone, and the sweep stops deleting. A candidate larger than the whole
			// per-sweep budget therefore stays until an operator raises the cap - which is
			// the point of a breaker, and the report says `cap-hit` every sweep (the
			// stalled-class test then makes "the sweeper runs but never reclaims" visible
			// instead of silently overshooting by an unbounded factor).
			capped = true;
			context.budget.capped = true;
			skipped.push({
				path: request.path,
				reason: SKIP.capHit,
				detail: `candidate needs ${request.bytes} bytes, ${context.budget.remainingBytes} left this sweep`,
			});
			break;
		}
		if (request.signature !== undefined) {
			const current = statSignature(request.path);
			if (current === undefined) {
				skipped.push({ path: request.path, reason: SKIP.unverifiable("gone") });
				continue;
			}
			if (current !== request.signature) {
				skipped.push({ path: request.path, reason: SKIP.unverifiable("stat-changed") });
				continue;
			}
		}
		if (context.dryRun) {
			reclaimed += 1;
			bytes += Math.max(0, request.bytes);
			context.budget.remainingEntries = Math.max(0, context.budget.remainingEntries - 1);
			context.budget.remainingBytes = Math.max(0, context.budget.remainingBytes - Math.max(0, request.bytes));
			continue;
		}
		try {
			const trash = trashPathFor(request.path);
			renameSync(request.path, trash);
			rmSync(trash, { recursive: true, force: true });
			reclaimed += 1;
			bytes += Math.max(0, request.bytes);
			context.budget.remainingEntries = Math.max(0, context.budget.remainingEntries - 1);
			context.budget.remainingBytes = Math.max(0, context.budget.remainingBytes - Math.max(0, request.bytes));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unknown";
			skipped.push({
				path: request.path,
				reason: SKIP.failed(code),
				detail: String((error as Error).message ?? error),
			});
		}
	}
	return { reclaimed, bytes, skipped, capped };
}

/** True for the inert trash entries a crashed delete left behind. */
export function isRetentionTrashEntry(name: string): boolean {
	return isTrashName(name);
}
