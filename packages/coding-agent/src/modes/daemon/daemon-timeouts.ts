import type { DaemonCommand } from "./daemon-protocol.js";

/**
 * P1-7b: the timeout tiers, split apart.
 *
 * One 24h constant served three unrelated jobs — a user-explicit long command,
 * an agent-message delivery leg, and a startup adoption create — so a single
 * wedged leg could hold a mutation drain latch, an adoption, or a client
 * request for a day. Each tier is named for the thing it bounds, and the table
 * below says which command gets which tier.
 */
export const WORKER_REQUEST_TIMEOUT_TIERS = {
	/** A user-explicit long operation: prompt, refine, compaction, and the pure waits. */
	long: 24 * 60 * 60 * 1000,
	/**
	 * Startup and update-restart adoption of a registered worker. Must stay equal
	 * to the supervisor's own adoption budget (fix-plan appendix A: T3-3 and T4-2
	 * are the same number, and the reconnect budget below is derived from it).
	 */
	adoption: 300_000,
	/**
	 * One *retried* agent-message delivery attempt (T4-3). The first attempt keeps
	 * the long budget: the sender is waiting on it, a slow target hydration is
	 * legitimate work, and cutting it to 120s would trade a late delivery for an
	 * uncertain one (C20 kept the 24h delivery semantics on purpose).
	 */
	deliver: 120_000,
	/** A read answered from the worker's in-memory session state: fail fast and let the client retry on a hint. */
	read: 30_000,
} as const;

export type WorkerRequestTimeoutTier = keyof typeof WORKER_REQUEST_TIMEOUT_TIERS;

/**
 * The adoption create budget, exported so the client-side reconnect budget can be
 * derived from it instead of restating a number that must match (T3-3/T4-2).
 */
export const DAEMON_ADOPTION_REQUEST_TIMEOUT_MS = WORKER_REQUEST_TIMEOUT_TIERS.adoption;

/**
 * Commands on the read tier. Deliberately narrower than "every read-only
 * command": the pure waits (`wait_for_idle`, `wait_for_headless_completion`)
 * observe state until it settles and are long by design; `list`,
 * `list_saved_sessions` and the transcript reads (`get_messages`,
 * `get_session_context`, `get_user_messages_for_forking`, `get_last_assistant_text`)
 * scan the disk and grow with the session; `attach`/`reattach` carry a snapshot.
 * Cutting any of those to 30s would turn a slow-but-working call into a failure,
 * so they keep the long tier. A misassignment is observable: a worker request
 * that times out is logged with its command type and tier.
 */
const WORKER_READ_TIER_COMMANDS: ReadonlySet<DaemonCommand["type"]> = new Set([
	"get_state",
	"get_connection_state",
	"get_queue",
	"get_rlm_children",
	"get_session_stats",
	"get_session_header",
	"get_context_tree",
	"get_commands",
	"get_model_catalog",
	"get_available_models",
	"get_rlm_max_depth_status",
	"agent_messages_status",
]);

/** Commands whose own tier is neither the read nor the long default. */
const WORKER_REQUEST_TIMEOUT_BY_COMMAND: Readonly<Partial<Record<DaemonCommand["type"], WorkerRequestTimeoutTier>>> = {
	send_message: "deliver",
};

export function workerRequestTimeoutTier(commandType: DaemonCommand["type"]): WorkerRequestTimeoutTier {
	const explicit = WORKER_REQUEST_TIMEOUT_BY_COMMAND[commandType];
	if (explicit !== undefined) {
		return explicit;
	}
	return WORKER_READ_TIER_COMMANDS.has(commandType) ? "read" : "long";
}

/** The budget for one forwarded worker request, by command type. */
export function workerRequestTimeoutMs(commandType: DaemonCommand["type"]): number {
	return WORKER_REQUEST_TIMEOUT_TIERS[workerRequestTimeoutTier(commandType)];
}

/**
 * The TUI reconnect budget: long enough to outlive the recovery ladder it is
 * waiting for, i.e. the adoption create budget plus a margin, and never shorter
 * than the 60s it was before. Deriving it keeps the "240s" promise honest about
 * what it covers: a session still being adopted at 300s is answered by the
 * low-speed background retry, not by this budget (I-9).
 */
export function daemonReconnectBudgetMs(
	adoptionRequestTimeoutMs: number = DAEMON_ADOPTION_REQUEST_TIMEOUT_MS,
	recoveryMarginMs = 30_000,
	previousBudgetMs = 60_000,
): number {
	return Math.max(previousBudgetMs, adoptionRequestTimeoutMs + recoveryMarginMs);
}

/** Interval of the low-speed retry that keeps running after the reconnect budget is spent. */
export const DAEMON_BACKGROUND_RECONNECT_RETRY_MS = 30_000;
