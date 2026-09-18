import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { InputSource } from "./extensions/index.js";
import type { CustomMessage } from "./messages.js";
import type { SessionSlashCommand } from "./slash-commands.js";

export type DeliveryPolicy = "next_turn_boundary" | "when_run_idle";
export type WakePolicy = "immediate" | "on_lower_boundary" | "external_resume";

/**
 * Queue order inside a delivery lane: human input outranks agent-to-agent and other machine
 * traffic (upstream #2334, reconciled with the r39 QP-4 lane pin in `selectFirst`). The lane is
 * the first axis and this is the second one, so a human follow-up still never overtakes a
 * steering-lane reply; see the `selectFirst` comment for the full adjudication order.
 */
export type SessionActionPriority = "pinned" | "user" | "background";
export type SessionActionPlacement = "priority" | "tail" | "front";

const PRIORITY_RANK: Record<SessionActionPriority, number> = { pinned: 2, user: 1, background: 0 };

export type QueuedMessageLane = "steering" | "followUp";

export function queuedMessageLaneDeliveryPolicy(lane: QueuedMessageLane): DeliveryPolicy {
	return lane === "steering" ? "next_turn_boundary" : "when_run_idle";
}

export type QueuedMessageMutation =
	| { type: "delete" }
	| { type: "move"; direction: -1 | 1 }
	| { type: "replace"; text: string; images?: ImageContent[]; lane: QueuedMessageLane };
export type QueuedMessageMutationStatus = "applied" | "rejected" | "invalid";

export interface SessionActionSnapshot {
	queuedCount: number;
	steering: readonly string[];
	followUps: readonly string[];
	active?: {
		kind: "turn" | "session_command";
		phase: "preparing" | "committing" | "running";
		label?: string;
	};
}

export interface DeliveryRecord {
	id: string;
	role: "primary" | "prefix" | "next_turn";
	message: UserMessage | CustomMessage;
	started: boolean;
	durable: boolean;
	ownerActionId: string;
}

export interface SessionTurnPayload {
	kind: "turn";
	records: DeliveryRecord[];
	text: string;
	preview?: string;
}

export interface SessionCommandPayload {
	kind: "session_command";
	command: SessionSlashCommand;
	text: string;
}

export type SessionActionPayload = SessionTurnPayload | SessionCommandPayload;

export type ActionLifecycle =
	| { state: "queued" }
	| { state: "selected" }
	| { state: "preparing"; preparation?: object }
	| { state: "committing" }
	| { state: "running"; execution: "agent_turn" | "session_command" }
	| { state: "completed" }
	| { state: "failed"; error: Error }
	| { state: "cancelled" };

export interface SessionAction<TPayload extends SessionActionPayload = SessionActionPayload> {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	priority: SessionActionPriority;
	wake: WakePolicy;
	payload: TPayload;
	lifecycle: ActionLifecycle;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface RollbackProof {
	dispatchSettled: true;
	transcript: readonly AgentMessage[];
}

const TERMINAL_STATES = new Set<ActionLifecycle["state"]>(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = new Set<ActionLifecycle["state"]>(["selected", "preparing", "committing", "running"]);
const CLEARABLE_STATES = new Set<ActionLifecycle["state"]>(["queued", "selected", "preparing"]);

function isClearable(action: SessionAction): boolean {
	return CLEARABLE_STATES.has(action.lifecycle.state);
}

const LEGAL_TRANSITIONS: Readonly<Record<ActionLifecycle["state"], ReadonlySet<ActionLifecycle["state"]>>> = {
	queued: new Set(["selected", "failed", "cancelled"]),
	selected: new Set(["queued", "preparing", "running", "failed", "cancelled"]),
	preparing: new Set(["queued", "committing", "failed", "cancelled"]),
	committing: new Set(["queued", "running", "failed", "cancelled"]),
	running: new Set(["completed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

function primaryRecords(action: SessionAction): readonly DeliveryRecord[] {
	return action.payload.kind === "turn" ? action.payload.records.filter((record) => record.role === "primary") : [];
}

export function transitionSessionAction(
	action: SessionAction,
	next: ActionLifecycle,
	options: { rollbackProof?: RollbackProof } = {},
): void {
	const previous = action.lifecycle.state;
	if (!LEGAL_TRANSITIONS[previous].has(next.state)) {
		throw new Error(`Illegal session action lifecycle transition: ${previous} -> ${next.state}`);
	}
	if (previous === "committing" && next.state === "queued") {
		const proof = options.rollbackProof;
		if (!proof?.dispatchSettled) {
			throw new Error("Committing session action rollback requires a settled dispatch and transcript proof");
		}
		const transcript = new Set(proof.transcript);
		if (primaryRecords(action).some((record) => transcript.has(record.message))) {
			throw new Error("Cannot roll back a session action whose primary message is durable in the transcript");
		}
	}
	action.lifecycle = next;
}

export type AdmissionDisposition = "starts_when_admitted" | "queued";
export type SubmissionOutcome =
	| { status: "accepted"; actionId: string; disposition: AdmissionDisposition }
	| { status: "coalesced"; existingActionId: string }
	| { status: "handled_without_turn" }
	| { status: "extension_command"; completion: Promise<void> };
export type DeliveryOutcome = { status: "delivered" } | { status: "not_applicable" };

export interface ActionTicket {
	id: string;
	accepted: Promise<SubmissionOutcome>;
	delivered: Promise<DeliveryOutcome>;
	completed: Promise<void>;
}

interface Deferred<T> {
	promise: Promise<T>;
	settle(value: T): boolean;
	reject(error: Error): boolean;
}

function createDeferred<T>(): Deferred<T> {
	let settled = false;
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	return {
		promise,
		settle: (value) => {
			if (settled) return false;
			settled = true;
			resolvePromise(value);
			return true;
		},
		reject: (error) => {
			if (settled) return false;
			settled = true;
			rejectPromise(error);
			return true;
		},
	};
}

export class ActionTicketController {
	readonly ticket: ActionTicket;
	private readonly accepted = createDeferred<SubmissionOutcome>();
	private readonly delivered = createDeferred<DeliveryOutcome>();
	private readonly completed = createDeferred<void>();

	constructor(id: string) {
		this.ticket = {
			id,
			accepted: this.accepted.promise,
			delivered: this.delivered.promise,
			completed: this.completed.promise,
		};
	}

	settleAccepted(outcome: SubmissionOutcome): boolean {
		return this.accepted.settle(outcome);
	}

	settleDelivered(outcome: DeliveryOutcome): boolean {
		return this.delivered.settle(outcome);
	}

	rejectDelivered(error: Error): boolean {
		return this.delivered.reject(error);
	}

	settleCompleted(error?: Error): boolean {
		return error ? this.completed.reject(error) : this.completed.settle();
	}
}

export class ActionStore<TAction extends SessionAction = SessionAction> {
	private readonly nextTurnBoundary: TAction[] = [];
	private readonly whenRunIdle: TAction[] = [];
	private readonly tickets = new Map<string, ActionTicketController>();

	enqueue(action: TAction, placement: SessionActionPlacement = "priority"): void {
		this.assertNewAction(action);
		const list = this.list(action.delivery);
		list.splice(this.insertionIndex(list, action, placement), 0, action);
		this.tickets.set(action.id, new ActionTicketController(action.id));
	}

	/**
	 * Lane priority (r39 QP-4, single source of truth): the steering lane
	 * (`nextTurnBoundary`) always drains before the follow-up lane
	 * (`whenRunIdle`), even when a follow-up was queued earlier; arrival order
	 * is FIFO only within a lane. The lane an input joins is fixed by its
	 * source's delivery policy - subagent replies and heartbeat prompts
	 * default to steering, so they overtake earlier follow-ups by design.
	 * Admission refusals (pause leases, update-restart teardown, the same-key
	 * committing window) are raised before enqueueing in
	 * AgentSession._admitSessionInput and are retryable: they never delivered
	 * anything, so the sender retries instead of being told the outcome is
	 * unknown.
	 *
	 * Priority (upstream #2334, reconciled) is the second axis and lives in
	 * `insertionIndex`: inside one lane queued actions are ordered
	 * `pinned` > `user` > `background`, FIFO within a priority. It never crosses
	 * lanes, never reorders an action that already left the queue, and never
	 * undoes an explicit user move (`moveQueued`/`swapQueued`). Full adjudication
	 * order: selection gates (`canSelectSessionAction`) > admission gates
	 * (`_admitSessionInput`) > the compaction gate for agent traffic > lane >
	 * priority > arrival order.
	 */
	selectFirst(): TAction | undefined {
		const action =
			this.nextTurnBoundary.find((item) => item.lifecycle.state === "queued") ??
			this.whenRunIdle.find((item) => item.lifecycle.state === "queued");
		if (action) transitionSessionAction(action, { state: "selected" });
		return action;
	}

	remove(predicate: (action: TAction) => boolean, candidates = this.clearableActions()): TAction[] {
		const removed = candidates.filter(predicate);
		for (const action of removed) transitionSessionAction(action, { state: "cancelled" });
		return removed;
	}

	rollback(action: TAction, proof?: RollbackProof): void {
		transitionSessionAction(action, { state: "queued" }, { rollbackProof: proof });
	}

	swapQueued(left: TAction, right: TAction): void {
		if (left.lifecycle.state !== "queued" || right.lifecycle.state !== "queued" || left.delivery !== right.delivery) {
			throw new Error("Only queued actions in the same lane can be swapped");
		}
		const list = this.list(left.delivery);
		const leftIndex = list.indexOf(left);
		const rightIndex = list.indexOf(right);
		if (leftIndex < 0 || rightIndex < 0) throw new Error("Queued action is not owned by this store");
		[list[leftIndex], list[rightIndex]] = [right, left];
	}

	moveQueued(action: TAction, delivery: DeliveryPolicy, index: number): void {
		if (action.lifecycle.state !== "queued") throw new Error("Only queued actions can be moved");
		const source = this.list(action.delivery);
		const sourceIndex = source.indexOf(action);
		if (sourceIndex < 0) throw new Error(`Session action ${action.id} is not owned by this store`);
		source.splice(sourceIndex, 1);
		action.delivery = delivery;
		const target = this.list(delivery);
		const queued = target.filter((item) => item.lifecycle.state === "queued");
		const before = queued[Math.max(0, Math.min(index, queued.length))];
		target.splice(before ? target.indexOf(before) : target.length, 0, action);
	}

	queuedActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => action.lifecycle.state === "queued");
	}

	clearableActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter(isClearable);
	}

	snapshotActions(): readonly TAction[] {
		return this.queuedActions();
	}

	unfinishedActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => !TERMINAL_STATES.has(action.lifecycle.state));
	}

	activeActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => ACTIVE_STATES.has(action.lifecycle.state));
	}

	queuePreview(policy: DeliveryPolicy): readonly string[] {
		return this.queuedActions(policy).map((action) =>
			action.payload.kind === "turn" ? (action.payload.preview ?? action.payload.text) : action.payload.text,
		);
	}

	ticketFor(action: TAction): ActionTicketController {
		const ticket = this.tickets.get(action.id);
		if (!ticket) throw new Error(`Session action ${action.id} is not owned by this store`);
		return ticket;
	}

	ownedActions(): readonly TAction[] {
		return this.actions();
	}

	actionsForMessage(message: UserMessage | CustomMessage): readonly TAction[] {
		return this.actions().filter(
			(action) =>
				action.payload.kind === "turn" && action.payload.records.some((record) => record.message === message),
		);
	}

	releaseTerminal(action: TAction): void {
		if (!TERMINAL_STATES.has(action.lifecycle.state)) {
			throw new Error(`Cannot release nonterminal session action ${action.id}`);
		}
		const list = this.list(action.delivery);
		const index = list.indexOf(action);
		if (index >= 0) list.splice(index, 1);
		this.tickets.delete(action.id);
	}

	/**
	 * Queued actions are ordered by priority and stay FIFO within a priority. Actions that are
	 * no longer queued are already committed to this turn, so nothing is inserted ahead of them.
	 * "tail" replays a persisted queue verbatim (restart / parked-queue restore) and "front" keeps
	 * the goal-context insertion point it always had.
	 */
	private insertionIndex(list: readonly TAction[], action: TAction, placement: SessionActionPlacement): number {
		if (placement === "tail") return list.length;
		if (placement === "front") {
			const firstQueued = list.findIndex((item) => item.lifecycle.state === "queued");
			return firstQueued < 0 ? list.length : firstQueued;
		}
		const rank = PRIORITY_RANK[action.priority];
		let index = list.length;
		for (let position = list.length - 1; position >= 0; position--) {
			const item = list[position];
			if (!item || item.lifecycle.state !== "queued" || PRIORITY_RANK[item.priority] >= rank) break;
			index = position;
		}
		return index;
	}

	private actions(policy?: DeliveryPolicy): readonly TAction[] {
		if (policy) return this.list(policy);
		return [...this.nextTurnBoundary, ...this.whenRunIdle];
	}

	private list(policy: DeliveryPolicy): TAction[] {
		return policy === "next_turn_boundary" ? this.nextTurnBoundary : this.whenRunIdle;
	}

	private assertNewAction(action: TAction): void {
		if (action.lifecycle.state !== "queued") throw new Error("Only queued session actions can be enqueued");
		if (this.tickets.has(action.id)) throw new Error(`Duplicate session action id: ${action.id}`);
	}
}

export interface RuntimeActivity {
	lowerAgentRun: boolean;
	compaction: boolean;
	retry: boolean;
	bash: boolean;
	refinementApply: boolean;
	branchMutation: boolean;
	schedulerPauseCount: number;
	disposing: boolean;
}

export type IdleEvictionMinutes = number | "off";

export interface SessionEvictionSnapshot {
	isSessionActive: boolean;
	attachedClients: number;
	hasRegisteredCronJob: boolean;
	lastActivityAt: number;
	/**
	 * Kernel-owned work this session is hosting: a cell executing right now, or a live `bash()`
	 * handle its Python kernel owns (r44 form A).
	 *
	 * Its own term rather than a reuse of `isSessionActive` because of a sampling blind spot:
	 * `isSessionActive`'s bash component (`AgentSession.isBashRunning`) counts only the host-side
	 * bash tool's controllers (`_bashAbortControllers`). A handle started by `bash()` *inside the
	 * kernel* never enters that set, so a session whose turn ended with a background script running
	 * reports turn-idle forever while the kernel still owns live process groups - and evicting it
	 * closes the session, which closes the kernel, whose shutdown SIGTERMs every one of those
	 * groups. The transcript survives and the session rehydrates, so nothing ever reports the kill.
	 *
	 * Semantics: live kernel work means "not idle", never "idle later". `idleEvictionMinutes` is
	 * untouched, and a session whose kernel holds no handle and executes no cell evicts exactly as
	 * it did before this term existed.
	 *
	 * Optional, and absent means "no fact": a snapshot built by a side that cannot observe the
	 * kernel (an older worker's summary, a stub row, a session with no kernel) leaves it undefined
	 * and the policy degrades to the behaviour it had before. Never inferred from a missing fact.
	 *
	 * Two carriers feed the shared threshold below, one per layer, and they are NOT equally load
	 * bearing - the difference is measured, not assumed:
	 *
	 * - The supervisor, which has no kernel to observe, receives the fact inside the
	 *   `isSessionActive` its worker folded from `AgentSession.isKernelWorkInFlight`
	 *   (daemon-session-list.ts summaryForActiveSession). That fold is the load-bearing carrier for
	 *   whole-worker eviction and for empty-session reclamation; deleting it reddens
	 *   test/suite/live-kernel-work-residency.test.ts.
	 * - The worker also sets this term on its own passivation snapshot
	 *   (daemon-mode.ts sessionPassivationSnapshot). On that layer it is defence in depth, not the
	 *   only wall: the same snapshot's `isSessionActive` already carries the fold, so deleting this
	 *   term alone does NOT reopen r44 form A there - which is why its lock is the policy-level test
	 *   in test/session-action-store.test.ts (both policies read `isIdleEvictionThresholdMet`) plus
	 *   the residency attribution log, and not a daemon-mode integration case. What the term buys is
	 *   that passivation stops depending on a fold owned by another module.
	 */
	hasLiveKernelWork?: boolean;
	/**
	 * `isSessionActive` with the kernel-work fold taken back out. Attribution only: it is never a
	 * policy input, and `isIdleEvictionThresholdMet` must not read it.
	 *
	 * It exists because the worker folds `AgentSession.isKernelWorkInFlight` into the
	 * `isSessionActive` it reports (daemon-session-list.ts summaryForActiveSession), so a snapshot's
	 * `isSessionActive` is already true whenever kernel work is live. Clearing `hasLiveKernelWork`
	 * alone therefore cannot answer "would this session have been reclaimed if not for the kernel
	 * fact", which is the only question the residency attribution log is allowed to answer. Optional:
	 * a snapshot that does not carry it falls back to `isSessionActive`, i.e. to not attributing.
	 */
	isSessionActiveIgnoringKernelWork?: boolean;
}

export interface SessionPassivationSnapshot extends SessionEvictionSnapshot {
	hasParent: boolean;
	hasNonPassiveDescendants: boolean;
	isHydrating: boolean;
}

export interface WorkerEvictionSnapshot {
	lifecycle: "starting" | "ready" | "recovering" | "stopping" | "failed";
	isConnected: boolean;
	isStopping: boolean;
	hasOwnerClient: boolean;
	isPreparingUpdateRestart: boolean;
	hasWakeBlindSchedule: boolean;
	sessions: readonly SessionEvictionSnapshot[];
}

function isIdleEvictionThresholdMet(
	session: SessionEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now: number,
): boolean {
	if (idleEvictionMinutes === "off" || !Number.isFinite(idleEvictionMinutes) || idleEvictionMinutes <= 0) {
		return false;
	}
	return (
		!session.isSessionActive &&
		// Kernel-hosted work is residency evidence of its own: both this per-session policy and
		// the whole-worker one below close the session's kernel, and the kernel takes every live
		// bash() process group with it. See SessionEvictionSnapshot.hasLiveKernelWork.
		session.hasLiveKernelWork !== true &&
		session.attachedClients === 0 &&
		!session.hasRegisteredCronJob &&
		Number.isFinite(session.lastActivityAt) &&
		now - session.lastActivityAt >= idleEvictionMinutes * 60_000
	);
}

/**
 * Clamp a foreign clock's reading against this side's monotonic elapsed time.
 *
 * Idle-eviction compares worker-recorded wall timestamps against a supervisor-supplied
 * `now`; the two clocks can disagree by an NTP step or a manual correction. A forward step
 * inflates the idle delta and evicts a session that is not idle yet, so each borrowed
 * reading is bounded by the projection of the previous one across the monotonic time this
 * side measured in between. A backward step only delays eviction, which is the safe
 * direction, and passes through unchanged.
 */
export function clampForeignClockNow(
	now: number,
	previous: { wall: number; mono: number } | undefined,
	monoNow: number,
): number {
	if (previous === undefined) return now;
	const projected = previous.wall + (monoNow - previous.mono);
	return Math.min(now, projected);
}

/** Pure per-node residency policy. Roots remain owned by whole-worker eviction. */
export function canPassivateSession(
	session: SessionPassivationSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	return (
		session.hasParent &&
		!session.hasNonPassiveDescendants &&
		!session.isHydrating &&
		isIdleEvictionThresholdMet(session, idleEvictionMinutes, now)
	);
}

/**
 * Pure whole-tree residency policy. Callers must supply supervisor-owned attachment state.
 *
 * Every session must clear the shared idle threshold, so one session hosting live kernel work
 * pins the whole worker: `stopWorker` would close that session's kernel and SIGTERM the bash()
 * process groups it owns, which is the same kill the per-session policy above exists to prevent.
 */
export function canEvictWorker(
	worker: WorkerEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	if (
		worker.lifecycle !== "ready" ||
		!worker.isConnected ||
		worker.isStopping ||
		worker.hasOwnerClient ||
		worker.isPreparingUpdateRestart ||
		worker.hasWakeBlindSchedule ||
		worker.sessions.length === 0
	) {
		return false;
	}
	return worker.sessions.every((session) => isIdleEvictionThresholdMet(session, idleEvictionMinutes, now));
}

export function canSelectSessionAction(activity: RuntimeActivity): boolean {
	return (
		!activity.lowerAgentRun &&
		!activity.compaction &&
		!activity.retry &&
		!activity.bash &&
		!activity.refinementApply &&
		!activity.branchMutation &&
		activity.schedulerPauseCount === 0 &&
		!activity.disposing
	);
}
