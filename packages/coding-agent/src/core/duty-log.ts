import { open, stat } from "node:fs/promises";

/**
 * The duty log (值班记录): what happened in a session while its owner was
 * away, read off the transcript at display time. Recovery machinery records
 * its actions as custom entries of {@link DUTY_EVENT_CUSTOM_TYPE}; the same
 * facts are also derived from what transcripts already carry (assistant
 * errors, `tool_timeout:` results, stall and child notices, model changes),
 * so sessions written before those entries existed still summarize.
 */

/** Custom entry type (`appendCustomEntry(DUTY_EVENT_CUSTOM_TYPE, event)`) the recovery lanes write. */
export const DUTY_EVENT_CUSTOM_TYPE = "duty_event";

/**
 * One recovery action, as the recovery machinery records it. Written as a
 * session custom entry (never model context). Unknown kinds and malformed
 * fields are ignored by the reader.
 */
export type DutyEvent =
	/** A provider request failed and is being retried after `waitMs`. */
	| { kind: "provider_retry"; provider?: string; model?: string; error?: string; waitMs?: number }
	/** The run moved to a backup model after repeated provider failures or a bad-call storm. */
	| { kind: "model_fallback"; from?: string; to: string; reason?: "provider_errors" | "bad_tool_calls" | string }
	/** The primary model answers again and the run moved back to it. */
	| { kind: "model_restored"; to: string }
	/** A tool step made no progress and was stopped so the model could continue differently. */
	| { kind: "step_stuck_stopped"; tool?: string; silentMs?: number }
	/** The model ended a turn before finishing and was nudged to continue. */
	| { kind: "auto_continue"; reason?: string }
	/** A child finished without replying and its result was handed to the parent. */
	| { kind: "child_auto_delivered"; child?: string }
	/** Work that needs the owner: recorded so the log can list it. */
	| { kind: "decision_needed"; question: string };

const EVENT_KINDS = new Set([
	"provider_retry",
	"model_fallback",
	"model_restored",
	"step_stuck_stopped",
	"auto_continue",
	"child_auto_delivered",
	"decision_needed",
]);

/** A duty event from custom entry data, or undefined when it is not one. */
export function parseDutyEvent(data: unknown): DutyEvent | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const kind = record.kind;
	if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) return undefined;
	if ((kind === "model_fallback" || kind === "model_restored") && typeof record.to !== "string") return undefined;
	if (kind === "decision_needed" && typeof record.question !== "string") return undefined;
	return record as DutyEvent;
}

/** A child session's state, as the subagent panel reports it. */
export type DutyLogChildState = "running" | "idle" | "done" | "failed" | "stalled";

export interface DutyLogChild {
	name: string;
	state: DutyLogChildState;
}

export type DutyIncidentKind =
	| "provider"
	| "quota"
	| "empty"
	| "stuck"
	| "bad_calls"
	| "stall"
	| "early_stop"
	| "child_silent"
	| "child_stuck"
	| "child_failed";

export interface DutyIncident {
	kind: DutyIncidentKind;
	count: number;
	/** How many of them were handled without the owner. */
	handled: number;
	/** Time the run could not make progress because of them. */
	downtimeMs?: number;
	/** Backup model the run moved to, when it did. */
	fallbackTo?: string;
	/** Model the run moved back to after a fallback. */
	restoredTo?: string;
}

export interface DutyLogPending {
	question: string;
	at: number;
}

export interface DutyLogSummary {
	/** Since the owner's last own message (or the oldest entry read). */
	awayMs: number;
	/** Time the session was actually working inside that window. */
	activeMs: number;
	finishedTurns: number;
	children: DutyLogChild[];
	incidents: DutyIncident[];
	pending: DutyLogPending[];
	/** The last turn stopped on a plan it did not carry out. */
	unfinished?: string;
	lastDoing?: string;
}

export interface DutyLogInput {
	entries: readonly unknown[];
	now: number;
	children?: readonly DutyLogChild[];
}

/** Gaps longer than this between two transcript events count as idle, not work. */
const IDLE_GAP_MS = 10 * 60_000;
const TEXT_PREVIEW_CHARS = 40;
/** A stuck-step entry this close to a `tool_timeout:` result describes the same stall. */
const STUCK_DEDUP_MS = 5 * 60_000;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
	return value && typeof value === "object" ? (value as Json) : undefined;
}

function entryTime(entry: Json): number | undefined {
	const message = asRecord(entry.message);
	const raw = message?.timestamp ?? entry.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const record = asRecord(block);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("")
		.trim();
}

function hasToolCall(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => asRecord(block)?.type === "toolCall");
}

/** A custom message, whether stored as a `custom_message` entry or a `role: "custom"` message. */
function customOf(entry: Json): { customType: string; details: Json | undefined } | undefined {
	if (entry.type === "custom_message" && typeof entry.customType === "string") {
		return { customType: entry.customType, details: asRecord(entry.details) };
	}
	const message = asRecord(entry.message);
	if (entry.type === "message" && message?.role === "custom" && typeof message.customType === "string") {
		return { customType: message.customType, details: asRecord(message.details) };
	}
	return undefined;
}

const QUOTA_ERROR = /quota|余额|额度|insufficient.?balance|billing|usage limit/i;
const STALL_ABORT = /stall|watchdog|卡住|无响应/i;
const PLAN_ENDING =
	/(?:让我|我(?:先|再|来|将|会|去)|接下来|下一步|然后我|let me|i(?:'ll| will)|next,? i)[^。.!！?？]{0,80}[:：…。.]?\s*$/i;
const DECISION_ASK = /[?？]\s*$|需要你|请(?:你)?确认|要不要|是否(?:要|需要|同意)|你(?:来)?(?:定|决定|选)|请告诉我|等你/;

function preview(text: string, chars = TEXT_PREVIEW_CHARS): string {
	// Markdown markers read as noise in a one-line recap.
	const flat = text
		.replace(/\*\*|__|`/g, "")
		.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+\.\s+)/gm, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[：:]$/, "");
	return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

/** The sentence of a final answer that asks the owner something. */
function decisionSentence(text: string): string | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!DECISION_ASK.test(flat)) return undefined;
	const sentences = flat.split(/(?<=[。！!？?])\s*/).filter((part) => part.trim());
	const asking = sentences.reverse().find((sentence) => DECISION_ASK.test(sentence)) ?? flat;
	return preview(asking.replace(/^[-*•\s]+/, ""));
}

function isOwnerMessage(entry: Json): boolean {
	const message = asRecord(entry.message);
	return entry.type === "message" && message?.role === "user";
}

class IncidentLedger {
	private readonly byKind = new Map<DutyIncidentKind, DutyIncident>();

	add(kind: DutyIncidentKind, handled: boolean): DutyIncident {
		const incident = this.byKind.get(kind) ?? { kind, count: 0, handled: 0 };
		incident.count += 1;
		if (handled) incident.handled += 1;
		this.byKind.set(kind, incident);
		return incident;
	}

	get(kind: DutyIncidentKind): DutyIncident | undefined {
		return this.byKind.get(kind);
	}

	list(): DutyIncident[] {
		return [...this.byKind.values()];
	}
}

/**
 * What happened since the owner's last own message. Returns undefined when
 * the session did nothing in that window (no assistant activity at all).
 */
export function summarizeDutyLog(input: DutyLogInput): DutyLogSummary | undefined {
	const entries = input.entries.map(asRecord).filter((entry): entry is Json => entry !== undefined);
	let start = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry && isOwnerMessage(entry)) {
			start = index + 1;
			break;
		}
	}
	const ownerEntry = start > 0 ? entries[start - 1] : undefined;
	const windowEntries = entries.slice(start);
	const firstTime = (ownerEntry && entryTime(ownerEntry)) ?? windowEntries.map(entryTime).find((t) => t !== undefined);

	const incidents = new IncidentLedger();
	const pending: DutyLogPending[] = [];
	const seenQuestions = new Set<string>();
	const addPending = (question: string, at: number) => {
		if (seenQuestions.has(question)) return;
		seenQuestions.add(question);
		pending.push({ question, at });
	};
	const stalledChildren = new Set<string>();
	let activeMs = 0;
	let previousTime: number | undefined;
	let finishedTurns = 0;
	let sawAssistant = false;
	let outageStart: number | undefined;
	let lastFinalText: string | undefined;
	let lastEventWasFinal = false;
	let lastStatus: string | undefined;
	let goalStatus: string | undefined;
	let lastModelBeforeError: string | undefined;
	let lastStuckAt: number | undefined;

	const closeOutage = (at: number) => {
		if (outageStart === undefined) return;
		const incident = incidents.get("provider") ?? incidents.get("quota");
		if (incident) incident.downtimeMs = (incident.downtimeMs ?? 0) + Math.max(0, at - outageStart);
		outageStart = undefined;
	};

	for (const entry of windowEntries) {
		const at = entryTime(entry) ?? previousTime ?? 0;
		if (entry.type === "message") {
			if (previousTime !== undefined && at - previousTime <= IDLE_GAP_MS) activeMs += Math.max(0, at - previousTime);
			previousTime = at;
		}
		const message = asRecord(entry.message);
		const custom = customOf(entry);

		if (entry.type === "message" && message?.role === "assistant") {
			sawAssistant = true;
			const stopReason = message.stopReason;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
			if (stopReason === "error") {
				incidents.add(QUOTA_ERROR.test(errorMessage) ? "quota" : "provider", false);
				outageStart ??= at;
				lastModelBeforeError ??= typeof message.model === "string" ? message.model : undefined;
				lastEventWasFinal = false;
				continue;
			}
			if (stopReason === "aborted") {
				if (STALL_ABORT.test(errorMessage)) incidents.add("stall", true);
				lastEventWasFinal = false;
				continue;
			}
			// A successful answer ends an outage; the errors before it were recovered.
			if (outageStart !== undefined) {
				for (const kind of ["provider", "quota"] as const) {
					const incident = incidents.get(kind);
					if (incident) incident.handled = incident.count;
				}
				const model = typeof message.model === "string" ? message.model : undefined;
				const provider = incidents.get("provider");
				if (provider && model && lastModelBeforeError && model !== lastModelBeforeError) {
					provider.fallbackTo ??= model;
				}
				closeOutage(at);
				lastModelBeforeError = undefined;
			}
			if (stopReason === "stop" && !hasToolCall(message.content)) {
				finishedTurns += 1;
				const text = textOf(message.content);
				if (text) {
					lastFinalText = text;
					const question = decisionSentence(text);
					if (question) addPending(question, at);
				}
				lastEventWasFinal = true;
			} else {
				lastEventWasFinal = false;
			}
			continue;
		}

		if (entry.type === "message" && message?.role === "toolResult") {
			const text = textOf(message.content);
			if (text.startsWith("tool_timeout:")) {
				incidents.add("stuck", true);
				lastStuckAt = at;
			}
			lastEventWasFinal = false;
			continue;
		}

		if (custom) {
			const details = custom.details;
			const child = typeof details?.sessionName === "string" ? details.sessionName : undefined;
			switch (custom.customType) {
				case "empty_response_recovery":
					incidents.add("empty", true);
					break;
				case "system_interruption":
				case "stall_recovery_escalation":
					incidents.add("stall", true);
					break;
				case "rlm_child_stall_notice":
					if (child && !stalledChildren.has(child)) {
						stalledChildren.add(child);
						incidents.add("child_stuck", false);
					}
					break;
				case "rlm_child_recovery_action": {
					const incident = child && stalledChildren.has(child) ? incidents.get("child_stuck") : undefined;
					if (incident && incident.handled < incident.count) incident.handled += 1;
					else if (!incident) incidents.add("child_stuck", true);
					break;
				}
				case "rlm_child_failure":
					incidents.add("child_failed", false);
					break;
				case "rlm_child_terminal_notice":
					if (details?.kind === "completed_without_reply") incidents.add("child_silent", true);
					break;
			}
			continue;
		}

		if (entry.type === "custom") {
			const data = asRecord(entry.data);
			if (entry.customType === "provider_quota_park") {
				incidents.add("quota", true);
				continue;
			}
			if (entry.customType === "thread_goal_state" && typeof data?.status === "string") {
				goalStatus = data.status;
				continue;
			}
			if (entry.customType !== DUTY_EVENT_CUSTOM_TYPE) continue;
			const event = parseDutyEvent(entry.data);
			if (!event) continue;
			switch (event.kind) {
				case "provider_retry":
					// The failed request itself already counted when its error landed; a
					// retry without a persisted error still is one outage.
					if (!incidents.get("provider")) incidents.add("provider", false);
					outageStart ??= at;
					break;
				case "model_fallback": {
					const kind = event.reason === "bad_tool_calls" ? "bad_calls" : "provider";
					const incident = incidents.get(kind) ?? incidents.add(kind, true);
					incident.fallbackTo = event.to;
					incident.restoredTo = undefined;
					break;
				}
				case "model_restored":
					for (const kind of ["provider", "bad_calls"] as const) {
						const incident = incidents.get(kind);
						if (incident?.fallbackTo) incident.restoredTo = event.to;
					}
					break;
				case "step_stuck_stopped":
					// The stop usually also lands as a `tool_timeout:` result: one stall, one count.
					if (lastStuckAt === undefined || at - lastStuckAt > STUCK_DEDUP_MS) incidents.add("stuck", true);
					lastStuckAt = at;
					break;
				case "auto_continue":
					incidents.add("early_stop", true);
					break;
				case "child_auto_delivered":
					incidents.add("child_silent", true);
					break;
				case "decision_needed":
					addPending(preview(event.question), at);
					break;
			}
			continue;
		}

		if (entry.type === "agent_status") {
			const status = asRecord(entry.status);
			if (typeof status?.summary === "string" && status.summary.trim()) lastStatus = status.summary.trim();
		}
	}

	if (!sawAssistant && incidents.list().length === 0) return undefined;

	if (goalStatus === "paused" || goalStatus === "budget_limited" || goalStatus === "error") {
		const reason = goalStatus === "paused" ? "已暂停" : goalStatus === "budget_limited" ? "预算用完" : "出错停下";
		addPending(`长期目标${reason}，要不要继续`, previousTime ?? input.now);
	}

	const summary: DutyLogSummary = {
		awayMs: Math.max(0, input.now - (firstTime ?? input.now)),
		activeMs,
		finishedTurns,
		children: [...(input.children ?? [])],
		incidents: incidents.list(),
		pending,
	};
	if (lastEventWasFinal && lastFinalText && PLAN_ENDING.test(lastFinalText) && !decisionSentence(lastFinalText)) {
		summary.unfinished = preview(
			lastFinalText
				.split(/\n/)
				.filter((line) => line.trim())
				.at(-1) ?? lastFinalText,
		);
	}
	const doing = lastStatus ?? (lastFinalText ? preview(lastFinalText.split(/(?<=[。！!？?\n])/)[0] ?? "") : undefined);
	if (doing) summary.lastDoing = doing;
	return summary;
}

/** Newest bytes of a transcript read for the log; the window it needs sits at the end. */
const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * The newest entries of a session transcript, parsed tolerantly. Only the
 * tail is read, so a huge session costs a bounded read; a cut first line and
 * unparsable lines are skipped.
 */
export async function readDutyLogEntries(sessionFile: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<unknown[]> {
	const size = (await stat(sessionFile)).size;
	const offset = Math.max(0, size - maxBytes);
	const handle = await open(sessionFile, "r");
	try {
		const buffer = Buffer.alloc(size - offset);
		await handle.read(buffer, 0, buffer.length, offset);
		const lines = buffer.toString("utf8").split("\n");
		if (offset > 0) lines.shift();
		const entries: unknown[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (asRecord(parsed)?.type !== "session") entries.push(parsed);
			} catch {
				// A torn or foreign line is not an entry.
			}
		}
		return entries;
	} finally {
		await handle.close();
	}
}

/** `不到 1 分钟`, `25 分钟`, `3 小时 10 分`, `2 天 4 小时`. */
export function formatDutyDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "不到 1 分钟";
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest > 0 ? `${days} 天 ${rest} 小时` : `${days} 天`;
}

const INCIDENT_ORDER: readonly DutyIncidentKind[] = [
	"provider",
	"quota",
	"empty",
	"stuck",
	"bad_calls",
	"stall",
	"early_stop",
	"child_silent",
	"child_stuck",
	"child_failed",
];

function incidentText(incident: DutyIncident): string {
	const all = incident.handled >= incident.count;
	const none = incident.handled === 0;
	const n = incident.count;
	const outcome = (handled: string, open: string): string =>
		all ? handled : none ? open : `${incident.handled} 次${handled}，${n - incident.handled} 次${open}`;
	switch (incident.kind) {
		case "provider": {
			const facts: string[] = [];
			if (incident.downtimeMs && incident.downtimeMs >= 60_000)
				facts.push(`停了 ${formatDutyDuration(incident.downtimeMs)}`);
			if (incident.fallbackTo) facts.push(fallbackText(incident));
			if (facts.length === 0) facts.push(outcome("已自动重试成功", "还没恢复"));
			else if (!all) facts.push("还没恢复");
			return `服务器报错 ${n} 次（${facts.join("，")}）`;
		}
		case "quota":
			return `额度用完 ${n} 次（${outcome("到点自动恢复", "还在等额度")}）`;
		case "empty":
			return `空回复 ${n} 次（已重试）`;
		case "stuck":
			return `命令卡住 ${n} 次（已停掉，AI 换了办法）`;
		case "bad_calls":
			return `工具调用连续出错 ${n} 次（${incident.fallbackTo ? fallbackText(incident) : "已处理"}）`;
		case "stall":
			return `会话卡住 ${n} 次（已自动处理）`;
		case "early_stop":
			return `提早停下 ${n} 次（已自动继续）`;
		case "child_silent":
			return `子代理做完没回话 ${n} 次（已把结果交回）`;
		case "child_stuck":
			return `子代理卡住 ${n} 次（${outcome("已处理", "还没处理")}）`;
		case "child_failed":
			return `子代理出错 ${n} 次`;
	}
}

function isOpen(incident: DutyIncident): boolean {
	return incident.kind === "child_failed" || incident.handled < incident.count;
}

/** `bailian/kimi-k3` reads as `kimi-k3`: the owner knows models by name. */
function modelName(reference: string): string {
	return reference.slice(reference.indexOf("/") + 1);
}

function fallbackText(incident: DutyIncident): string {
	const to = modelName(incident.fallbackTo ?? "");
	return incident.restoredTo ? `中途换过 ${to}，已换回 ${modelName(incident.restoredTo)}` : `自动换到 ${to}`;
}

const CHILD_STATE_LABELS: Record<DutyLogChildState, string> = {
	done: "完成",
	running: "运行中",
	idle: "空闲",
	stalled: "卡住",
	failed: "出错",
};

/**
 * The log as plain Chinese lines (no styling), at most six. The first line
 * is the title; the caller decides how to style and where to place them.
 */
export function formatDutyLog(summary: DutyLogSummary, now: number): string[] {
	const lines = [`值班记录 · 离开 ${formatDutyDuration(summary.awayMs)}`];

	const worked = formatDutyDuration(summary.activeMs);
	const work = [`干了${worked.startsWith("不到") ? "" : " "}${worked}`, `完成 ${summary.finishedTurns} 轮`];
	if (summary.children.length > 0) {
		const counts = new Map<DutyLogChildState, number>();
		for (const child of summary.children) counts.set(child.state, (counts.get(child.state) ?? 0) + 1);
		const parts = (Object.keys(CHILD_STATE_LABELS) as DutyLogChildState[])
			.filter((state) => counts.has(state))
			.map((state) => `${counts.get(state)} ${CHILD_STATE_LABELS[state]}`);
		work.push(`子代理 ${summary.children.length} 个（${parts.join(" · ")}）`);
	}
	lines.push(work.join(" · "));

	const incidents = [...summary.incidents].sort(
		(a, b) => INCIDENT_ORDER.indexOf(a.kind) - INCIDENT_ORDER.indexOf(b.kind),
	);
	if (incidents.length === 0) {
		lines.push("没出问题");
	} else {
		const total = incidents.reduce((sum, incident) => sum + incident.count, 0);
		const open = incidents.filter(isOpen).length;
		const head = open === 0 ? `出问题 ${total} 次，都已自动处理` : `出问题 ${total} 次，有 ${open} 类还没处理`;
		lines.push(`${head}：${incidents.map(incidentText).join(" · ")}`);
	}

	if (summary.pending.length > 0) {
		const first = summary.pending[0] as DutyLogPending;
		const more = summary.pending.length > 1 ? " 等" : "";
		lines.push(
			`需要你拍板：${summary.pending.length} 件 —— 「${first.question}」${more}（${agoText(first.at, now)}）`,
		);
	}
	if (summary.unfinished) lines.push(`可能没做完：最后停在「${summary.unfinished}」`);
	if (summary.lastDoing && lines.length < 6) lines.push(`最后在做：${summary.lastDoing}`);
	return lines.slice(0, 6);
}

function agoText(at: number, now: number): string {
	const ms = Math.max(0, now - at);
	return ms < 60_000 ? "刚刚" : `${formatDutyDuration(ms)}前`;
}
