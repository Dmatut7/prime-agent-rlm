/**
 * Best-effort removal of credential material from text that leaves the process.
 *
 * Two sinks keep text long after the request that produced it: the structured log
 * (`~/.prime/agent/logs/agent.jsonl`) and the assistant-message diagnostics that are
 * persisted into the session transcript. Both can carry a provider error body
 * verbatim, and providers do echo the credential back on auth failures
 * ("Incorrect API key provided: sk-...", a forwarded `Authorization` header, or a
 * base URL with userinfo). Redaction is the last line of defence in front of them.
 *
 * This is a safety net, not a classifier: it rewrites the shapes a secret takes in
 * these payloads and leaves everything else alone, so the diagnostic still says what
 * failed, which provider code came back, the status and the request id. Callers that
 * already know the exact secret value pass it in `secrets` and every occurrence is
 * replaced literally.
 */

export const REDACTED = "[REDACTED]";

/** Minimum length for an exactly-known secret to be replaced as a literal. */
const MIN_KNOWN_SECRET_LENGTH = 6;

/**
 * Key names whose value is a credential. Matched as `key: value` / `key=value`, with
 * an optional JSON quote and an optional `Bearer` prefix consumed from the value.
 */
const CREDENTIAL_KEY_VALUE =
	/\b(authorization|proxy-authorization|api[-_]?key|x-api[-_]?key|apikey|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|consumer[-_]?secret|secret[-_]?key|secret|password|passwd|pass|token|bearer|credential)\b("?\s*[:=]\s*"?)((?:bearer|basic|token)\s+)?([^\s"'`,;)\]}&\\]+)/gi;

/** `Bearer <token>` anywhere, including inside a value the key pattern did not reach. */
const BEARER_VALUE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/** Known credential prefixes: the shapes a key keeps when nothing names it. */
const CREDENTIAL_SHAPES =
	/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_[A-Za-z0-9]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}|(?:EAA|IGQV)[A-Za-z0-9_-]{20,})\b/g;

/** JWTs: three base64url segments, which is how an OAuth access token looks. */
const JSON_WEB_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** `scheme://user:password@host` - the credential is the userinfo, the host is the diagnosis. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]{1,256})@/gi;

/**
 * Query/header style assignments whose key name did not make the credential list but
 * whose value is obviously opaque: long base64url-ish runs handed to `key=`, `token=`,
 * `sig=`, `secret=`. Length-bounded so ordinary prose and ids survive.
 */
const OPAQUE_ASSIGNMENT = /\b((?:key|token|secret|sig|signature|password|credential)=)([A-Za-z0-9._~+/=-]{20,})/gi;

export interface RedactOptions {
	/** Exact secret values (already known to the caller) to replace literally. */
	secrets?: Iterable<string> | undefined;
}

export function redactSecrets(text: string, options?: RedactOptions | Iterable<string>): string {
	if (!text) return text;
	const secrets =
		options === undefined
			? undefined
			: "secrets" in (options as RedactOptions)
				? (options as RedactOptions).secrets
				: (options as Iterable<string>);

	let redacted = text
		.replace(BEARER_VALUE, `$1${REDACTED}`)
		.replace(CREDENTIAL_KEY_VALUE, (_match, key: string, separator: string, scheme: string | undefined) => {
			// Keep the header name and the `Bearer`/`Basic` scheme: the diagnostic still
			// shows that a credential was sent, only not which one.
			return `${key}${separator}${scheme ?? ""}${REDACTED}`;
		})
		.replace(JSON_WEB_TOKEN, REDACTED)
		.replace(CREDENTIAL_SHAPES, REDACTED)
		.replace(URL_USERINFO, `$1${REDACTED}@`)
		.replace(OPAQUE_ASSIGNMENT, `$1${REDACTED}`);

	if (secrets !== undefined) {
		for (const secret of secrets) {
			if (typeof secret !== "string" || secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
			redacted = redacted.split(secret).join(REDACTED);
		}
	}
	return redacted;
}

/**
 * Redact a structured log entry's string fields, including `msg`.
 *
 * Walks a bounded tree: the entry itself, its fields and two more levels, at most
 * `MAX_VISITED` nodes total. Log entries are small by contract and this runs on every
 * emitted line, so the bound keeps a pathological payload from making logging the
 * bottleneck; anything past the bound is replaced by a placeholder rather than passed
 * through, because "unredacted" is the one outcome this must not produce.
 */
const MAX_LOG_FIELD_DEPTH = 4;
const MAX_VISITED_NODES = 200;

export function redactLogEntryFields<T extends Record<string, unknown>>(entry: T, secrets?: Iterable<string>): T {
	const options = secrets === undefined ? undefined : { secrets };
	let visited = 0;
	const walk = (value: unknown, depth: number): unknown => {
		if (++visited > MAX_VISITED_NODES) return REDACTED;
		if (typeof value === "string") return redactSecrets(value, options);
		if (value === null || typeof value !== "object") return value;
		if (depth >= MAX_LOG_FIELD_DEPTH) return REDACTED;
		if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
		if (value instanceof Date || value instanceof Error) return value;
		const source = value as Record<string, unknown>;
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(source)) {
			copy[key] = walk(source[key], depth + 1);
		}
		return copy;
	};
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(entry)) {
		result[key] = walk(entry[key], 1);
	}
	return result as T;
}
