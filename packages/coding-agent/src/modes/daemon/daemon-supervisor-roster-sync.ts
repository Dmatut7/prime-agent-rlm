/**
 * Roster-sync cluster extracted from daemon-supervisor.ts (wave-51, the third
 * Host-seam cut on the supervisor after the wave-48 warm pool and the wave-50
 * adoption cluster): the agent roster pipeline (lazy store, mutation → push
 * fan-out to subscribed clients), spawn-ledger seeding, the worker roster_delta
 * frame apply chain (snapshot/delta apply, repair pulls, connection-current
 * guards), the staleness watchdog, and the roster_subscribe /
 * roster_unsubscribe command handlers. The moved methods keep exactly the same
 * bodies; they read the supervisor through
 * {@link DaemonSupervisorRosterSyncHost}, so the move changes no runtime
 * behavior. The nineteen entry points with callers outside the cluster keep
 * one-line shells on the class so instance-level dispatch — including
 * prototype-harness stubs that shadow those names — is preserved exactly.
 * Cluster-internal helpers (onRosterMutation / scheduleRosterPush /
 * flushRosterUpdates / isRosterEntryVisibleToClients / rosterFamilyDescendsFrom
 * / isWorkerRosterEntry / isWorkerRosterApplyCurrent / scheduleRosterRepairPull
 * / applyWorkerRosterDelta / syncRootDescriptorFromRosterEntry) are
 * module-private and called directly. `rosterEntryForSpawnLedgerEdge` is
 * exported as a pure helper: handleList's dead-family rows also build from it.
 *
 * Two adaptations beyond the warm-pool/adoption pattern:
 *
 * 1. The roster store itself stays on the class (`rosterStore`): prototype
 *    harnesses inject a populated store under that own-property name, so the
 *    class keeps the field and fills it lazily in `ensureRosterStore`, which
 *    honors an injected store. Only the push bookkeeping (pending
 *    changed/removed, published ids, push-scheduled flag) and the staleness
 *    watchdog timer moved into {@link DaemonRosterSyncState}, a lazily-created
 *    seat so prototype harnesses that bypass the constructor read empty buffers
 *    instead of throwing.
 * 2. `handleWorkerRosterDeltaFrame` routes back through the host's
 *    `consumeWorkerRosterDelta` member — an arrow dispatching to the class
 *    shell — so an own-property stub of that name keeps intercepting; every
 *    other intra-cluster call is module-direct.
 *
 * Like the adoption module, this one carries a value-level import back into
 * ./daemon-supervisor.js (isSessionSummary); the binding is only touched inside
 * a function body, so the module-evaluation cycle is inert. Everything else
 * from the supervisor is imported as types only.
 */

import { basename, dirname } from "node:path";
import { canonicalSessionPath } from "../../core/session-lease.js";
import type { PrivateFrame } from "../session-worker/private-framing.js";
import type { DaemonSocketClient } from "./active-session-state.js";
import {
	type AgentRoster,
	type AgentRosterEntry,
	type AgentRosterMutation,
	passivatedWorkerRosterEntry,
	rosterAgentIdForSummary,
	sessionSummaryFromRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "./agent-roster.js";
import { type DaemonCommand, type DaemonResponse, success } from "./daemon-protocol.js";
import type { SessionSummary } from "./daemon-session-list.js";
import { type DaemonSupervisor, isSessionSummary, type ResidentWorker } from "./daemon-supervisor.js";
import type { DaemonWorkerClient } from "./daemon-worker-client.js";
import {
	type DaemonWorkerFrameHeader,
	type DaemonWorkerRosterOutbound,
	durableDaemonCreateCommand,
	ROSTER_HEARTBEAT_INTERVAL_MS,
} from "./daemon-worker-protocol.js";
import type { RlmLedgerEdge } from "./rlm-ledger.js";

const ROSTER_STALE_AFTER_MS = 3 * ROSTER_HEARTBEAT_INTERVAL_MS;

/**
 * The roster push bookkeeping and watchdog timer, moved out of the supervisor
 * with the cluster. The class holds one lazily-created instance: prototype-
 * harness supervisors in tests bypass the constructor, and every reader must
 * see empty buffers there instead of throwing. The store itself is not here —
 * it stays on the class as `rosterStore` because harnesses inject a populated
 * store under that name (see the module header).
 */
export class DaemonRosterSyncState {
	readonly pendingChanged = new Set<string>();
	readonly pendingRemoved = new Set<string>();
	/** Ids declared to subscribers: gates removals to once and keeps owned-only row ids private. */
	readonly publishedIds = new Set<string>();
	pushScheduled = false;
	watchdogTimer?: ReturnType<typeof setInterval>;
}

/**
 * The seam of DaemonSupervisor the extracted roster-sync cluster reads and
 * calls. Member types mirror the class's own members via indexed access so a
 * rename on the class fails here at compile time. The class satisfies this with
 * the `rosterSyncHost` facade (its members are `private`-keyworded, so the
 * instance itself cannot be the host structurally); every member is read live
 * through a getter or arrow, never snapshotted. The seam is read-only/call-only
 * except for the state seat: the cluster mutates only its own seat and its
 * argument's worker record (and, through persistWorker / write /
 * evictEmptySessionOnLastDetach, what those methods already mutate) — exactly
 * what the methods did on the class.
 */
export interface DaemonSupervisorRosterSyncHost {
	readonly rosterSyncState: DaemonRosterSyncState;
	readonly workers: DaemonSupervisor["workers"];
	readonly clients: DaemonSupervisor["clients"];
	readonly shuttingDown: DaemonSupervisor["shuttingDown"];
	readonly defaultSessionConfig: DaemonSupervisor["defaultSessionConfig"];
	log: DaemonSupervisor["log"];
	background: DaemonSupervisor["background"];
	write: DaemonSupervisor["write"];
	isVisibleWorker: DaemonSupervisor["isVisibleWorker"];
	isWorkerStopping: DaemonSupervisor["isWorkerStopping"];
	rlmSpawnLedger: DaemonSupervisor["rlmSpawnLedger"];
	hydratedSeedEntry: DaemonSupervisor["hydratedSeedEntry"];
	persistWorker: DaemonSupervisor["persistWorker"];
	refreshWorkerSummaries: DaemonSupervisor["refreshWorkerSummaries"];
	evictEmptySessionOnLastDetach: DaemonSupervisor["evictEmptySessionOnLastDetach"];
	ensureRosterStore: DaemonSupervisor["ensureRosterStore"];
	consumeWorkerRosterDelta: DaemonSupervisor["consumeWorkerRosterDelta"];
}

export function roster(host: DaemonSupervisorRosterSyncHost): AgentRoster {
	return host.ensureRosterStore((mutation) => onRosterMutation(host, mutation));
}

function onRosterMutation(host: DaemonSupervisorRosterSyncHost, mutation: AgentRosterMutation): void {
	const state = host.rosterSyncState;
	if (mutation.type === "delete") {
		state.pendingChanged.delete(mutation.agentId);
		state.pendingRemoved.add(mutation.agentId);
	} else {
		state.pendingRemoved.delete(mutation.agentId);
		state.pendingChanged.add(mutation.agentId);
	}
	scheduleRosterPush(host);
}

function scheduleRosterPush(host: DaemonSupervisorRosterSyncHost): void {
	const state = host.rosterSyncState;
	if (state.pushScheduled || host.shuttingDown) return;
	state.pushScheduled = true;
	setImmediate(() => {
		state.pushScheduled = false;
		flushRosterUpdates(host);
	});
}

function flushRosterUpdates(host: DaemonSupervisorRosterSyncHost): void {
	const state = host.rosterSyncState;
	const changed: AgentRosterEntry[] = [];
	const removed: string[] = [];
	for (const agentId of state.pendingRemoved) {
		if (state.publishedIds.delete(agentId)) removed.push(agentId);
	}
	for (const agentId of state.pendingChanged) {
		const entry = roster(host).get(agentId);
		if (!entry) continue;
		if (isRosterEntryVisibleToClients(host, entry)) {
			changed.push(entry);
			state.publishedIds.add(agentId);
		} else if (state.publishedIds.delete(agentId)) {
			removed.push(agentId);
		}
	}
	state.pendingChanged.clear();
	state.pendingRemoved.clear();
	if (changed.length === 0 && removed.length === 0) return;
	for (const client of host.clients) {
		if (client.rosterSubscribed !== true) continue;
		if (client.backpressured === true) {
			client.rosterResyncPending = true;
			continue;
		}
		host.write(client, {
			type: "roster_update",
			changed,
			...(removed.length > 0 ? { removed } : {}),
		});
	}
}

export function rosterEntriesForClient(host: DaemonSupervisorRosterSyncHost): AgentRosterEntry[] {
	const entries = [...roster(host).values()].filter((entry) => isRosterEntryVisibleToClients(host, entry));
	for (const entry of entries) host.rosterSyncState.publishedIds.add(entry.agentId);
	return entries;
}

function isRosterEntryVisibleToClients(host: DaemonSupervisorRosterSyncHost, entry: AgentRosterEntry): boolean {
	const worker = entry.workerId !== undefined ? host.workers.get(entry.workerId) : undefined;
	return worker === undefined || host.isVisibleWorker(worker);
}

export function writeRosterEntry(
	host: DaemonSupervisorRosterSyncHost,
	entry: WorkerRosterEntry,
	worker?: ResidentWorker,
	statusLabel?: AgentRosterEntry["statusLabel"],
): AgentRosterEntry {
	const previousDirect = roster(host).get(entry.agentId)?.summary.directAttachedClients ?? 0;
	const stored = roster(host).write(entry, worker?.descriptor.workerId, statusLabel);
	// Direct peers attach and detach on the worker socket, so their last detach arrives
	// here as roster truth instead of through a supervisor-socket close.
	if (worker !== undefined && previousDirect > 0 && (entry.summary.directAttachedClients ?? 0) === 0) {
		host.background(
			host.evictEmptySessionOnLastDetach(entry.summary.activeSessionId ?? entry.summary.id),
			"empty session eviction on roster change",
		);
	}
	return stored;
}

export function workerOwnedRosterSummaryForPath(
	host: DaemonSupervisorRosterSyncHost,
	canonicalPath: string,
): SessionSummary | undefined {
	const entry = roster(host).bySessionFile(canonicalPath);
	if (!entry || entry.workerId === undefined || !host.workers.has(entry.workerId)) return undefined;
	return sessionSummaryFromRosterEntry(entry);
}

export function workerRosterEntries(host: DaemonSupervisorRosterSyncHost, worker: ResidentWorker): AgentRosterEntry[] {
	return roster(host).entriesForWorker(worker.descriptor.workerId);
}

export async function seedRosterLedger(host: DaemonSupervisorRosterSyncHost): Promise<void> {
	try {
		const roots = new Set<string>();
		for (const worker of host.workers.values()) {
			const root = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
			if (root !== undefined) roots.add(canonicalSessionPath(root));
		}
		if (roots.size === 0) return;
		const edges = await host.rlmSpawnLedger().liveEdges();
		const descendsFrom = rosterFamilyDescendsFrom(edges);
		for (const edge of edges) {
			if (!descendsFrom(canonicalSessionPath(edge.parent), roots)) continue;
			const entry = rosterEntryForSpawnLedgerEdge(edge);
			if (roster(host).has(entry.agentId)) continue;
			if (roster(host).hasSessionFile(canonicalSessionPath(edge.child))) continue;
			roster(host).write(await host.hydratedSeedEntry(entry));
		}
	} catch (error) {
		host.log(`Could not seed the agent roster from the spawn ledger: ${String(error)}`);
	}
}

/**
 * L3 follow-up: adoption runs after `markReady()`, so without this a client that
 * lists right after a restart sees zero sessions until adoption settles, which
 * reads as losing every session. Seed one honest row per registered root from its
 * durable descriptor and let adoption upgrade it in place: the roster keys on
 * sessionId and de-duplicates on sessionFile, so no second row can appear, and a
 * worker that never comes back still has a row for the park path to flip.
 */
export function seedAdoptingWorkerRosterRows(host: DaemonSupervisorRosterSyncHost): void {
	for (const worker of host.workers.values()) {
		const descriptor = worker.descriptor;
		const sessionId = descriptor.rootSessionId;
		// Client-owned workers are ephemeral and private; their rows are born with
		// the adoption their owner drives.
		if (sessionId === undefined || descriptor.ownerClientId !== undefined) {
			continue;
		}
		// A durable stop intent means a kill was in flight: listing it as recovering
		// would resurrect a root the user deliberately stopped. The stop and reaper
		// paths own that registration, not the session list.
		if (host.isWorkerStopping(worker)) {
			continue;
		}
		if (workerRosterEntries(host, worker).length > 0) {
			continue;
		}
		const summary: SessionSummary = {
			id: descriptor.rootActiveSessionId ?? sessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId,
			...(descriptor.rootActiveSessionId !== undefined ? { activeSessionId: descriptor.rootActiveSessionId } : {}),
			...(descriptor.sessionFile !== undefined ? { sessionFile: descriptor.sessionFile } : {}),
			cwd: host.defaultSessionConfig.cwd ?? "",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		writeRosterEntry(host, workerRosterEntryFromSummary(summary), worker, "recovering");
	}
}

// Workers can be registered mid-tree (a resumed subagent transcript), so descent is membership at
// any step of the parent walk, never a comparison against the ultimate root alone.
function rosterFamilyDescendsFrom(
	edges: readonly RlmLedgerEdge[],
): (path: string, roots: ReadonlySet<string>) => boolean {
	const parentByChild = new Map(
		edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
	);
	return (path, roots) => {
		const visited = new Set<string>();
		let current = path;
		while (!visited.has(current)) {
			if (roots.has(current)) return true;
			visited.add(current);
			const parent = parentByChild.get(current);
			if (parent === undefined) return false;
			current = parent;
		}
		return false;
	};
}

export function rosterEntryForSpawnLedgerEdge(edge: RlmLedgerEdge): WorkerRosterEntry {
	const persistedSessionId = basename(edge.child, ".jsonl");
	const summary: WorkerRosterEntry["summary"] = {
		id: persistedSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		runtimeKind: "subagent",
		rlmDepth: edge.depth,
		sessionId: persistedSessionId,
		sessionFile: edge.child,
		sessionName: edge.name,
		cwd: dirname(edge.child),
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		parentSessionPath: edge.parent,
		rlmChildId: edge.childId,
	};
	return { agentId: rosterAgentIdForSummary(summary), summary };
}

export function consumeWorkerRosterDelta(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	payload: Buffer,
	source?: DaemonWorkerClient,
): void {
	let delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>;
	try {
		delta = JSON.parse(payload.toString("utf8")) as Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>;
	} catch {
		return;
	}
	if (delta.type !== "roster_delta" || !Array.isArray(delta.entries)) return;
	worker.rosterEpoch = (worker.rosterEpoch ?? 0) + 1;
	const applySource = source ?? worker.client ?? worker.pendingClient;
	if (!isWorkerRosterApplyCurrent(host, worker, applySource)) return;
	if (delta.snapshot !== true && worker.rosterApplyChain === undefined) {
		// Same handling as the chained path below: a frame this build cannot apply
		// costs one log line and a repair pull, never the supervisor<->worker
		// connection (a throw here reaches the frame decoder's catch, which
		// destroys the stream).
		try {
			applyWorkerRosterDelta(host, worker, delta);
		} catch (error) {
			host.log(`could not apply a roster frame: ${String(error)}`);
			scheduleRosterRepairPull(host, worker);
		}
		return;
	}
	chainWorkerRosterApply(host, worker, applySource, () =>
		delta.snapshot === true
			? applyWorkerRosterSnapshot(host, worker, delta, applySource)
			: applyWorkerRosterDelta(host, worker, delta),
	);
}

export function chainWorkerRosterApply(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	source: DaemonWorkerClient | undefined,
	apply: () => void | Promise<void>,
): Promise<void> {
	const chained = (worker.rosterApplyChain ?? Promise.resolve())
		.then(() => {
			if (!isWorkerRosterApplyCurrent(host, worker, source)) return;
			return apply();
		})
		.catch((error: unknown) => {
			host.log(`could not apply a roster frame: ${String(error)}`);
			scheduleRosterRepairPull(host, worker);
		});
	worker.rosterApplyChain = chained;
	void chained.finally(() => {
		if (worker.rosterApplyChain === chained) worker.rosterApplyChain = undefined;
	});
	return chained;
}

// An apply is valid only while its own source connection is current: dead connections' parked applies abort.
function isWorkerRosterApplyCurrent(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	source: DaemonWorkerClient | undefined,
): boolean {
	return (
		host.workers.get(worker.descriptor.workerId) === worker &&
		source !== undefined &&
		(source === worker.client || source === worker.pendingClient)
	);
}

function scheduleRosterRepairPull(host: DaemonSupervisorRosterSyncHost, worker: ResidentWorker): void {
	if (worker.rosterRepairPull || !isWorkerRosterApplyCurrent(host, worker, worker.client)) return;
	// The marker stays set while the repair's own fill applies, so a failing repair never respawns itself.
	worker.rosterRepairPull = host
		.refreshWorkerSummaries(worker, false, true)
		.catch((error: unknown) =>
			host.log(`Roster repair pull failed for worker ${worker.descriptor.workerId}: ${String(error)}`),
		)
		.finally(() => {
			worker.rosterRepairPull = undefined;
		});
}

function applyWorkerRosterDelta(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>,
): void {
	let skipped = 0;
	for (const entry of delta.entries) {
		// A mixed-version worker can send an entry this build cannot classify, and
		// classification reads `summary.activity`: a missing summary is a
		// synchronous TypeError. Skip and repair instead of throwing into the frame
		// dispatcher, the same way `sessionSummariesFromResponse` validates a `list`
		// response before using it.
		if (!isWorkerRosterEntry(entry)) {
			skipped++;
			continue;
		}
		writeRosterEntry(host, entry, worker);
		syncRootDescriptorFromRosterEntry(host, worker, entry);
	}
	if (skipped > 0) {
		host.log(
			`Skipped ${skipped} malformed roster ${skipped === 1 ? "entry" : "entries"} from worker ${worker.descriptor.workerId}; pulling a repair snapshot`,
		);
		scheduleRosterRepairPull(host, worker);
	}
	for (const agentId of delta.removedAgentIds ?? []) {
		roster(host).delete(agentId);
	}
}

/** The minimum a roster frame entry must carry to be classified and written. */
function isWorkerRosterEntry(value: unknown): value is WorkerRosterEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const entry = value as { agentId?: unknown; summary?: unknown };
	return typeof entry.agentId === "string" && isSessionSummary(entry.summary);
}

export async function applyWorkerRosterSnapshot(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>,
	source?: DaemonWorkerClient,
): Promise<void> {
	let edgesFailed = false;
	const edges = await host
		.rlmSpawnLedger()
		.liveEdges()
		.catch((error: unknown) => {
			host.log(`Could not read the spawn ledger during a snapshot apply: ${String(error)}`);
			edgesFailed = true;
			return [] as RlmLedgerEdge[];
		});
	const applySource = source ?? worker.client ?? worker.pendingClient;
	if (!isWorkerRosterApplyCurrent(host, worker, applySource)) return;
	const sent = new Set(delta.entries.map((entry) => entry.agentId));
	const removed = new Set(delta.removedAgentIds ?? []);
	const unclaimed = new Map<string, AgentRosterEntry>();
	if (!edgesFailed) {
		for (const entry of workerRosterEntries(host, worker)) {
			if (sent.has(entry.agentId)) continue;
			unclaimed.set(entry.agentId, entry);
		}
	}
	// Only this worker's family reseeds: anything wider can resurrect a client-owned worker's dropped children.
	const workerRoot = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
	const rootPaths = new Set(workerRoot !== undefined ? [canonicalSessionPath(workerRoot)] : []);
	const descendsFrom = rosterFamilyDescendsFrom(edges);
	const familyEdges = edges.filter((edge) => descendsFrom(canonicalSessionPath(edge.parent), rootPaths));
	// "Unclaimed" rows survive: the sweep deletes them but the restore branch rewrites them.
	const rowSurvivesWithoutReseed = (entry: WorkerRosterEntry, childPath: string): boolean => {
		if (unclaimed.has(entry.agentId)) return true;
		if (sent.has(entry.agentId) && !removed.has(entry.agentId)) return true;
		const survives = (row: AgentRosterEntry | undefined): boolean =>
			row !== undefined && !unclaimed.has(row.agentId) && !removed.has(row.agentId);
		return survives(roster(host).get(entry.agentId)) || survives(roster(host).bySessionFile(childPath));
	};
	const seededEntries = new Map<string, WorkerRosterEntry>();
	for (const edge of familyEdges) {
		const entry = rosterEntryForSpawnLedgerEdge(edge);
		if (rowSurvivesWithoutReseed(entry, canonicalSessionPath(edge.child))) continue;
		seededEntries.set(entry.agentId, await host.hydratedSeedEntry(entry));
		if (!isWorkerRosterApplyCurrent(host, worker, applySource)) return;
	}

	// Unreadable edges skip the absentee sweep: it cannot tell registry children from stale rows.
	for (const entry of unclaimed.values()) roster(host).delete(entry.agentId);
	for (const entry of delta.entries) {
		writeRosterEntry(host, entry, worker);
		syncRootDescriptorFromRosterEntry(host, worker, entry);
	}
	for (const agentId of removed) roster(host).delete(agentId);
	if (edgesFailed) {
		scheduleRosterRepairPull(host, worker);
		return;
	}
	for (const edge of familyEdges) {
		const entry = rosterEntryForSpawnLedgerEdge(edge);
		if (roster(host).has(entry.agentId)) continue;
		if (roster(host).hasSessionFile(canonicalSessionPath(edge.child))) continue;
		const previous = unclaimed.get(entry.agentId);
		if (previous) {
			const { status, statusLabel, lastHeardFromAt, workerId, ...rest } = previous;
			writeRosterEntry(host, rest, worker);
			continue;
		}
		roster(host).write(seededEntries.get(entry.agentId) ?? { ...entry, seededCwd: true });
	}
}

function syncRootDescriptorFromRosterEntry(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	entry: WorkerRosterEntry,
): void {
	const summary = entry.summary;
	if (summary.activeSessionId !== worker.descriptor.rootActiveSessionId) return;
	if (worker.descriptor.rootSessionId === summary.sessionId && worker.descriptor.sessionFile === summary.sessionFile) {
		return;
	}
	worker.descriptor.rootSessionId = summary.sessionId;
	worker.descriptor.sessionFile = summary.sessionFile;
	worker.descriptor.createCommand = durableDaemonCreateCommand({
		type: "create",
		sessionPath: summary.sessionFile,
		noSession: worker.descriptor.createCommand.noSession,
	});
	host.persistWorker(worker);
}

// Behind the pull-epoch guard the pull is never staler than the row it replaces; never steal another worker's claim.
export function syncRosterFromWorkerSummaries(host: DaemonSupervisorRosterSyncHost, worker: ResidentWorker): void {
	for (const summary of worker.summaries.values()) {
		const entry = workerRosterEntryFromSummary(summary);
		const existing = roster(host).get(entry.agentId);
		if (existing?.workerId !== undefined && existing.workerId !== worker.descriptor.workerId) continue;
		writeRosterEntry(host, entry, worker);
	}
}

export function markWorkerRosterEntries(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	statusLabel: "recovering" | "failed" | undefined,
): void {
	for (const entry of workerRosterEntries(host, worker)) {
		if (!entry.queuedChild && entry.summary.activeSessionId === undefined) continue;
		roster(host).amend(entry.agentId, { statusLabel });
	}
}

export function flipWorkerRosterEntriesInactive(host: DaemonSupervisorRosterSyncHost, worker: ResidentWorker): void {
	// Client-owned workers are ephemeral and private: their rows die with the registration.
	const ephemeral = worker.descriptor.ownerClientId !== undefined;
	for (const entry of workerRosterEntries(host, worker)) {
		if (ephemeral || entry.queuedChild) {
			roster(host).delete(entry.agentId);
			continue;
		}
		// Registration marks survive eviction: passive rows still have schedules behind them.
		writeRosterEntry(
			host,
			passivatedWorkerRosterEntry(entry, {
				hasRegisteredHeartbeat: entry.summary.hasRegisteredHeartbeat === true,
				hasRegisteredCronJob: entry.summary.hasRegisteredCronJob === true,
			}),
		);
	}
}

export function sweepRosterStaleness(host: DaemonSupervisorRosterSyncHost, now = Date.now()): void {
	for (const worker of host.workers.values()) {
		if (worker.client === undefined || worker.lastFrameAt === undefined) {
			continue;
		}
		if (now - worker.lastFrameAt > ROSTER_STALE_AFTER_MS) {
			const lastHeardFromAt = new Date(worker.lastFrameAt).toISOString();
			for (const entry of workerRosterEntries(host, worker)) {
				// write() rebuilds rows without the mark; the sweep owns it and restamps only those.
				if (entry.lastHeardFromAt !== lastHeardFromAt) roster(host).amend(entry.agentId, { lastHeardFromAt });
			}
			worker.rosterStale = true;
		} else if (worker.rosterStale) {
			clearRosterStaleness(host, worker);
		}
	}
}

export function clearRosterStaleness(host: DaemonSupervisorRosterSyncHost, worker: ResidentWorker): void {
	if (!worker.rosterStale) return;
	worker.rosterStale = false;
	for (const entry of workerRosterEntries(host, worker)) {
		roster(host).amend(entry.agentId, { lastHeardFromAt: undefined });
	}
}

export function clearRosterWatchdogTimer(host: DaemonSupervisorRosterSyncHost): void {
	const state = host.rosterSyncState;
	if (!state.watchdogTimer) return;
	clearInterval(state.watchdogTimer);
	state.watchdogTimer = undefined;
}

export async function handleRosterSubscribe(
	host: DaemonSupervisorRosterSyncHost,
	client: DaemonSocketClient,
	command: Extract<DaemonCommand, { type: "roster_subscribe" }>,
): Promise<DaemonResponse | undefined> {
	client.rosterSubscribed = true;
	return success(command.id, command.type, { roster: rosterEntriesForClient(host) });
}

export async function handleRosterUnsubscribe(
	// biome-ignore lint/correctness/noUnusedFunctionParameters: uniform (host, ...args) shape across the cluster; this handler reads no supervisor state.
	host: DaemonSupervisorRosterSyncHost,
	client: DaemonSocketClient,
	command: Extract<DaemonCommand, { type: "roster_unsubscribe" }>,
): Promise<DaemonResponse | undefined> {
	client.rosterSubscribed = false;
	client.rosterResyncPending = false;
	return success(command.id, command.type);
}

export function handleWorkerRosterDeltaFrame(
	host: DaemonSupervisorRosterSyncHost,
	worker: ResidentWorker,
	frame: PrivateFrame<DaemonWorkerFrameHeader>,
	source?: DaemonWorkerClient,
): void {
	// Route back through the host so an instance-level own-property stub of
	// consumeWorkerRosterDelta keeps shadowing the class shell.
	host.consumeWorkerRosterDelta(worker, frame.payload, source);
}
