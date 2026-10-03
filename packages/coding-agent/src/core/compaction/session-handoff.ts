/**
 * Structured session handoff for compaction summaries.
 *
 * The measured failure this closes (/tmp/wave16/memory-failures.md, case 3b/3a):
 * 103 of 109 production compaction summaries carried empty file lists, and a
 * compaction ate the record of which subagents were still in flight - the model
 * "forgot what it had changed and who it was waiting on" one boundary later.
 * The summarizer cannot be asked to recall these: its input is a slice that may
 * predate the events, and its output is prose nobody verifies.
 *
 * So the handoff is assembled by program from the session timeline itself:
 * the kernel's per-cell activity records on ipython tool results (subagent
 * admissions, background commands) and the parent-facing child lifecycle notices
 * (failure and terminal). The ledger is carried forward structurally in the
 * compaction entry's details (the rendered block is the fallback, same contract
 * as the fact appendix), so a child admitted three compactions ago is still
 * named after the cell that spawned it has been summarized away.
 *
 * Only model-actionable work is listed. The duty log's decision_needed entries
 * are not here: they are defined as work that needs the owner, their questions
 * are written second-person to the owner (where the model would read "你" as
 * itself), and nothing retires them - the owner-facing duty log remains their
 * surface.
 *
 * Listing is conservative on purpose: a record is removed only by a terminal
 * record later in the branch (failure, cancellation, or completion notice), so
 * the block may name work that has since finished *quietly* - never the reverse.
 * The header tells the reader that rlm.list_subagents(include_terminal=True) is
 * the ground truth.
 */

import { RLM_CHILD_FAILURE_CUSTOM_TYPE, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../messages.js";
import type { SessionEntry } from "../session-manager.js";
import { checkMachineBlockSelfCount, findMachineBlock, renderMachineBlock } from "./machine-blocks.js";

/** A child admitted by this session with no terminal record later in the branch. */
export interface HandoffSubagent {
	/** Child session name once admission completed; the task's first words while it has not. */
	name: string;
	/** Epoch ms the spawn step started, when the kernel reported it. */
	since?: number;
	/** Model the admission reply named. */
	model?: string;
	/** True while the spawn call itself had not returned: admission in progress, child name not yet known. */
	admitting?: boolean;
}

/** A bash() command the kernel still had running (background handle) at scan time. */
export interface HandoffBackgroundCommand {
	/** Kernel activity id; the outcome record arrives under the same id in a later cell. */
	id: string;
	/** The command line. */
	label: string;
	since?: number;
}

export interface HandoffLedger {
	/** Compaction generation this ledger was rebuilt in; 1 for the first compaction. */
	generation: number;
	subagents: HandoffSubagent[];
	backgroundCommands: HandoffBackgroundCommand[];
	/** Records dropped by the caps, per list. */
	elided: { subagents?: number; backgroundCommands?: number };
}

export function emptyHandoffLedger(generation: number): HandoffLedger {
	return { generation, subagents: [], backgroundCommands: [], elided: {} };
}

/** Bounds per list; the block discloses what they cut. */
export const HANDOFF_MAX_SUBAGENTS = 50;
export const HANDOFF_MAX_BACKGROUND = 20;

/** A spawn step's label is the whole task brief until admission; keep the record short. */
export const HANDOFF_LABEL_MAX_CHARS = 200;

function clip(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

interface ActivityRecord {
	id: string;
	kind: string;
	label: string;
	status: "running" | "ok" | "error";
	detail?: string;
	startedAt?: number;
	background?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActivity(value: unknown): ActivityRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	if (typeof value.kind !== "string" || typeof value.label !== "string") return undefined;
	if (value.status !== "running" && value.status !== "ok" && value.status !== "error") return undefined;
	return {
		id: value.id,
		kind: value.kind,
		label: value.label,
		status: value.status,
		detail: typeof value.detail === "string" ? value.detail : undefined,
		startedAt: typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : undefined,
		background: value.background === true ? true : undefined,
	};
}

/** The sessionName a child lifecycle notice resolves against, when it carries one. */
function noticeSessionName(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	return typeof details.sessionName === "string" && details.sessionName.length > 0 ? details.sessionName : undefined;
}

interface HandoffScan {
	/** In-flight children by their current name (admission re-keys the prompt label to it). */
	subagents: Map<string, HandoffSubagent>;
	/** Activity id -> the key its record currently sits under, so a finish can re-key or drop it. */
	subagentKeys: Map<string, string>;
	/** Live background commands by kernel activity id. */
	background: Map<string, HandoffBackgroundCommand>;
}

function seedScan(previous: HandoffLedger | undefined): HandoffScan {
	const scan: HandoffScan = {
		subagents: new Map(),
		subagentKeys: new Map(),
		background: new Map(),
	};
	for (const subagent of previous?.subagents ?? []) scan.subagents.set(subagent.name, { ...subagent });
	for (const command of previous?.backgroundCommands ?? []) scan.background.set(command.id, { ...command });
	return scan;
}

function applySubagentActivity(scan: HandoffScan, activity: ActivityRecord): void {
	const previousKey = scan.subagentKeys.get(activity.id);
	if (activity.status === "error") {
		// The spawn call failed; the child never existed.
		if (previousKey !== undefined) scan.subagents.delete(previousKey);
		scan.subagentKeys.delete(activity.id);
		return;
	}
	const name = clip(activity.label, HANDOFF_LABEL_MAX_CHARS);
	if (name.length === 0) return;
	// Admission completion renames the step from the task brief to the child name.
	if (previousKey !== undefined && previousKey !== name) scan.subagents.delete(previousKey);
	scan.subagents.set(name, {
		name,
		...(activity.startedAt !== undefined ? { since: activity.startedAt } : {}),
		...(activity.status === "ok" && activity.detail ? { model: activity.detail } : {}),
		...(activity.status === "running" ? { admitting: true as const } : {}),
	});
	scan.subagentKeys.set(activity.id, name);
}

function applyBackgroundActivity(scan: HandoffScan, activity: ActivityRecord): void {
	if (activity.status === "running") {
		scan.background.set(activity.id, {
			id: activity.id,
			label: clip(activity.label, HANDOFF_LABEL_MAX_CHARS),
			...(activity.startedAt !== undefined ? { since: activity.startedAt } : {}),
		});
		return;
	}
	// The kernel re-reports a background command's outcome under the same id in
	// whichever cell runs next; that record is the resolution.
	scan.background.delete(activity.id);
}

function applyEntry(scan: HandoffScan, entry: SessionEntry): void {
	if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ipython") {
		const details = isRecord(entry.message.details) ? entry.message.details : {};
		const activities = Array.isArray(details.activities) ? details.activities : [];
		for (const raw of activities) {
			const activity = parseActivity(raw);
			if (!activity) continue;
			if (activity.kind === "subagent") applySubagentActivity(scan, activity);
			else if (activity.kind === "command" && activity.background === true) applyBackgroundActivity(scan, activity);
		}
		return;
	}
	if (entry.type === "custom_message") {
		// A terminal record ends the listing. A failure is unconditional; a terminal
		// notice ("cancelled" or "completed_without_reply") means the run is over and
		// no reply will arrive from it - a completed child's session survives for a
		// follow-up, but that is availability, not work in flight, and the header
		// already names rlm.list_subagents as the ground truth for it.
		if (
			entry.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			entry.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
		) {
			const name = noticeSessionName(entry.details);
			if (name !== undefined) scan.subagents.delete(name);
		}
		return;
	}
}

function capList<T>(items: T[], max: number): { kept: T[]; elided: number } {
	if (items.length <= max) return { kept: items, elided: 0 };
	// The newest records are the ones most likely still live; the cut is disclosed.
	return { kept: items.slice(items.length - max), elided: items.length - max };
}

/**
 * Assemble the handoff ledger for one compaction.
 *
 * Scans the whole branch (root to leaf), seeded with the previous compaction's
 * ledger: in-flight is a statement about compaction time, so evidence anywhere
 * in the branch counts - a spawn in the retained tail belongs here exactly like
 * one in the summarized slice, and a death notice in either resolves it.
 * Deterministic and side-effect free; it can be replayed over a stored branch.
 */
export function buildSessionHandoff(
	entries: readonly SessionEntry[],
	options: { generation: number; previous?: HandoffLedger },
): HandoffLedger {
	const scan = seedScan(options.previous);
	for (const entry of entries) applyEntry(scan, entry);
	const subagents = capList([...scan.subagents.values()], HANDOFF_MAX_SUBAGENTS);
	const background = capList([...scan.background.values()], HANDOFF_MAX_BACKGROUND);
	const elided: HandoffLedger["elided"] = {};
	if (subagents.elided > 0) elided.subagents = subagents.elided;
	if (background.elided > 0) elided.backgroundCommands = background.elided;
	return {
		generation: options.generation,
		subagents: subagents.kept,
		backgroundCommands: background.kept,
		elided,
	};
}

/* -------------------------------------------------------------------------- */
/* Rendering and parsing                                                       */
/* -------------------------------------------------------------------------- */

const HANDOFF_HEADER =
	"Machine-assembled from the session timeline at compaction time, no model involved: work still in flight when this summary was written. k=subagent: a child this session admitted, with no terminal record (failure, cancellation or completion notice) later in this transcript (it may still have finished quietly or been deleted - rlm.list_subagents(include_terminal=True) is the ground truth; admitting=true means the spawn call itself had not returned). k=background: a bash() command the kernel still had running. Refer to entries by their exact name/id; do not restate them as fact without checking.";

type WireHandoff =
	| { k: "subagent"; n: string; s?: number; m?: string; a?: 1 }
	| { k: "background"; id: string; l: string; s?: number }
	// Legacy parse target only: blocks written before the decisions channel was
	// removed still carry these lines. They count toward the block's self-count
	// (the writer included them) but are never surfaced again.
	| { k: "decision"; q: string };

function renderHandoffLine(record: WireHandoff): string {
	// Same escape as the fact appendix: a payload quoting a block delimiter must not
	// be able to end the block early, and JSON.parse restores it byte-exact.
	return JSON.stringify(record).replace(/</g, "\\u003c");
}

function renderHandoffBody(ledger: HandoffLedger): string {
	const lines: string[] = [HANDOFF_HEADER];
	for (const subagent of ledger.subagents) {
		const wire: WireHandoff = { k: "subagent", n: subagent.name };
		if (subagent.since !== undefined) wire.s = subagent.since;
		if (subagent.model !== undefined) wire.m = subagent.model;
		if (subagent.admitting === true) wire.a = 1;
		lines.push(renderHandoffLine(wire));
	}
	for (const command of ledger.backgroundCommands) {
		const wire: WireHandoff = { k: "background", id: command.id, l: command.label };
		if (command.since !== undefined) wire.s = command.since;
		lines.push(renderHandoffLine(wire));
	}
	return lines.join("\n");
}

/** Render the handoff block for a summary; an empty ledger renders nothing. */
export function renderSessionHandoff(ledger: HandoffLedger): string {
	const count = ledger.subagents.length + ledger.backgroundCommands.length;
	if (count === 0) return "";
	const attributes: Record<string, string | number> = { generation: ledger.generation, count };
	const elidedTotal = (ledger.elided.subagents ?? 0) + (ledger.elided.backgroundCommands ?? 0);
	if (elidedTotal > 0) {
		attributes.elided = elidedTotal;
		attributes.elidedDetail = (
			[
				["subagent", ledger.elided.subagents],
				["background", ledger.elided.backgroundCommands],
			] as const
		)
			.filter(([, n]) => (n ?? 0) > 0)
			.map(([kind, n]) => `${kind}:${n}`)
			.join(",");
	}
	return renderMachineBlock("session-handoff", attributes, renderHandoffBody(ledger));
}

function parseWireLine(line: string): WireHandoff | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let wire: WireHandoff;
	try {
		wire = JSON.parse(trimmed) as WireHandoff;
	} catch {
		return undefined;
	}
	if (!isRecord(wire) || typeof wire.k !== "string") return undefined;
	return wire;
}

function wireNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Recover a ledger from a rendered handoff block.
 *
 * Session entry details are the primary carry-forward; this is the fallback for
 * entries whose details were dropped or written before the block existed.
 * Malformed lines are skipped rather than thrown on.
 */
export function parseSessionHandoff(text: string): HandoffLedger | undefined {
	const block = findMachineBlock(text, "session-handoff");
	if (!block) return undefined;
	const generation = Number.parseInt(block.attributes.generation ?? "1", 10);
	const ledger = emptyHandoffLedger(Number.isFinite(generation) && generation > 0 ? generation : 1);
	let records = 0;
	for (const line of block.body.split("\n")) {
		const wire = parseWireLine(line);
		if (!wire) continue;
		if (wire.k === "subagent" && typeof wire.n === "string" && wire.n.length > 0) {
			const subagent: HandoffSubagent = { name: wire.n };
			const since = wireNumber(wire.s);
			if (since !== undefined) subagent.since = since;
			if (typeof wire.m === "string" && wire.m.length > 0) subagent.model = wire.m;
			if (wire.a === 1) subagent.admitting = true;
			ledger.subagents.push(subagent);
			records++;
		} else if (wire.k === "background" && typeof wire.id === "string" && typeof wire.l === "string") {
			const command: HandoffBackgroundCommand = { id: wire.id, label: wire.l };
			const since = wireNumber(wire.s);
			if (since !== undefined) command.since = since;
			ledger.backgroundCommands.push(command);
			records++;
		} else if (wire.k === "decision") {
			// Legacy line from before the decisions channel was removed: counted, so the
			// block's self-count check still measures damage, but never read back.
			records++;
		}
	}
	for (const entry of (block.attributes.elidedDetail ?? "").split(",")) {
		const separator = entry.indexOf(":");
		if (separator <= 0) continue;
		const n = Number.parseInt(entry.slice(separator + 1), 10);
		if (!Number.isFinite(n) || n <= 0) continue;
		const kind = entry.slice(0, separator);
		if (kind === "subagent") ledger.elided.subagents = n;
		else if (kind === "background") ledger.elided.backgroundCommands = n;
	}
	checkMachineBlockSelfCount(block, "count", records);
	return ledger;
}

/** Recover a ledger from a compaction entry's details, when it carries one. */
export function sessionHandoffFromDetails(details: unknown): HandoffLedger | undefined {
	if (!isRecord(details)) return undefined;
	const candidate = details.handoff;
	if (!isRecord(candidate)) return undefined;
	const generation = wireNumber(candidate.generation);
	const ledger = emptyHandoffLedger(generation !== undefined && generation > 0 ? generation : 1);
	// A legacy details payload also carries pendingDecisions; the decisions channel
	// was removed (owner-directed, never retired), so the key is ignored, not read.
	if (!Array.isArray(candidate.subagents) || !Array.isArray(candidate.backgroundCommands)) {
		return undefined;
	}
	for (const raw of candidate.subagents) {
		if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) continue;
		const subagent: HandoffSubagent = { name: raw.name };
		const since = wireNumber(raw.since);
		if (since !== undefined) subagent.since = since;
		if (typeof raw.model === "string" && raw.model.length > 0) subagent.model = raw.model;
		if (raw.admitting === true) subagent.admitting = true;
		ledger.subagents.push(subagent);
	}
	for (const raw of candidate.backgroundCommands) {
		if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string") continue;
		const command: HandoffBackgroundCommand = { id: raw.id, label: raw.label };
		const since = wireNumber(raw.since);
		if (since !== undefined) command.since = since;
		ledger.backgroundCommands.push(command);
	}
	const elided = candidate.elided;
	if (isRecord(elided)) {
		for (const key of ["subagents", "backgroundCommands"] as const) {
			const n = wireNumber(elided[key]);
			if (n !== undefined && n > 0) ledger.elided[key] = n;
		}
	}
	return ledger;
}
