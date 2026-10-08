/**
 * Harness-digest cluster extracted from agent-session.ts: the compact digest
 * delivered at cold context boundaries (session start, resume, tree navigation,
 * compaction head) and as a material-change delta, its render-flag identity, the
 * store stamps and per-entry fingerprint behind the material-change gate, the
 * "already delivered" baselines, and the latest-in-context carrier scan. The
 * moved methods keep exactly the same bodies; they read the session through
 * {@link HarnessDigestHost}, which `AgentSession` satisfies structurally, so the
 * move changes no runtime behavior. The `HarnessStoreStamps` and
 * `PreparedHarnessDigest` types moved here with the cluster: agent-session.ts
 * imports them back for its field and shell signatures, and this module never
 * imports an agent-session value, so the layering stays acyclic.
 */

import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import { createHarnessDigestMessage, HARNESS_DIGEST_CUSTOM_TYPE, type HarnessDigestDetails } from "./messages.js";
import {
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	type HarnessQueryTerms,
	type HarnessState,
	type HarnessStateStamp,
	harnessDigestFingerprint,
	harnessQueryTerms,
	harnessStateStampsEqual,
	loadHarnessState,
	mergeHarnessStates,
	REFINE_REPORTED_DELETED,
	REFINE_SKILL_NAME,
	readHarnessStateStamp,
} from "./refinement/index.js";
import { readAssistantText } from "./rlm-child-run.js";

// Same logger name as agent-session.ts: the harness-digest paths moved here
// verbatim and their log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * The two harness stores a session's digest renders from: the machine-wide global
 * store and this session's own local store. `null` means "no state file", which is a
 * stamp like any other (its appearance and disappearance are both material changes).
 */
export interface HarnessStoreStamps {
	global: HarnessStateStamp | null;
	local: HarnessStateStamp | null;
}

function harnessStoreStampsEqual(left: HarnessStoreStamps, right: HarnessStoreStamps): boolean {
	return harnessStateStampsEqual(left.global, right.global) && harnessStateStampsEqual(left.local, right.local);
}

/**
 * Harness state plus the fingerprint of the material a digest would render, with
 * the render itself deferred. Delivery decisions compare fingerprints (and the
 * per-entry version map), so the common "a store stamp moved but nothing the
 * digest prints moved" turn pays the state load and the fingerprint only - the
 * ranked render (~0.155 s mean at the 48-term cap on the 1266-entry fixture
 * since a5f4868c0, and 0.66-0.70 s before that score-once rewrite; perf seats B/C
 * 2026-09-18) is bought only by a turn that actually appends a carrier. The
 * render is memoized: the legacy text-comparison branch and the append both read
 * the same string.
 */
export interface PreparedHarnessDigest {
	readonly state: HarnessState;
	readonly stateFingerprint: string;
	render(): string;
}

/**
 * Identity of the three digest render flags. A rebuild that leaves them alone (an
 * rlm depth cap, a reloaded agents file) must not invalidate a delivered digest, so
 * the tool-face seam compares a key instead of a fresh object.
 */
function harnessDigestRenderFlagsKey(flags: {
	includeIpythonExamples: boolean;
	includeShellExamples: boolean;
	includeRefineExamples: boolean;
}): string {
	return [flags.includeIpythonExamples, flags.includeShellExamples, flags.includeRefineExamples]
		.map((flag) => (flag ? "1" : "0"))
		.join("");
}

/**
 * Entry keys whose presence or version differs between two fingerprints: the
 * added / removed / version-bumped set the material-change gate judges.
 */
function changedHarnessEntryKeys(previous: Map<string, number>, next: Map<string, number>): Set<string> {
	const changed = new Set<string>();
	for (const [key, version] of next) {
		if (previous.get(key) !== version) changed.add(key);
	}
	for (const key of previous.keys()) {
		if (!next.has(key)) changed.add(key);
	}
	return changed;
}

/**
 * The seam of `AgentSession` the extracted harness-digest delivery reads and
 * mutates. Member names mirror the class's own members so the extraction stays
 * a textual `this.` -> `host.` rename; members whose signatures are wide are
 * indexed access types so they stay single-sourced on the class.
 * `AgentSession._prepareHarnessDigest`, `_harnessDigestWithFingerprint`,
 * `_noteHarnessDigestToolFaceChange`, `_ensureHarnessDigestContext`,
 * `_harnessDigestIsFresh`, `_refreshHarnessDigestIfMateriallyChanged`,
 * `_invalidateHarnessDigestBaselines`, `_recordHarnessDigestBaselines`,
 * `_latestContextHarnessDigestDetails` and `_loadMergedHarnessState` keep
 * one-line shells that delegate with `this` (the first-turn dispatch path, the
 * compaction heads, the system-prompt rebuild seam, the cold boundaries, the
 * digest strip/requeue paths and the auto-refine review all call them there).
 * The cluster-internal helpers have no shells.
 */
export interface HarnessDigestHost {
	readonly sessionId: AgentSession["sessionId"];
	readonly sessionManager: AgentSession["sessionManager"];
	readonly settingsManager: AgentSession["settingsManager"];
	readonly agent: AgentSession["agent"];
	readonly _goalState: AgentSession["_goalState"];
	readonly _toolRegistry: AgentSession["_toolRegistry"];
	readonly _refinementReportedEntryVersions: AgentSession["_refinementReportedEntryVersions"];
	_harnessDigestPending: AgentSession["_harnessDigestPending"];
	_harnessDigestStamps: AgentSession["_harnessDigestStamps"];
	_harnessDigestFingerprint: AgentSession["_harnessDigestFingerprint"];
	_harnessDigestRenderFlagsKey: AgentSession["_harnessDigestRenderFlagsKey"];
	getActiveToolNames: AgentSession["getActiveToolNames"];
	_modelVisibleSkills: AgentSession["_modelVisibleSkills"];
	_localHarnessStateDir: AgentSession["_localHarnessStateDir"];
}

/**
 * Digest plus the fingerprint of the state that produced it. The digest is the
 * compact harness face delivered at cold context boundaries (session start,
 * resume, tree navigation, compaction head) and as a material-change delta.
 * compare fingerprints, not rendered text (#2400): relevance query terms drift
 * per turn, so a rendered-text comparison would re-deliver an unchanged digest
 * at every boundary and stack near-duplicates into the context.
 */
export function prepareHarnessDigest(host: HarnessDigestHost): PreparedHarnessDigest {
	const state = loadMergedHarnessState(host);
	const renderFlags = harnessDigestRenderFlags(host);
	let rendered: string | undefined;
	return {
		state,
		stateFingerprint: harnessDigestFingerprint(state, {
			...renderFlags,
			indexMaxBytes: host.settingsManager.getHarnessDigestIndexMaxBytes(),
		}),
		render: () => {
			if (rendered === undefined) rendered = renderHarnessDigest(host, state, renderFlags);
			return rendered;
		},
	};
}

/** Digest plus fingerprint for the callers that always carry the text (compaction heads). */
export function harnessDigestWithFingerprint(host: HarnessDigestHost): {
	digest: string;
	stateFingerprint: string;
	state: HarnessState;
} {
	const prepared = prepareHarnessDigest(host);
	return {
		digest: prepared.render(),
		stateFingerprint: prepared.stateFingerprint,
		state: prepared.state,
	};
}

function harnessDigestRenderFlags(host: HarnessDigestHost): {
	includeIpythonExamples: boolean;
	includeShellExamples: boolean;
	includeRefineExamples: boolean;
} {
	// Same validation `_rebuildSystemPrompt` applies before handing tool names to
	// the prompt: an unregistered name must not flip the example sections.
	const tools = host.getActiveToolNames().filter((name) => host._toolRegistry.has(name));
	const hasIpython = tools.includes("ipython");
	const visibleSkills = host._modelVisibleSkills().filter((skill) => !skill.disableModelInvocation);
	const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
	return {
		includeIpythonExamples: hasIpython,
		includeShellExamples: tools.includes("bash"),
		includeRefineExamples: hasIpython && hasRefineSkill,
	};
}

/**
 * OBS-2: drop the "already delivered" baselines when the tool face behind the
 * render flags moved. Hooked into `_rebuildSystemPrompt` - the single seam every
 * tool and skill change already goes through (nine call sites: construction, tool
 * add/remove, `setActiveToolsByName`, two rlm-depth paths, extension resources) -
 * so nothing has to be enumerated per call site and no turn pays for it. The next
 * turn then re-renders and gate A rejects or delivers on the fingerprint, which
 * already covers these flags. The first observation is construction, not a change:
 * nothing has been delivered yet.
 */
export function noteHarnessDigestToolFaceChange(host: HarnessDigestHost): void {
	const key = harnessDigestRenderFlagsKey(harnessDigestRenderFlags(host));
	const previous = host._harnessDigestRenderFlagsKey;
	host._harnessDigestRenderFlagsKey = key;
	if (previous !== undefined && previous !== key) {
		invalidateHarnessDigestBaselines(host);
	}
}

/**
 * Rendered from the same inputs `buildSystemPrompt` used, so the text the model
 * reads is byte-for-byte the menu it read when the digest still lived in the prompt.
 */
function renderHarnessDigest(
	host: HarnessDigestHost,
	state: HarnessState,
	renderFlags: {
		includeIpythonExamples: boolean;
		includeShellExamples: boolean;
		includeRefineExamples: boolean;
	},
): string {
	return formatHarnessStateForPrompt(state, {
		...renderFlags,
		indexMaxBytes: host.settingsManager.getHarnessDigestIndexMaxBytes(),
		queryTerms: buildHarnessDigestQueryTerms(host),
	});
}

/**
 * Relevance signal for the harness digest: terms from the active goal
 * objective (strongest) and the last few user/assistant messages,
 * newest first. Scores are precomputed once per render and the sort compares
 * numbers (rankHarnessEntriesForQuery), so the ranked window stays cheap even
 * on a large shared store; the 48-term cap bounds the per-entry sweep.
 * A digest render happens before the current turn's message is committed,
 * so the terms lag one turn behind the wording (same tradeoff upstream
 * #2241 accepted); the next delivery picks the new wording up.
 */
function buildHarnessDigestQueryTerms(host: HarnessDigestHost): HarnessQueryTerms {
	const terms = new Map<string, number>();
	const addText = (text: string | undefined, weight: number) => {
		if (!text) return;
		for (const raw of harnessQueryTerms(text)) {
			if (terms.size >= 48 && !terms.has(raw)) return;
			if (!terms.has(raw)) terms.set(raw, weight);
		}
	};
	addText(host._goalState.objective, 3);
	const recent = host.agent.state.messages
		.filter(
			(message): message is UserMessage | AssistantMessage =>
				message.role === "user" || message.role === "assistant",
		)
		.slice(-4)
		.reverse();
	let recencyWeight = 2;
	for (const message of recent) {
		const text =
			message.role === "assistant"
				? readAssistantText(message)
				: typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is TextContent => block.type === "text")
							.map((block) => block.text)
							.join(" ");
		addText(text, recencyWeight);
		recencyWeight = Math.max(1, recencyWeight - 0.5);
	}
	return terms;
}

/**
 * Cold-boundary digest delivery. An empty context defers to the first committed
 * turn (an untouched session must keep reading as empty); a non-empty context
 * appends only when the newest in-context digest no longer matches disk.
 */
export function ensureHarnessDigestContext(host: HarnessDigestHost): void {
	if (host.agent.state.messages.length === 0) {
		host._harnessDigestPending = true;
		return;
	}
	host._harnessDigestPending = false;
	appendHarnessDigestIfStale(host);
}

function appendHarnessDigestIfStale(host: HarnessDigestHost): void {
	const prepared = prepareHarnessDigest(host);
	recordHarnessDigestBaselines(host, prepared.state);
	const latest = latestContextHarnessDigestDetails(host);
	if (latest && harnessDigestIsFresh(latest, prepared)) return;
	appendHarnessDigest(host, prepared.render(), prepared.stateFingerprint);
}

/**
 * Whether the newest in-context digest already reflects the current harness
 * state. A digest is fresh when its state fingerprint matches the current
 * one; a carrier written before fingerprints existed is compared by rendered
 * text instead, so it can be superseded once and then carries a fingerprint.
 */
export function harnessDigestIsFresh(
	latest: { digest: string; stateFingerprint?: string },
	prepared: PreparedHarnessDigest,
): boolean {
	// A fingerprinted carrier is judged without rendering; only a carrier written
	// before fingerprints existed forces the render (it has nothing else to
	// compare), and it is superseded once, after which it carries a fingerprint.
	return latest.stateFingerprint !== undefined
		? latest.stateFingerprint === prepared.stateFingerprint
		: latest.digest === prepared.render();
}

/**
 * Material-change re-injection (merge doc 12.2, boss constraint: a long session
 * must never freeze the harness menu). Runs at turn preparation, so an entry
 * another seat wrote is model-visible on the next turn instead of at the next
 * cold boundary. Append-only: it adds a message at the tail and never rewrites a
 * byte that precedes it, so the provider's cached prefix survives.
 *
 * Cost discipline: every mutation path persists through `writePrivateFileAtomic`
 * (a rename, so a new inode), which makes the two store stamps a complete change
 * signal. When nothing moved the turn pays two `lstat` calls and reads no state
 * file; a moved stamp buys the parse plus the state fingerprint, and only a turn
 * that actually appends a carrier buys the ranked render (perf seats B/C
 * 2026-09-18: on the 1266-entry fixture the render alone is ~0.155 s mean of
 * synchronous event-loop time at the 48-term cap - 0.66-0.70 s before the
 * score-once rewrite - and every moved stamp used to pay it whether or not
 * anything was delivered).
 */
export function refreshHarnessDigestIfMateriallyChanged(host: HarnessDigestHost): void {
	const stamps = harnessStoreStamps(host);
	if (host._harnessDigestStamps !== undefined && harnessStoreStampsEqual(host._harnessDigestStamps, stamps)) {
		return;
	}
	const prepared = prepareHarnessDigest(host);
	host._harnessDigestStamps = stamps;
	const fingerprint = harnessEntryFingerprint(prepared.state);
	const previous = host._harnessDigestFingerprint;
	host._harnessDigestFingerprint = fingerprint;
	// The harness state is the criterion, not the file's mtime or the rendered
	// text: a touch, or a write that restored identical content, moves the stamp
	// and changes nothing; query-term drift moves the text and changes nothing.
	const latest = latestContextHarnessDigestDetails(host);
	if (latest && harnessDigestIsFresh(latest, prepared)) return;
	if (previous !== undefined) {
		const changed = changedHarnessEntryKeys(previous, fingerprint);
		// Every moved entry was already itemized for the model by this session's own
		// refinement receipt (applied and refused alike), so a digest delta would
		// deliver the same news twice (merge doc 14.2). A deletion receipt carries the
		// REFINE_REPORTED_DELETED sentinel, which matches the key's absence from the
		// fingerprint - a pre-delete version number never would.
		if (
			changed.size > 0 &&
			[...changed].every((key) => {
				const reported = host._refinementReportedEntryVersions.get(key);
				return reported === REFINE_REPORTED_DELETED ? !fingerprint.has(key) : reported === fingerprint.get(key);
			})
		) {
			return;
		}
	}
	appendHarnessDigest(host, prepared.render(), prepared.stateFingerprint);
}

function appendHarnessDigest(host: HarnessDigestHost, digest: string, stateFingerprint?: string): void {
	const message = createHarnessDigestMessage(digest, Date.now(), stateFingerprint);
	try {
		host.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	} catch (error) {
		if (host.sessionManager.getSessionFile()) {
			// A persisted session that cannot record the digest loses it at the next
			// context rebuild: report it instead of swallowing the failure.
			sessionLog.warn("harness digest could not be persisted", {
				sessionId: host.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// An in-memory session has nothing to persist; context-only is the design.
	}
	host.agent.state.messages.push(message);
}

/** Store stamps behind the material-change gate: the global store and this session's local one. */
function harnessStoreStamps(host: HarnessDigestHost): HarnessStoreStamps {
	const localDir = host._localHarnessStateDir();
	return {
		global: readHarnessStateStamp(getGlobalHarnessStateDir()),
		local: localDir ? readHarnessStateStamp(localDir) : null,
	};
}

/** Drop the "already delivered" baselines so the next turn re-renders and re-checks. */
export function invalidateHarnessDigestBaselines(host: HarnessDigestHost): void {
	host._harnessDigestStamps = undefined;
	host._harnessDigestFingerprint = undefined;
}

export function recordHarnessDigestBaselines(host: HarnessDigestHost, state: HarnessState): void {
	host._harnessDigestStamps = harnessStoreStamps(host);
	host._harnessDigestFingerprint = harnessEntryFingerprint(state);
}

/** Identity of every harness entry (kind, store, id) to its version: additions, deletions and version bumps all move it. */
function harnessEntryFingerprint(state: HarnessState): Map<string, number> {
	const fingerprint = new Map<string, number>();
	for (const kind of Object.keys(state.entries) as Array<keyof HarnessState["entries"]>) {
		for (const [id, entry] of Object.entries(state.entries[kind] ?? {})) {
			fingerprint.set(`${kind}:${entry.scope ?? "unscoped"}:${id}`, entry.version);
		}
	}
	return fingerprint;
}

/**
 * Recency is the greatest timestamp among all in-context digest carriers, not the
 * last array position: retained pre-compaction messages are presented after the
 * compaction head while being chronologically older, and an old retained digest
 * must not defeat dedupe.
 */
export function latestContextHarnessDigestDetails(
	host: HarnessDigestHost,
): { timestamp: number; digest: string; stateFingerprint?: string } | undefined {
	let latest: { timestamp: number; digest: string; stateFingerprint?: string } | undefined;
	for (const message of host.agent.state.messages) {
		if (message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
			const details = message.details as HarnessDigestDetails | undefined;
			if (details?.digest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
				latest = {
					timestamp: message.timestamp,
					digest: details.digest,
					stateFingerprint: details.stateFingerprint,
				};
			}
		} else if (message.role === "compactionSummary") {
			if (message.harnessDigest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
				latest = {
					timestamp: message.timestamp,
					digest: message.harnessDigest,
					stateFingerprint: message.harnessStateFingerprint,
				};
			}
		}
	}
	return latest;
}

/** Global harness state overlaid with this session's local state, when persisted. */
export function loadMergedHarnessState(host: HarnessDigestHost): HarnessState {
	const localHarnessStateDir = host._localHarnessStateDir();
	return mergeHarnessStates(
		loadHarnessState(getGlobalHarnessStateDir(), "global"),
		localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined,
	);
}
