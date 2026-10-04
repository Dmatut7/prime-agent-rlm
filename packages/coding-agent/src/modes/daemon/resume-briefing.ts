import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "../../core/agent-session.js";
import type { DutyLogSummary } from "../../core/duty-log.js";
import { formatDutyDuration, summarizeDutyLog } from "../../core/duty-log.js";
import type { GoalState } from "../../core/goals.js";
import {
	findUnconsumedWorkerRecoveryMarker,
	queuedInputsOfWorkerRecoveryMarker,
	type WorkerRecoveryResumeVerdict,
} from "./worker-recovery-resume.js";

/**
 * W14-B (C5, /tmp/wave10/model-cases.md): a session reopened after a restart
 * came back with its transcript but no first-class statement of what was in
 * flight, so the model ran its own checklist instead of resuming the
 * interrupted task. On every fresh bind of a persisted session the daemon
 * injects this briefing as next-turn context: active goal (+ persistent
 * flag), queued inputs, operations the previous worker died with, the
 * duty-log tail, the repo's org-memory doc index, and a pointer to the
 * continual harness stores with the read call into them. Delivery rides the
 * pending-next-turn queue, so it reaches the model on the first turn after
 * the reopen without starting a turn by itself, and is never persisted ahead
 * of a turn (no transcript pollution, no double injection on the next bind).
 */

export const RESUME_BRIEFING_CUSTOM_TYPE = "session_resume_briefing";

/** The repo's decision/errata ledger, named in the briefing when it is indexed. */
export const EVOLUTION_LEDGER_RELATIVE_PATH = "docs/fork/evolution-ledger.md";

/** How many org-memory docs the index lists, newest first. */
const ORG_DOCS_LIMIT = 5;

const OBJECTIVE_PREVIEW_CHARS = 160;

/**
 * What this reopen actually did with the queued input texts recovered from the
 * interruption marker. The automatic resume replays them only when its verdict
 * fires; a skipped resume (stale interruption, crash-resume loop) leaves them
 * in the marker, and the /resume-style replacement path never replays at all.
 * The briefing wording follows this value - recovery must not read as replay.
 */
export type QueuedInputsReplay =
	| { kind: "replayed" }
	| { kind: "skipped"; reason: "stale" | "resume-loop" }
	| { kind: "not-replayed" };

/** Maps the resume verdict the bind path acts on to the briefing's replay claim. */
export function queuedInputsReplayOfVerdict(verdict: WorkerRecoveryResumeVerdict): QueuedInputsReplay {
	if (verdict.kind === "resume") return { kind: "replayed" };
	if (verdict.reason === "no-marker") return { kind: "not-replayed" };
	return { kind: "skipped", reason: verdict.reason };
}

export interface ResumeBriefingInput {
	/** The rehydrated goal state; only non-idle, non-complete goals with an objective are reported. */
	goal?: GoalState | undefined;
	/** Queued (not yet delivered) inputs the rebuilt session still holds. */
	queuedCount: number;
	/**
	 * Queued input texts the previous worker never delivered, recovered from the
	 * interruption marker (details.queuedInputs), paired with what this reopen
	 * actually did with them. The rebuilt in-memory queue starts empty after a
	 * crash, so without these the briefing read "nothing pending" while the
	 * user's queued work was silently gone. The wording follows `replay`: the
	 * texts ride ahead of the automatic resume only when that resume fires.
	 */
	queuedInputs?: { texts: readonly string[]; replay: QueuedInputsReplay } | undefined;
	/** Operations the previous worker had in flight when it stopped (worker-recovery marker). */
	interruptedOperations: readonly string[];
	/** The duty-log summary over the transcript tail, when the session did anything. */
	duty?: DutyLogSummary | undefined;
	/** Org-memory docs (repo-relative paths), newest first. */
	orgDocs: readonly string[];
	now: number;
}

function preview(text: string, chars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

function goalLine(goal: GoalState): string | undefined {
	if (!goal.objective || goal.status === "idle" || goal.status === "complete") return undefined;
	const budget = goal.tokenBudget === undefined ? `${goal.tokensUsed}` : `${goal.tokensUsed}/${goal.tokenBudget}`;
	const persistent = goal.persistent ? " (persistent)" : "";
	return `- Goal: status: ${goal.status}${persistent} — "${preview(goal.objective, OBJECTIVE_PREVIEW_CHARS)}" — ${budget} tokens used, ${goal.continuationsUsed} continuations used.`;
}

function dutyLine(duty: DutyLogSummary, now: number): string {
	const parts = [
		`worked ${formatDutyDuration(duty.activeMs)} and finished ${duty.finishedTurns} turn(s) over the ${formatDutyDuration(duty.awayMs)} before the reopen`,
	];
	if (duty.lastDoing) parts.push(`last doing: "${duty.lastDoing}"`);
	if (duty.unfinished) parts.push(`possibly unfinished: "${duty.unfinished}"`);
	if (duty.pending.length > 0) {
		const first = duty.pending[0]!;
		const age = now - first.at < 60_000 ? "just now" : `${formatDutyDuration(now - first.at)} ago`;
		parts.push(`${duty.pending.length} decision(s) pending, first: "${first.question}" (${age})`);
	}
	const open = duty.incidents.filter(
		(incident) => incident.kind === "child_failed" || incident.handled < incident.count,
	);
	if (open.length > 0) parts.push(`${open.length} incident class(es) not yet resolved`);
	return `- Duty log tail: ${parts.join("; ")}.`;
}

function queuedInputsLine(texts: readonly string[], replay: QueuedInputsReplay): string {
	const previews = texts.map((text) => `"${preview(text, 120)}"`).join(", ");
	const recovered = `- ${texts.length} queued input message(s) from before the interruption were recovered from the worker-recovery marker`;
	if (replay.kind === "replayed") {
		return `${recovered} and replayed into the queue: ${previews}.`;
	}
	const reason =
		replay.kind === "not-replayed"
			? "the session was replaced in place (for example /resume), which does not replay queued inputs"
			: replay.reason === "stale"
				? "the automatic resume was skipped because the interruption is too old"
				: "the automatic resume was skipped after repeated crash-resume cycles";
	return `${recovered} but were not replayed - ${reason} - and are listed here so the work is not lost: ${previews}.`;
}

/**
 * The briefing text, or undefined when nothing was in flight (a resumed but
 * otherwise quiet session stays quiet). Pure: every fact is passed in.
 */
export function buildResumeBriefing(input: ResumeBriefingInput): string | undefined {
	const lines: string[] = [];
	if (input.goal) {
		const line = goalLine(input.goal);
		if (line) lines.push(line);
	}
	if (input.interruptedOperations.length > 0) {
		lines.push(
			`- Interrupted work: the previous worker stopped with these operations in flight: ${input.interruptedOperations.join(", ")}. They were not replayed; inspect external side effects before redoing them.`,
		);
	}
	if (input.queuedCount > 0) {
		lines.push(`- ${input.queuedCount} queued input message(s) wait from before the reopen.`);
	}
	const recoveredInputs = input.queuedInputs;
	if (recoveredInputs && recoveredInputs.texts.length > 0) {
		lines.push(queuedInputsLine(recoveredInputs.texts, recoveredInputs.replay));
	}
	if (input.duty) lines.push(dutyLine(input.duty, input.now));
	if (input.orgDocs.length > 0) {
		const ledgerClause = input.orgDocs.includes(EVOLUTION_LEDGER_RELATIVE_PATH)
			? ` Read ${EVOLUTION_LEDGER_RELATIVE_PATH} before initiating new lines of work.`
			: "";
		lines.push(`- Org memory (newest first): ${input.orgDocs.join(", ")}.${ledgerClause}`);
	}
	if (lines.length === 0) return undefined;
	return [
		"<session_resume_briefing>",
		"This session was reopened from its saved transcript (restart, resume, or switch) and its in-memory state was rebuilt. In-flight facts at reopen:",
		...lines,
		// The reopen is exactly when the model cannot tell what it knew; the
		// persistent stores are still on disk, and the read call into them is
		// named here so recall does not depend on remembering they exist.
		"- Your continual harness memories, skills, and notes survived the reopen; query them with `rlm.harness.search('terms', global_=True)` before answering \"did we ...\" questions or starting new lines of work.",
		"These are facts about where this session stood, not a new instruction. Prefer resuming the in-flight task over starting unrelated work unless the user's next message says otherwise.",
		"</session_resume_briefing>",
	].join("\n");
}

/** Operations an unconsumed worker-recovery marker carries, defensively parsed. */
function interruptedOperationsOf(marker: ReturnType<typeof findUnconsumedWorkerRecoveryMarker>): string[] {
	const details = marker?.details;
	if (!details || typeof details !== "object") return [];
	const operations = (details as Record<string, unknown>).operations;
	if (!Array.isArray(operations)) return [];
	return operations.filter((operation): operation is string => typeof operation === "string");
}

/** The newest org-memory docs under <cwd>/docs/fork, repo-relative, newest first. */
async function listOrgMemoryDocs(cwd: string): Promise<string[]> {
	const dir = join(cwd, "docs", "fork");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const docs: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		try {
			const stats = await stat(join(dir, name));
			if (!stats.isFile()) continue;
			docs.push({ path: `docs/fork/${name}`, mtimeMs: stats.mtimeMs });
		} catch {
			// A doc that vanished mid-scan is simply not indexed.
		}
	}
	return docs
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, ORG_DOCS_LIMIT)
		.map((doc) => doc.path);
}

/** The public surface of AgentSession the briefing reads and writes. */
export type ResumeBriefingSession = Pick<
	AgentSession,
	"goalState" | "getSessionActionSnapshot" | "sendCustomMessage" | "sessionManager"
>;

/**
 * Inject the resume briefing as next-turn context. Returns true when a
 * briefing landed. Skips sessions without any prior conversation (a fresh
 * file has nothing to forget) and sessions where nothing was in flight.
 * Callers: the daemon's fresh-bind paths (addRuntime, sessionReplaced).
 * `queuedInputsReplay` is what the caller actually does with the marker's
 * recovered queued inputs; the default is the honest one (no replay), so a
 * caller that replays must say so.
 */
export async function maybeInjectResumeBriefing(
	session: ResumeBriefingSession,
	options: { now?: number; queuedInputsReplay?: QueuedInputsReplay } = {},
): Promise<boolean> {
	const now = options.now ?? Date.now();
	const branch = session.sessionManager.getBranch();
	if (!branch.some((entry) => entry.type === "message")) return false;
	const recoveryMarker = findUnconsumedWorkerRecoveryMarker(branch);
	const recoveredQueuedInputs = queuedInputsOfWorkerRecoveryMarker(recoveryMarker);
	const briefing = buildResumeBriefing({
		goal: session.goalState,
		queuedCount: session.getSessionActionSnapshot().queuedCount,
		queuedInputs:
			recoveredQueuedInputs.length > 0
				? { texts: recoveredQueuedInputs, replay: options.queuedInputsReplay ?? { kind: "not-replayed" } }
				: undefined,
		interruptedOperations: interruptedOperationsOf(recoveryMarker),
		duty: summarizeDutyLog({ entries: branch, now }),
		orgDocs: await listOrgMemoryDocs(session.sessionManager.getCwd()),
		now,
	});
	if (!briefing) return false;
	await session.sendCustomMessage(
		{
			customType: RESUME_BRIEFING_CUSTOM_TYPE,
			content: briefing,
			display: false,
			details: {
				goalStatus: session.goalState.status,
				queuedCount: session.getSessionActionSnapshot().queuedCount,
			},
		},
		{ deliverAs: "nextTurn" },
	);
	return true;
}
