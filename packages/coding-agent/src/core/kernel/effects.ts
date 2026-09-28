import {
	ACTIVITY_DISPLAY_MIME,
	CHANGE_TRACKING_STATUS_DISPLAY_MIME,
	FILE_CHANGE_DISPLAY_MIME,
	isRecord,
	type KernelActivity,
	type KernelCellEffects,
	type KernelFileChange,
	type KernelMemoryChange,
	MEMORY_CHANGE_DISPLAY_MIME,
} from "./shared.js";

/**
 * A kernel record that withdraws an earlier one: a file that ended the cell as it started, or a
 * harness entry created and deleted within the same cell.
 */
export interface KernelEffectRetraction {
	retracted: true;
	key: string;
}

const FILE_KINDS = new Set<KernelFileChange["kind"]>(["created", "modified", "deleted", "renamed"]);
const FILE_SCOPES = new Set<KernelFileChange["scope"]>(["project", "scratch", "memory"]);
const FILE_SOURCES = new Set<KernelFileChange["source"]>(["python", "shell", "edit"]);
const DIFF_OMITTED = new Set<NonNullable<KernelFileChange["diffOmitted"]>>(["too_large", "no_baseline", "budget"]);
const MEMORY_OPS = new Set<KernelMemoryChange["op"]>(["created", "updated", "deleted"]);
const MEMORY_KINDS = new Set<KernelMemoryChange["kind"]>(["memory", "skill", "subagent", "prompt_note", "rules_file"]);
const MEMORY_SCOPES = new Set<KernelMemoryChange["scope"]>(["session", "global", "project"]);
const ACTIVITY_KINDS = new Set<KernelActivity["kind"]>(["command", "read", "search", "fetch", "subagent"]);
const ACTIVITY_STATUSES = new Set<KernelActivity["status"]>(["running", "ok", "error"]);
const COMMIT_ID = /^[0-9a-f]{7,40}$/;

function member<T extends string>(set: ReadonlySet<T>, value: unknown): value is T {
	return typeof value === "string" && set.has(value as T);
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function memoryKey(kind: string, scope: string, id: string): string {
	return `${kind}\u0000${scope}\u0000${id}`;
}

/** Parse a {@link FILE_CHANGE_DISPLAY_MIME} payload; malformed payloads are ignored (`undefined`). */
export function parseFileChangeDisplay(payload: unknown): KernelFileChange | KernelEffectRetraction | undefined {
	if (!isRecord(payload) || typeof payload.path !== "string" || payload.path.length === 0) return undefined;
	if (payload.retracted === true) return { retracted: true, key: payload.path };
	const added = count(payload.added);
	const removed = count(payload.removed);
	const at = count(payload.at);
	if (
		!member(FILE_KINDS, payload.kind) ||
		!member(FILE_SCOPES, payload.scope) ||
		!member(FILE_SOURCES, payload.source) ||
		added === undefined ||
		removed === undefined ||
		at === undefined
	) {
		return undefined;
	}
	const relPath = optionalString(payload.relPath);
	const oldPath = optionalString(payload.oldPath);
	const diff = optionalString(payload.diff);
	return {
		path: payload.path,
		...(relPath !== undefined ? { relPath } : {}),
		kind: payload.kind,
		...(oldPath !== undefined ? { oldPath } : {}),
		scope: payload.scope,
		added,
		removed,
		...(diff !== undefined ? { diff } : {}),
		...(payload.diffTruncated === true ? { diffTruncated: true } : {}),
		...(member(DIFF_OMITTED, payload.diffOmitted) ? { diffOmitted: payload.diffOmitted } : {}),
		...(payload.binary === true ? { binary: true } : {}),
		source: payload.source,
		at,
	};
}

/** Parse a {@link MEMORY_CHANGE_DISPLAY_MIME} payload; malformed payloads are ignored (`undefined`). */
export function parseMemoryChangeDisplay(payload: unknown): KernelMemoryChange | KernelEffectRetraction | undefined {
	if (!isRecord(payload) || !member(MEMORY_KINDS, payload.kind) || !member(MEMORY_SCOPES, payload.scope)) {
		return undefined;
	}
	const id = optionalString(payload.id);
	if (payload.retracted === true) {
		return id !== undefined ? { retracted: true, key: memoryKey(payload.kind, payload.scope, id) } : undefined;
	}
	const at = count(payload.at);
	if (!member(MEMORY_OPS, payload.op) || typeof payload.title !== "string" || at === undefined) return undefined;
	const previousTitle = optionalString(payload.previousTitle);
	const before = optionalString(payload.before);
	const after = optionalString(payload.after);
	return {
		op: payload.op,
		kind: payload.kind,
		scope: payload.scope,
		...(id !== undefined ? { id } : {}),
		title: payload.title,
		...(previousTitle !== undefined ? { previousTitle } : {}),
		...(before !== undefined ? { before } : {}),
		...(after !== undefined ? { after } : {}),
		at,
	};
}

/** Parse an {@link ACTIVITY_DISPLAY_MIME} payload; malformed payloads are ignored (`undefined`). */
export function parseActivityDisplay(payload: unknown): KernelActivity | undefined {
	if (
		!isRecord(payload) ||
		typeof payload.id !== "string" ||
		payload.id.length === 0 ||
		!member(ACTIVITY_KINDS, payload.kind) ||
		typeof payload.label !== "string" ||
		!member(ACTIVITY_STATUSES, payload.status)
	) {
		return undefined;
	}
	const startedAt = count(payload.startedAt);
	if (startedAt === undefined) return undefined;
	const detail = optionalString(payload.detail);
	const endedAt = count(payload.endedAt);
	const commit = typeof payload.commit === "string" && COMMIT_ID.test(payload.commit) ? payload.commit : undefined;
	return {
		id: payload.id,
		kind: payload.kind,
		label: payload.label,
		status: payload.status,
		...(detail !== undefined ? { detail } : {}),
		startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		...(payload.background === true ? { background: true } : {}),
		...(commit !== undefined ? { commit } : {}),
	};
}

/** The `incomplete` reason of a {@link CHANGE_TRACKING_STATUS_DISPLAY_MIME} payload, or undefined. */
export function parseChangeTrackingStatus(payload: unknown): string | undefined {
	return isRecord(payload) && typeof payload.incomplete === "string" && payload.incomplete.length > 0
		? payload.incomplete
		: undefined;
}

/**
 * Most steps one cell keeps. A cell looping over hundreds of `bash()` calls would otherwise grow the
 * list (and every result and live update carrying it) without bound; past the cap the oldest
 * finished steps go first and are counted in `activitiesDropped`.
 */
export const MAX_ACTIVITIES_PER_CELL = 100;

/** Dropped step ids remembered, so a late update of one is not re-added as a new step. */
const MAX_REMEMBERED_DROPPED_IDS = 4096;

/**
 * Collects one cell's change-tracking records from its display payloads. Every kernel record is
 * complete on its own, so the latest record per file path, memory entry and step id wins, and a
 * retraction removes its entry. Steps are capped at {@link MAX_ACTIVITIES_PER_CELL}. Display-only:
 * the result feeds the UI and nothing else.
 */
export class KernelEffectsAccumulator {
	private readonly files = new Map<string, KernelFileChange>();
	private readonly memory = new Map<string, KernelMemoryChange>();
	private readonly activities = new Map<string, KernelActivity>();
	private readonly droppedIds = new Set<string>();
	private dropped = 0;
	private incomplete: string | undefined;
	// Once a list has held something, an empty list is a fact (everything was retracted), not an
	// absence: it must reach the viewer explicitly, or the last non-empty list stays on screen.
	private filesReported = false;
	private memoryReported = false;

	constructor(private readonly maxActivities: number = MAX_ACTIVITIES_PER_CELL) {}

	/** Apply the tracking records in one display payload; true when anything changed. */
	apply(data: Record<string, unknown>): boolean {
		let changed = false;
		if (FILE_CHANGE_DISPLAY_MIME in data) {
			const record = parseFileChangeDisplay(data[FILE_CHANGE_DISPLAY_MIME]);
			if (record && "retracted" in record) {
				changed = this.files.delete(record.key) || changed;
			} else if (record) {
				this.files.set(record.path, record);
				this.filesReported = true;
				changed = true;
			}
		}
		if (MEMORY_CHANGE_DISPLAY_MIME in data) {
			const record = parseMemoryChangeDisplay(data[MEMORY_CHANGE_DISPLAY_MIME]);
			if (record && "retracted" in record) {
				changed = this.memory.delete(record.key) || changed;
			} else if (record) {
				this.memory.set(memoryKey(record.kind, record.scope, record.id ?? record.title), record);
				this.memoryReported = true;
				changed = true;
			}
		}
		if (ACTIVITY_DISPLAY_MIME in data) {
			const record = parseActivityDisplay(data[ACTIVITY_DISPLAY_MIME]);
			if (record && !this.droppedIds.has(record.id)) {
				if (!this.activities.has(record.id) && this.activities.size >= this.maxActivities) {
					this.dropOldestActivity();
				}
				this.activities.set(record.id, record);
				changed = true;
			}
		}
		if (CHANGE_TRACKING_STATUS_DISPLAY_MIME in data) {
			const reason = parseChangeTrackingStatus(data[CHANGE_TRACKING_STATUS_DISPLAY_MIME]);
			if (reason !== undefined && reason !== this.incomplete) {
				this.incomplete = reason;
				changed = true;
			}
		}
		return changed;
	}

	/** The oldest finished step, or the oldest step when every kept one is still running. */
	private dropOldestActivity(): void {
		let victim: string | undefined;
		for (const [id, activity] of this.activities) {
			if (activity.status !== "running") {
				victim = id;
				break;
			}
			victim ??= id;
		}
		if (victim === undefined) return;
		this.activities.delete(victim);
		this.dropped++;
		this.droppedIds.add(victim);
		if (this.droppedIds.size > MAX_REMEMBERED_DROPPED_IDS) {
			const oldest = this.droppedIds.values().next().value;
			if (oldest !== undefined) this.droppedIds.delete(oldest);
		}
	}

	/** Fresh arrays in observation order; safe to hand to a callback that keeps them. */
	snapshot(): KernelCellEffects {
		return {
			fileChanges: [...this.files.values()],
			memoryChanges: [...this.memory.values()],
			activities: [...this.activities.values()],
			...(this.dropped > 0 ? { activitiesDropped: this.dropped } : {}),
			...(this.incomplete !== undefined ? { changeTrackingIncomplete: this.incomplete } : {}),
		};
	}

	/**
	 * The ExecuteResult fields. A list is omitted only when it never held anything; one emptied by
	 * retractions is sent as `[]`.
	 */
	resultFields(): Partial<KernelCellEffects> {
		return {
			...(this.filesReported ? { fileChanges: [...this.files.values()] } : {}),
			...(this.memoryReported ? { memoryChanges: [...this.memory.values()] } : {}),
			...(this.activities.size > 0 ? { activities: [...this.activities.values()] } : {}),
			...(this.dropped > 0 ? { activitiesDropped: this.dropped } : {}),
			...(this.incomplete !== undefined ? { changeTrackingIncomplete: this.incomplete } : {}),
		};
	}
}
