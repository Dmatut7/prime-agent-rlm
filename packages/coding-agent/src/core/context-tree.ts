import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { RlmChildAgentStatus } from "./agent-session.js";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import { buildSessionContext, type FileEntry, loadEntriesFromFile, type SessionEntry } from "./session-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage, subtractAssistantUsage } from "./usage.js";

/** Resolves a model's context window so disk-only nodes can report utilization. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;

/**
 * One agent in the context overview: the main session or an RLM (sub-)agent.
 * `ownUsage` excludes descendants; `totalUsage` includes completed descendants, matching /usage.
 */
export interface ContextTreeNode {
	/** "root" for the session itself; sub-xxxx for an RLM child. */
	id: string;
	label: string;
	status: "active" | RlmChildAgentStatus;
	model?: { provider: string; id: string };
	ownUsage: Usage;
	totalUsage: Usage;
	contextUsage?: ContextUsage;
	children: ContextTreeNode[];
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "message";
	message: AssistantMessage;
} {
	return entry.type === "message" && entry.message.role === "assistant";
}

function readUserMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactLabel(text: string, maxLength = 80): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Usage totals for one agent: `totalUsage` sums the branch's assistant usage
 * (attributed aggregates, so descendants are included), `ownUsage` removes the
 * attributions targeting those assistants. Attribution entries are matched by
 * target across ALL entries, not just the branch: attributions rewrite the
 * target assistant's usage no matter which branch they were appended on, so a
 * fork that keeps the assistant but drops the attribution entry must still
 * subtract it.
 *
 * Totals are deliberately cumulative across compactions: compaction shrinks
 * the model-facing context, not what the session has spent, so assistants
 * dropped from the resolved context still count here.
 */
/**
 * Incremental form of {@link computeOwnAndTotalUsage} for a session that keeps appending.
 *
 * The totals are linear in the entries, so a live session can fold each new entry once
 * instead of re-walking a transcript that only grows: a busy turn republishes the roster
 * many times, and every republication used to recompute both passes over every entry the
 * session had ever written.
 *
 * An attribution that arrives before the assistant it targets is held until that assistant
 * appears, so the result matches the whole-file computation regardless of arrival order.
 */
export class OwnUsageAccumulator {
	private totalUsage: Usage = emptyUsage();
	private ownUsage: Usage = emptyUsage();
	/** Assistants whose usage the branch counted, i.e. the targets an attribution may subtract from. */
	private readonly countedAssistantIds = new Set<string>();
	/** Attributions that arrived before their target; applied when the target is counted. */
	private readonly pendingAttributions = new Map<string, Usage[]>();
	private processed = 0;
	/** The entry the cursor stopped at, so a caller that comes back with a different array is seen. */
	private lastTail: SessionEntry | undefined;

	get processedCount(): number {
		return this.processed;
	}

	/**
	 * Fold every entry past the one already consumed. Same entries in, same totals out.
	 *
	 * "Same entries" means the array only ever grows at the back. A caller that comes back with a
	 * shorter array, or with a different entry where the cursor stopped, is asking about a
	 * transcript that no longer exists: a failed append rolls its entry back and the retry pushes
	 * a new one at the same length. Rather than keep reporting the rolled-back spend, the fold
	 * restarts over the array actually present. It restarts instead of throwing because the only
	 * caller publishes session rows and /usage for the UI, and a bookkeeping reset that a session
	 * recovers from on its own must not take the roster down.
	 */
	add(entries: readonly SessionEntry[]): { ownUsage: Usage; totalUsage: Usage } {
		if (!this.foldedPrefixIsIntact(entries)) this.restart();
		for (let index = this.processed; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			if (isAssistantEntry(entry)) {
				addAssistantUsage(this.totalUsage, entry.message.usage);
				addAssistantUsage(this.ownUsage, entry.message.usage);
				this.countedAssistantIds.add(entry.id);
				const pending = this.pendingAttributions.get(entry.id);
				if (pending !== undefined) {
					for (const usage of pending) subtractAssistantUsage(this.ownUsage, usage);
					this.pendingAttributions.delete(entry.id);
				}
				continue;
			}
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				addAssistantUsage(this.totalUsage, entry.usage);
				addAssistantUsage(this.ownUsage, entry.usage);
				continue;
			}
			if (entry.type === "child_usage_attributed") {
				if (this.countedAssistantIds.has(entry.targetId)) {
					subtractAssistantUsage(this.ownUsage, entry.childUsage);
				} else {
					const pending = this.pendingAttributions.get(entry.targetId);
					if (pending === undefined) this.pendingAttributions.set(entry.targetId, [entry.childUsage]);
					else pending.push(entry.childUsage);
				}
			}
		}
		this.processed = entries.length;
		this.lastTail = entries.at(-1);
		return { ownUsage: cloneUsage(this.ownUsage), totalUsage: cloneUsage(this.totalUsage) };
	}

	/**
	 * Whether everything already folded is still the prefix of `entries`. Identity of the
	 * entry the cursor stopped at covers both shapes of the break: a shorter array and an entry
	 * replaced at the same length.
	 */
	private foldedPrefixIsIntact(entries: readonly SessionEntry[]): boolean {
		if (this.processed === 0) return true;
		return entries.length >= this.processed && entries[this.processed - 1] === this.lastTail;
	}

	private restart(): void {
		this.totalUsage = emptyUsage();
		this.ownUsage = emptyUsage();
		this.countedAssistantIds.clear();
		this.pendingAttributions.clear();
		this.processed = 0;
		this.lastTail = undefined;
	}
}

export function computeOwnAndTotalUsage(
	branch: SessionEntry[],
	allEntries: SessionEntry[],
): { ownUsage: Usage; totalUsage: Usage } {
	const totalUsage = emptyUsage();
	const branchAssistantIds = new Set<string>();
	for (const entry of branch) {
		if (isAssistantEntry(entry)) {
			branchAssistantIds.add(entry.id);
			addAssistantUsage(totalUsage, entry.message.usage);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addAssistantUsage(totalUsage, entry.usage);
		}
	}
	const ownUsage = cloneUsage(totalUsage);
	for (const entry of allEntries) {
		if (entry.type === "child_usage_attributed" && branchAssistantIds.has(entry.targetId)) {
			subtractAssistantUsage(ownUsage, entry.childUsage);
		}
	}
	return { ownUsage, totalUsage };
}

/**
 * Current context utilization from persisted entries, mirroring
 * AgentSession.getContextUsage(): unknown right after a compaction until the
 * next assistant response, otherwise the last assistant usage plus an
 * estimate for trailing messages (tool results, queued user input) that have
 * not hit the model yet.
 */
function computeContextUsageFromEntries(
	allEntries: SessionEntry[],
	branch: SessionEntry[],
	contextWindow: number | undefined,
): ContextUsage | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	let latestCompactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			latestCompactionIndex = i;
			break;
		}
	}

	if (latestCompactionIndex >= 0) {
		let hasPostCompactionUsage = false;
		for (let i = branch.length - 1; i > latestCompactionIndex; i--) {
			const entry = branch[i];
			if (!isAssistantEntry(entry)) {
				continue;
			}
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
				continue;
			}
			if (calculateContextTokens(assistant.usage) > 0) {
				hasPostCompactionUsage = true;
			}
			break;
		}
		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(buildSessionContext(allEntries).messages);
	if (estimate.tokens <= 0) {
		return undefined;
	}
	return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

function sessionEntriesFromFile(file: string): SessionEntry[] {
	return loadEntriesFromFile(file).filter((entry: FileEntry): entry is SessionEntry => entry.type !== "session");
}

/**
 * Entries on the current branch, root to leaf, mirroring
 * SessionManager.getBranch(): the leaf is the last appended entry and the
 * branch is its parentId chain. Keeps forked/abandoned paths out of usage
 * sums so disk nodes match what a live session would report.
 */
function branchEntries(entries: SessionEntry[]): SessionEntry[] {
	if (entries.length === 0) {
		return [];
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = entries[entries.length - 1];
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

/**
 * Terminal status for a persisted child, inferred from how its last assistant
 * turn ended: errored and aborted runs should not render as successful.
 */
function statusFromBranch(entries: SessionEntry[]): "done" | "error" | "cancelled" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isAssistantEntry(entry)) {
			continue;
		}
		if (entry.message.stopReason === "error") {
			return "error";
		}
		if (entry.message.stopReason === "aborted") {
			return "cancelled";
		}
		return "done";
	}
	return "done";
}

function findSessionFile(dir: string): string | undefined {
	let newest: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		const path = join(dir, name);
		try {
			const mtime = statSync(path).mtime.getTime();
			if (!newest || mtime > newest.mtime) {
				newest = { path, mtime };
			}
		} catch {
			// Skip unreadable files.
		}
	}
	return newest?.path;
}

function listChildSessionDirs(rlmSessionDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(rlmSessionDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith("sub-"))
		.map((name) => join(rlmSessionDir, name))
		.filter((path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		})
		.sort((a, b) => {
			try {
				return statSync(a).mtime.getTime() - statSync(b).mtime.getTime();
			} catch {
				return 0;
			}
		});
}

/**
 * Build a context node for a completed RLM child from its persisted session
 * dir (sub-xxxx/). Children that already attributed grandchild usage carry the
 * aggregate on their assistant messages (applyChildUsageAttributions), so own
 * usage is recovered by subtracting the attribution entries. Returns undefined
 * when the dir holds no readable session.
 */
export function loadContextTreeChildFromDisk(
	childSessionDir: string,
	resolveContextWindow: ContextWindowResolver,
): ContextTreeNode | undefined {
	const sessionFile = findSessionFile(childSessionDir);
	if (!sessionFile) {
		return undefined;
	}
	const allEntries = sessionEntriesFromFile(sessionFile);
	const branch = branchEntries(allEntries);
	if (branch.length === 0) {
		return undefined;
	}

	const { ownUsage, totalUsage } = computeOwnAndTotalUsage(branch, allEntries);

	let model: { provider: string; id: string } | undefined;
	for (const entry of branch) {
		if (entry.type === "model_change") {
			model = { provider: entry.provider, id: entry.modelId };
		}
	}

	let label = "";
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			label = compactLabel(readUserMessageText(entry.message.content));
			if (label) {
				break;
			}
		}
	}

	const contextWindow = model ? resolveContextWindow(model.provider, model.id) : undefined;

	return {
		id: basename(childSessionDir),
		label: label || "child agent",
		status: statusFromBranch(branch),
		model,
		ownUsage,
		totalUsage,
		contextUsage: computeContextUsageFromEntries(allEntries, branch, contextWindow),
		children: loadContextTreeChildrenFromDisk(childSessionDir, resolveContextWindow),
	};
}

/**
 * Build context nodes for all persisted RLM children under an RLM session
 * dir, recursing into nested sub-* dirs for grandchildren. `skipIds`
 * excludes children that are already represented live.
 */
export function loadContextTreeChildrenFromDisk(
	rlmSessionDir: string | undefined,
	resolveContextWindow: ContextWindowResolver,
	skipIds?: ReadonlySet<string>,
): ContextTreeNode[] {
	if (!rlmSessionDir || !existsSync(rlmSessionDir)) {
		return [];
	}
	const nodes: ContextTreeNode[] = [];
	for (const childDir of listChildSessionDirs(rlmSessionDir)) {
		if (skipIds?.has(basename(childDir))) {
			continue;
		}
		const node = loadContextTreeChildFromDisk(childDir, resolveContextWindow);
		if (node) {
			nodes.push(node);
		}
	}
	return nodes;
}
