import { getLogger } from "../log.js";
import type { AssistantMessage } from "../types.js";
import { appendAssistantMessageDiagnostic, extractDiagnosticError } from "./diagnostics.js";
import { redactSecrets } from "./redact.js";

/**
 * Shared classification and reporting for provider stream failures, so no
 * provider collapses a specific cause (refusal, safety filter, overload, ...)
 * into a generic string before it is logged and persisted.
 */

export type StreamFailureKind =
	| "refusal"
	| "safety"
	| "overloaded"
	| "rate_limit"
	| "quota"
	| "server_error"
	| "auth"
	| "permission"
	| "invalid_request"
	| "malformed_response"
	| "unknown";

export interface StreamFailureInfo {
	kind: StreamFailureKind;
	/** Provider's own error/stop identifier, e.g. "overloaded_error" or "SAFETY". */
	providerErrorType?: string;
	status?: number;
	requestId?: string;
	/** Server-requested wait before retrying (Retry-After header or reset info), in milliseconds. */
	retryAfterMs?: number;
	/** Truncated raw provider payload for post-mortems. */
	raw?: string;
}

export class StreamFailureError extends Error {
	readonly info: StreamFailureInfo;

	constructor(message: string, info: StreamFailureInfo) {
		super(message);
		this.name = "StreamFailureError";
		this.info = info;
	}
}

const KIND_MESSAGES: Record<StreamFailureKind, string> = {
	refusal: "Model refused to respond",
	safety: "Response blocked by provider safety filters",
	overloaded: "Provider overloaded",
	rate_limit: "Provider rate limit exceeded",
	quota: "Provider quota or account balance exhausted",
	server_error: "Provider server error",
	auth: "Provider authentication failed",
	permission: "Provider denied access to the requested resource",
	invalid_request: "Provider rejected the request",
	malformed_response: "Provider returned a malformed response",
	unknown: "Provider stream failed",
};

/** Build a user-facing message like "Provider overloaded (overloaded_error, 529) [request_id: req_abc]". */
export function streamFailureMessage(info: StreamFailureInfo, detail?: string): string {
	const qualifiers = [info.providerErrorType, info.status !== undefined ? String(info.status) : undefined]
		.filter(Boolean)
		.join(", ");
	let message = KIND_MESSAGES[info.kind];
	if (qualifiers) message += ` (${qualifiers})`;
	if (detail) message += `: ${detail}`;
	if (info.requestId) message += ` [request_id: ${info.requestId}]`;
	return message;
}

/**
 * Account-level exhaustion: an unpaid balance, a spent free tier, a quota the plan
 * no longer covers. Providers send these with 400/402/403 as often as 429 (Bailian
 * `Arrearage` is a 400, `AllocationQuota.FreeTierOnly` a 403), and read by status
 * alone they look like a bad request or a permission denial - a verdict that ends
 * the task, when moving to another model or waiting for a top-up is what helps.
 */
const QUOTA_EXHAUSTED_PATTERN =
	/arrearage|insufficient[_ ]?(?:quota|balance|credits?|funds)|free[_ .-]?tier|allocationquota|exceeded[^.]{0,30}quota|exceeded_current_quota|quota[^.]{0,15}(?:exceeded|exhausted|used up)|credit balance is too low|billing[_ ](?:hard[_ ]limit|not[_ ]active)|(?:account|bill)[_ ]?overdue|payment[_ ]required|余额不足|欠费|额度(?:已)?(?:用完|用尽|耗尽)/i;

/** Whether provider error text names an exhausted quota or balance rather than a malformed request. */
export function isProviderQuotaExhaustedText(text: string | undefined): boolean {
	return text !== undefined && QUOTA_EXHAUSTED_PATTERN.test(text);
}

export function classifyStreamFailure(providerErrorType?: string, status?: number): StreamFailureKind {
	const type = providerErrorType?.toLowerCase() ?? "";
	if (type === "refusal") return "refusal";
	if (
		/sensitive|safety|prohibited_content|blocklist|spii|recitation|content.?filter|guardrail|flagged|data.?inspection/.test(
			type,
		)
	) {
		return "safety";
	}
	if (status === 402 || isProviderQuotaExhaustedText(type)) return "quota";
	if (type.includes("overloaded") || status === 529) return "overloaded";
	// usage_not_included is Codex's plan-entitlement rejection, not bad credentials.
	if (/rate_limit|usage_limit|usage_not_included|throttl/.test(type) || status === 429) {
		return "rate_limit";
	}
	// Permission/403 shapes are entitlement or policy denials, not bad credentials: never auth-stale.
	if (/authentication|unauthorized/.test(type) || status === 401) return "auth";
	if (/permission|forbidden|access.?denied/.test(type) || status === 403) return "permission";
	if (type.includes("invalid_request") || type.includes("not_found_error") || status === 400 || status === 404) {
		return "invalid_request";
	}
	if (type.includes("malformed")) return "malformed_response";
	if (
		type.includes("api_error") ||
		type.includes("server_error") ||
		type.includes("unavailable") ||
		(status !== undefined && status >= 500)
	) {
		return "server_error";
	}
	return "unknown";
}

/**
 * Failure for a stream that terminated with a provider stop/finish reason that
 * maps to "error" (e.g. Anthropic "refusal", Gemini "SAFETY"). Providers call
 * this instead of throwing a generic error, so the raw reason survives.
 */
export function streamFailureFromStopReason(
	rawStopReason: string | undefined,
	extra?: Pick<StreamFailureInfo, "requestId">,
): StreamFailureError {
	const info: StreamFailureInfo = {
		kind: rawStopReason ? classifyStreamFailure(rawStopReason) : "unknown",
		providerErrorType: rawStopReason,
		requestId: extra?.requestId,
	};
	if (info.kind === "unknown" && /malformed/i.test(rawStopReason ?? "")) info.kind = "malformed_response";
	const message = rawStopReason
		? streamFailureMessage(info)
		: streamFailureMessage(info, "stream ended with an error and no stop reason");
	return new StreamFailureError(message, info);
}

const MAX_RAW_LENGTH = 2000;

export function truncateRawPayload(raw: string): string {
	return raw.length > MAX_RAW_LENGTH ? `${raw.slice(0, MAX_RAW_LENGTH)}…` : raw;
}

function extractStreamFailureParts(error: unknown): { info: StreamFailureInfo; detail?: string } {
	if (error instanceof StreamFailureError) return { info: error.info };
	if (!(error instanceof Error)) return { info: { kind: "unknown" } };

	const err = error as Error & {
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		requestID?: unknown;
		request_id?: unknown;
		headers?: unknown;
		error?: unknown;
		retryAfterMs?: unknown;
		$metadata?: { requestId?: unknown };
	};

	const status =
		typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined;

	// Error bodies come nested differently per SDK: Anthropic/OpenAI expose
	// `error.error = {type|code, message}` (sometimes doubly nested).
	let body = err.error as { type?: unknown; code?: unknown; message?: unknown; error?: unknown } | undefined;
	if (body && typeof body === "object" && body.error && typeof body.error === "object") {
		body = body.error as { type?: unknown; code?: unknown; message?: unknown };
	}
	const bodyType = body && typeof body === "object" ? (body.type ?? body.code) : undefined;
	const bodyMessage = body && typeof body === "object" ? body.message : undefined;
	const providerErrorType =
		typeof bodyType === "string"
			? bodyType
			: typeof err.code === "string"
				? err.code
				: err.name !== "Error" && err.name !== "StreamFailureError"
					? err.name
					: undefined;

	const headers = err.headers;
	const headerRequestId = headerValue(headers, "request-id") ?? headerValue(headers, "x-request-id");
	const rawRequestId = err.requestID ?? err.request_id ?? err.$metadata?.requestId ?? headerRequestId;
	const requestId = typeof rawRequestId === "string" ? rawRequestId : undefined;
	const retryAfterMs =
		typeof err.retryAfterMs === "number" && err.retryAfterMs >= 0 ? err.retryAfterMs : parseRetryAfterMs(headers);

	let kind = classifyStreamFailure(providerErrorType ?? error.message, status);
	// Message text is too weak for these verdicts: without a structured type, only the status decides.
	if ((kind === "auth" || kind === "permission") && providerErrorType === undefined) {
		kind = classifyStreamFailure(undefined, status);
	}

	return {
		info: {
			kind,
			providerErrorType,
			status,
			requestId,
			...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		},
		detail: typeof bodyMessage === "string" ? bodyMessage : undefined,
	};
}

function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	if (typeof (headers as Headers).get === "function") {
		return (headers as Headers).get(name) ?? undefined;
	}
	// Record-shaped headers must match case-insensitively, like real Headers.
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === name && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** Parse Retry-After / Retry-After-Ms headers into a millisecond wait. */
export function parseRetryAfterMs(headers: unknown): number | undefined {
	const ms = Number(headerValue(headers, "retry-after-ms"));
	if (Number.isFinite(ms) && ms >= 0) return ms;
	const raw = headerValue(headers, "retry-after");
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(raw);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Best-effort extraction of structured failure info from any thrown value:
 * StreamFailureError, provider SDK errors (Anthropic/OpenAI APIError, AWS SDK
 * exceptions, Google ApiError), or plain errors.
 */
export function extractStreamFailureInfo(error: unknown): StreamFailureInfo {
	return extractStreamFailureParts(error).info;
}

/**
 * User-facing message for a thrown stream error: a classified one-liner with
 * the provider's own short message, never the raw payload/trace. Unrecognized
 * errors pass through verbatim so their text (which downstream retry matching
 * may depend on) is preserved.
 */
export function formatStreamFailureMessage(error: unknown): string {
	// The returned string becomes `AssistantMessage.errorMessage`, which is persisted in
	// the session transcript and shown in the UI: redact before it leaves here, not at
	// each of the call sites that may be handed a provider body verbatim.
	if (error instanceof StreamFailureError) return redactSecrets(error.message);
	const { info, detail } = extractStreamFailureParts(error);
	if (info.kind === "unknown") {
		return redactSecrets(error instanceof Error ? error.message : JSON.stringify(error));
	}
	return redactSecrets(streamFailureMessage(info, detail));
}

const log = getLogger("ai.provider");

/**
 * Record a terminal stream failure on the message (structured diagnostic that
 * persists to session JSONL) and emit one structured log line. Call from the
 * provider's terminal catch after stopReason/errorMessage are set; no-op for
 * user-initiated aborts.
 */
export function recordStreamFailure(
	model: { provider: string; id: string; api: string },
	output: AssistantMessage,
	error: unknown,
): void {
	if (output.stopReason !== "error") return;
	const info = extractStreamFailureInfo(error);
	// The diagnostic and the message both reach the transcript. Provider bodies reach
	// this function verbatim (openai-completions assigns the thrown message straight to
	// errorMessage), so both are redacted here; the classified info that makes the
	// failure actionable - kind, provider code, status, request id - is not text and
	// survives untouched.
	const safeInfo: StreamFailureInfo = info.raw === undefined ? info : { ...info, raw: redactSecrets(info.raw) };
	appendAssistantMessageDiagnostic(output, {
		type: "provider_stream_failure",
		timestamp: Date.now(),
		error: extractDiagnosticError(error),
		details: { ...safeInfo },
	});
	if (output.errorMessage) output.errorMessage = redactSecrets(output.errorMessage);
	const rawMessage = error instanceof Error ? error.message : String(error);
	log.error("provider stream failure", {
		provider: model.provider,
		model: model.id,
		api: model.api,
		kind: info.kind,
		providerErrorType: info.providerErrorType,
		status: info.status,
		requestId: info.requestId,
		message: output.errorMessage,
		// errorMessage is user-facing and concise; keep the raw cause for debugging.
		cause: rawMessage === output.errorMessage ? undefined : truncateRawPayload(redactSecrets(rawMessage)),
	});
}
