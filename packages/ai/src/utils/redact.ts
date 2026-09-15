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

/** `REDACTED` without its closing bracket: what a value class that stops at `]` leaves behind. */
const REDACTED_HEAD = REDACTED.slice(0, -1);

/**
 * Key names whose value is a credential. Matched as `key: value` / `key=value`, with
 * an optional JSON quote and an optional `Bearer`/`Basic`/`Token` prefix consumed from
 * the value. A value that already starts with the placeholder is left alone by the
 * callback below, so a text that went through redaction once is not rewritten again.
 */
const CREDENTIAL_KEY_VALUE =
	/\b(authorization|proxy-authorization|api[-_]?key|x-api[-_]?key|apikey|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|consumer[-_]?secret|secret[-_]?key|secret|password|passwd|pass|token|bearer|credential)\b("?\s*[:=]\s*"?)((?:bearer|basic|token)\s+)?([^\s"'`,;)\]}&\\]+)/gi;

/**
 * `Bearer <token>` anywhere, including inside a value the key pattern did not reach.
 * Bearer keeps its original `{6,}` threshold; the other schemes go through
 * AUTH_SCHEME_VALUE below, which is stricter so prose like "basic information" survives.
 */
const BEARER_VALUE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * Authentication schemes other than `Bearer` that hand the credential over verbatim, and
 * the value that follows them. Covers custom header values the key table cannot name,
 * e.g. `"X-Custom-Auth": "Token 40b7..."` or `Proxy-Auth: Basic dXNl...`.
 */
const AUTH_SCHEME_VALUE =
	/\b((?:basic|token|digest|hoba|gnut|ntlm|negotiate|mta|oauth|aws4-hmac-sha256|steamlake|gn2-gn-none)\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * A value behind a scheme name other than `Bearer` is only credential material when it is
 * not an ordinary word: it must carry a digit or a separator symbol, or be at least this
 * long. Sixteen sits above every English word that turns up next to these scheme names in
 * a provider error ("information" is 11, "authentication" is 14) and below any real token.
 */
const CREDENTIAL_LENGTH = 16;

/** Digits and separators: absent from a prose word, everywhere in an encoded credential. */
const CREDENTIAL_SYMBOL = /[0-9._~+/=-]/;

function isCredentialRun(value: string): boolean {
	return value.length >= CREDENTIAL_LENGTH || CREDENTIAL_SYMBOL.test(value);
}

/** Known credential prefixes: the shapes a key keeps when nothing names it. */
const CREDENTIAL_SHAPES =
	/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_[A-Za-z0-9]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}|(?:EAA|IGQV)[A-Za-z0-9_-]{20,})\b/g;

/** JWTs: three base64url segments, which is how an OAuth access token looks. */
const JSON_WEB_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Cookie names that carry a session or a credential. Matched as one `.`/`-`/`_`-separated
 * segment of a cookie name, case-insensitively, so `__Secure-session_id` and `JSESSIONID`
 * hit while `author`, `consider`, `consent` or `passbook` do not.
 */
const COOKIE_SECRET_NAME =
	/(?:^|[^A-Za-z0-9])(?:session|sessions|sess|sid|jsessionid|phpsessid|asp[._]net[._]sessionid|connect[._]sid|auth|authz|authorization|authentication|token|jwt|ticket|secret|secrets|credential|credentials|password|passwd|pwd|pass|login|apikey|api_key|access_key|csrf|xsrf|nonce|signature|sig)(?:$|[^A-Za-z0-9])/i;

/**
 * A `Cookie` / `Set-Cookie` header and its value: `Cookie: a=1; b=2` in a plain header
 * dump, or `"cookie": "a=1; b=2"` inside a JSON-serialized header map. Two value shapes,
 * because a quote means a different thing in each:
 * - JSON-serialized: the value is wrapped in the string's own quotes, and a cookie value
 *   holding a quote reaches the log escaped (`"cookie": "session=\"abc\""`). The quoted
 *   branch consumes both wrapper quotes and lets `\x` escapes through, so the match ends
 *   at the closing wrapper quote and the line stays parseable JSON.
 * - plain header dump: quotes belong to the cookie values themselves (`session="v"`), so
 *   the unquoted branch admits whole quoted runs while still stopping at a bare quote or
 *   a line end.
 * Each alternative consumes at least one character per step, so scanning a long header
 * stays linear, not quadratic.
 */
const COOKIE_HEADER_VALUE =
	/\b((?:set-cookie|cookie)\b"?\s*[:=]\s*)(?:"((?:\\.|[^"\\\r\n])*)"|((?:[^"\r\n]|"(?:\\.|[^"\\])*")*))/gi;

/**
 * One `name=value` pair inside a cookie header. The value is either a quoted run - bare
 * in a plain header (`session="v"`) or backslash-escaped in serialized JSON
 * (`session=\"abc\"`) - or an unquoted run that stops at whitespace, `;`, `,` or a quote.
 * Consuming the whole quoted/escaped run is what lets the pair rule wash the value inside
 * it instead of stopping at the first quote.
 */
const COOKIE_PAIR = /([A-Za-z0-9!#$%&'*+.^_`|~-]{1,256})(\s*=\s*)("(?:\\.|[^"\\])*"|(?:\\.|[^\\"\s;,])*)/g;

/**
 * `Set-Cookie` attributes. They name the cookie's scope, not a credential, so a long
 * `Domain=` or an opaque-looking `Expires=` value must survive the opaque rule.
 */
const COOKIE_ATTRIBUTE_NAME =
	/^(?:path|domain|expires|max-age|maxage|samesite|same-site|httponly|secure|partitioned|priority)$/i;

/** `scheme://user:password@host` - the password is the credential, the user and host are the diagnosis. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]{1,256})?(:([^\s/@]*))?@/gi;

/** Character set of an opaque credential run: base64/base64url/hex plus `.`/`~`/`=`/`-`. */
const OPAQUE_RUN_CLASS = "[A-Za-z0-9._~+/=-]";

/** Below this length a run of that class is an id, a counter or a word, not a token. */
const OPAQUE_RUN_MIN_LENGTH = 20;

/**
 * Query/header style assignments whose key name did not make the credential list but
 * whose value is obviously opaque: long base64url-ish runs handed to `key=`, `token=`,
 * `sig=`, `secret=`, `session=`, `auth=`. Length-bounded so ordinary prose and ids
 * survive. The optional `qualifier_`/`qualifier-` prefix lets compound names such as
 * `access_key=` or `proxy_session_id=` reach this fallback too; requiring the separator
 * keeps an ordinary word that ends in one of these names (`monkey=`) out of it.
 */
const OPAQUE_ASSIGNMENT = new RegExp(
	`\\b((?:[A-Za-z0-9]{1,64}[-_])?(?:key|apikey|api_key|token|secret|sig|signature|password|passwd|credential|session|sessionid|session_id|sid|jsessionid|phpsessid|access_key|refresh_key|auth|authorization|authz|otp|passcode|verification)=)(${OPAQUE_RUN_CLASS}{${OPAQUE_RUN_MIN_LENGTH},})`,
	"gi",
);

/**
 * `session=<value>` and its family outside a cookie header. A session id is routinely a
 * short plain run, so the 20-character opaque bar never fires for it; these keys get
 * their own lower bar of eight characters. Below that the value is a counter or a short
 * id (a false positive that would wash real diagnostics), and a bare run with no `key=`
 * prefix keeps the opaque bar.
 */
const SESSION_ASSIGNMENT_MIN_LENGTH = 8;

const SESSION_ASSIGNMENT = new RegExp(
	`\\b((?:[A-Za-z0-9]{1,64}[-_])?(?:session|sessions|sess|sessionid|session_id|sid|jsessionid|phpsessid|connect[._]sid)=)(${OPAQUE_RUN_CLASS}{${SESSION_ASSIGNMENT_MIN_LENGTH},})`,
	"gi",
);

/** A whole value that is nothing but an opaque run of credential length. */
const OPAQUE_RUN = new RegExp(`^${OPAQUE_RUN_CLASS}{${OPAQUE_RUN_MIN_LENGTH},}$`);

/**
 * Wash the value of a single cookie pair. A cookie whose name says session or credential
 * always loses its value; any other cookie only loses it when the value is a long opaque
 * run, the same bar `OPAQUE_ASSIGNMENT` applies to query parameters. Names, attributes
 * (`Path`, `Domain`, `Expires`, `Max-Age`, `SameSite`) and ordinary values such as
 * `theme=dark` stay: which cookies were sent is the actionable half of a cookie header,
 * and washing the whole value would turn every one of them into `[REDACTED]` noise.
 */
function redactCookiePair(name: string, separator: string, value: string): string {
	if (value === REDACTED || value === "" || COOKIE_ATTRIBUTE_NAME.test(name)) return `${name}${separator}${value}`;
	if (COOKIE_SECRET_NAME.test(name) || isOpaqueRun(value)) return `${name}${separator}${REDACTED}`;
	return `${name}${separator}${value}`;
}

/** `true` when a value is a base64url-ish run long enough that only a token looks like it. */
function isOpaqueRun(value: string): boolean {
	return OPAQUE_RUN.test(value);
}

/** A full cookie header: pair by pair, so the names survive. */
function redactCookieValue(value: string): string {
	return value.replace(COOKIE_PAIR, (_match, name: string, separator: string, pairValue: string) =>
		redactCookiePair(name, separator, pairValue),
	);
}

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
		.replace(
			COOKIE_HEADER_VALUE,
			(_match, header: string, jsonValue: string | undefined, plainValue: string | undefined) =>
				jsonValue === undefined
					? `${header}${redactCookieValue(plainValue ?? "")}`
					: `${header}"${redactCookieValue(jsonValue)}"`,
		)
		// The key rule runs before the bearer/scheme rules: it consumes the `Bearer` prefix
		// itself, so the placeholder it writes is never re-matched by them (their value
		// class cannot start at `[`), and the output stays idempotent.
		.replace(
			CREDENTIAL_KEY_VALUE,
			(match: string, key: string, separator: string, scheme: string | undefined, value: string) => {
				// A previous rule in this very pass (or an earlier pass over the same text)
				// already put a placeholder here: the value class stops at the closing
				// bracket, so rewriting it would append a stray one.
				if (value.startsWith(REDACTED_HEAD)) return match;
				// Keep the header name and the `Bearer`/`Basic` scheme: the diagnostic still
				// shows that a credential was sent, only not which one.
				return `${key}${separator}${scheme ?? ""}${REDACTED}`;
			},
		)
		.replace(BEARER_VALUE, `$1${REDACTED}`)
		.replace(AUTH_SCHEME_VALUE, (match: string, scheme: string, value: string) =>
			isCredentialRun(value) ? `${scheme}${REDACTED}` : match,
		)
		.replace(JSON_WEB_TOKEN, REDACTED)
		.replace(CREDENTIAL_SHAPES, REDACTED)
		.replace(
			URL_USERINFO,
			(_match, scheme: string, user: string | undefined, withPassword?: string, password?: string) => {
				// A password (even empty) means the user slot holds a credential too: the
				// npm/Git "token in the user slot" idiom is `https://<token>:@host`.
				if (password) return `${scheme}${user ?? ""}:${REDACTED}@`;
				if (withPassword !== undefined) return `${scheme}${REDACTED}:@`;
				return `${scheme}${user ?? ""}@`;
			},
		)
		.replace(OPAQUE_ASSIGNMENT, `$1${REDACTED}`)
		.replace(SESSION_ASSIGNMENT, `$1${REDACTED}`);

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
