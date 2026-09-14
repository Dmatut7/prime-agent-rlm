/**
 * Shape detectors behind the /share secret preflight.
 *
 * The preflight shipped as a six-entry prefix table, and the audit that led here ran it
 * against the credentials the machine actually holds: the live bailian key is `sk-ws-`
 * plus 110 characters that contain dots (the shipped class `[A-Za-z0-9_-]` stopped at the
 * first dot, four characters in, so it never reached its own length floor) and the grok
 * credential resolved from `~/.grok/auth.json` is an 882-character JWT. `/share` uploads
 * through `gh gist create --public=false`, and a secret gist is readable by anyone holding
 * the link, so every shape the table does not know is a live key leaving the machine.
 *
 * Three detector families, in the order a warning lists them:
 *
 * 1. `SHARE_SECRET_PATTERNS` — literal shapes: prefixes for the providers this repo uses
 *    and the common clouds, plus structural shapes (JWT, Bearer, Basic, PEM).
 * 2. `CREDENTIAL_ASSIGNMENT_TYPE` — the name-driven assignment shape `NAME=value`, which
 *    is what an environment dump (`ps eww`), a `.env` fragment or a log line looks like.
 *    It is the only family that catches a value whose shape is unknown but whose name is
 *    not.
 * 3. `HIGH_ENTROPY_TOKEN_TYPE` — an unknown-provider value: random-looking, sitting
 *    directly after a credential name, and not one of the benign encapsulated blobs a
 *    transcript carries (base64 image data, `encrypted_content`, signatures). The
 *    anchoring and the blob exclusions are calibrated against real transcripts; without
 *    them the rule fires on nearly every session, which is its own kind of failure.
 *
 * The fourth and strongest check lives in share-session.ts: an exact comparison against
 * the credential values this session has loaded, which no shape can hide from.
 */

/** A matched secret plus the non-secret context a warning may repeat back. */
export interface ShareSecretMatch {
	/** The secret text. Only ever handed to `maskSecretValue` before it is shown. */
	value: string;
	/** Offset of `value` inside the scanned text. */
	index: number;
	/** Non-secret identifier for the match: the environment variable name, say. */
	name?: string;
}

export interface ShareSecretDetector {
	/** Label shown in the warning; also the ordering key of the deduplicated result. */
	type: string;
	/**
	 * Whether this detector may read the uploaded export document. The document is a fixed
	 * template around a base64 encoding of the payload, so an entropy detector reading it
	 * would only ever match its own container; the payload is scanned separately.
	 */
	scansDocumentBytes: boolean;
	detect(text: string): ShareSecretMatch[];
}

export interface ShareSecretPattern {
	/** User-visible type label. Must not include matched content. */
	type: string;
	pattern: RegExp;
	/** Capture group holding the secret itself, when the match also covers a prefix. */
	valueGroup?: number;
}

/**
 * Literal shapes, in listing order. The first six keep the labels the preflight already
 * shipped, so a warning that listed them keeps reading the same; the rest cover the
 * families this repo and its neighbors actually use.
 */
export const SHARE_SECRET_PATTERNS: readonly ShareSecretPattern[] = [
	// One class for every `sk-` provider this repo talks to (OpenAI, DeepSeek, Moonshot,
	// OpenRouter `sk-or-v1-…`, Anthropic `sk-ant-…`, DashScope/bailian `sk-ws-…`). The dots
	// are the fix, not decoration: the live bailian key is `sk-ws-H.…` and a dot-less class
	// stops after four characters, below the length floor.
	{ type: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9_.-]{8,}/g },
	{ type: "AWS access key (AKIA)", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ type: "GitHub token (ghp_)", pattern: /\bghp_[A-Za-z0-9_]{20,}/g },
	{ type: "GitHub token (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
	{ type: "Bearer token", pattern: /\bBearer\s+([A-Za-z0-9._\-+/=]{8,})/gi, valueGroup: 1 },
	{ type: "PEM private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
	{ type: "AWS temporary key (ASIA)", pattern: /\bASIA[0-9A-Z]{16}\b/g },
	{ type: "GitHub token (gho_/ghu_/ghs_/ghr_)", pattern: /\bgh[ousr]_[A-Za-z0-9]{20,}/g },
	{ type: "GitLab token (glpat-)", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
	{ type: "Google API key (AIza)", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
	{ type: "Google OAuth token (ya29.)", pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ type: "Hugging Face token (hf_)", pattern: /\bhf_[A-Za-z0-9]{20,}/g },
	{ type: "Groq key (gsk_)", pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
	{ type: "xAI key (xai-)", pattern: /\bxai-[A-Za-z0-9]{20,}/g },
	{ type: "Slack token (xox)", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ type: "Stripe key (sk_live_/rk_live_)", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
	{ type: "SendGrid key (SG.)", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
	{ type: "Databricks token (dapi)", pattern: /\bdapi[0-9a-f]{28,}/g },
	{ type: "npm token (npm_)", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
	{ type: "PyPI token (pypi-)", pattern: /\bpypi-[A-Za-z0-9_-]{40,}/g },
	{ type: "JWT (three base64url segments)", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ type: "Basic auth header", pattern: /\bBasic\s+([A-Za-z0-9+/=]{16,})/g, valueGroup: 1 },
	{ type: "SSH/OpenSSH private key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g },
];

export const CREDENTIAL_ASSIGNMENT_TYPE = "Credential assignment";
export const HIGH_ENTROPY_TOKEN_TYPE = "High-entropy credential-like value";

/**
 * Name-driven assignment: `[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*`
 * followed by `=`/`:` and a value. Quoted JSON forms (`"EXA_API_KEY": "…"`) match too,
 * because a session transcript is mostly JSON. The value class stops at quotes, commas,
 * semicolons, backslashes and brackets, so a nested object is not swallowed as a value.
 */
const CREDENTIAL_NAME = /[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*/i;

const CREDENTIAL_ASSIGNMENT =
	/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)["']?\s*[=:]\s*["']?([^\s"',;\\{}[\]()<>]{8,})/g;

/**
 * Names that contain a credential word but never hold a secret. Without this an installed
 * toolchain is enough to make `/share` warn on every session.
 */
const BENIGN_CREDENTIAL_NAMES =
	/(?:PUBLIC_KEY|KEYBOARD|KEYCHAIN|KEY_?PATH|KEY_?FILE|KEY_?ID|KEY_?NAME|KEY_?TYPE|KEY_?ALGORITHM|KEY_?SIZE|KEY_?BINDING|MAX_TOKENS|TOKEN_?LIMIT|TOKEN_?COUNT|TOKENIZER|TOKENS_?USED|SECRET_?NAME|PASSWORD_?POLICY|STORAGE|LOCALSTORAGE|SESSIONSTORAGE|THEME|LAYOUT|WIDTH|HEIGHT|LOCALE|LANGUAGE|FONT|COLOR|VERSION|PLACEHOLDER|LABEL|TITLE)/i;

/** Whether a bare identifier is credential-named (`DASHSCOPE_API_KEY`, `mysql_password`). */
function isCredentialName(name: string): boolean {
	return CREDENTIAL_NAME.test(name) && !BENIGN_CREDENTIAL_NAMES.test(name);
}

/** A random-looking token only counts as a credential when a name sits right in front of it. */
const CREDENTIAL_ANCHOR =
	/(?:api[_-]?key|apikey|access[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|signing[_-]?key|encryption[_-]?key|refresh[_-]?token|authorization|bearer|token|secret|password|passwd|pwd|credential|key)\s*[=:"']{0,3}\s*$/i;

/**
 * Encapsulated blobs that real transcripts carry and that no viewer needs warned about:
 * base64 image data, provider-encrypted reasoning, signatures. Their bytes are
 * indistinguishable from a random key of the same length, so they are excluded by the
 * context that produces them rather than by their content.
 */
const BENIGN_BLOB_CONTEXT =
	/(?:encrypted[_-]?content|signature|thinking|;base64,|base64,|sha\d|checksum|digest|nonce|salt|screenshot|iVBOR|blob|octet-stream|content_?hash)/i;

/** How much text in front of a token is inspected for a credential name or blob context. */
const ANCHOR_WINDOW = 40;

const TOKEN_RUN = /[A-Za-z0-9_+./=-]{32,}/g;

/**
 * Length and entropy bounds, tuned against real transcripts rather than guessed: at 32
 * characters with 4 bits per character the rule sees a provider key, a JWT or a refresh
 * token, and the anchor plus the blob exclusions below are what keep it from seeing the
 * base64 of every screenshot in the session.
 */
const HIGH_ENTROPY_MIN_LENGTH = 32;
/**
 * Blob-scale runs are skipped rather than chopped: a 300 KB base64 blob becomes one run of
 * 300 KB, which fails this bound, while a JWT or a provider key stays well under it.
 */
const HIGH_ENTROPY_MAX_LENGTH = 512;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4;

const FILE_EXTENSION_TAIL =
	/\.(?:json|jsonl|ndjson|pem|key|crt|cer|txt|md|log|sh|bash|zsh|py|ts|tsx|js|jsx|mjs|cjs|html|htm|css|yaml|yml|toml|ini|conf|cfg|so|dylib|dll|exe|png|jpg|jpeg|gif|webp|svg|pdf|zip|gz|tar|db|sqlite|lock|env|bin|dmg|apk|deb|rpm|jar|class|map)$/i;

const PLACEHOLDER_VALUES =
	/^(?:password\d*|passw0rd|changeme|change[_-]?me|placeholder|redacted|secret|token|apikey|api[_-]?key|example|sample|dummy|your[_-].*|my[_-].*|todo|fixme|null|none|undefined|true|false)$/i;

function stripWrappingQuotes(value: string): string {
	return value.replace(/^["']+/, "").replace(/["']+$/, "");
}

/**
 * Whether a value is worth treating as a credential at all. Used by the comparison against
 * this session's loaded values and by the assignment detector, because the difference
 * between a credential and the prose around it is what decides whether the warning is read:
 * every placeholder here that was taken for a secret would warn on every session.
 */
export function isPlausibleSecretValue(raw: string): boolean {
	const value = stripWrappingQuotes(raw.trim());
	if (value.length < 8) return false;
	// Credentials are ASCII. A value carrying CJK text or full-width punctuation is a log line
	// or a sentence (`AUTH_JWT_SECRET: change_me，42`), and warnings that list prose stop being read.
	if (/[^\x20-\x7e]/.test(value)) return false;
	if (PLACEHOLDER_VALUES.test(value)) return false;
	if (/^\$/.test(value)) return false;
	// An all-caps identifier with underscores is a name, not a value: `${ANTHROPIC_API_KEY}`
	// survives the value class, and so do `@@FOREIGN_KEY_CHECKS` and `DATABASE_PASSWORD=PASSWORD_HERE`.
	const stem = value.replace(/^[^A-Za-z0-9]+/, "");
	if (/^[A-Z][A-Z0-9_]*$/.test(stem) && stem.includes("_")) return false;
	// A single short alphabetic word is prose (`AI_ENCRYPT_KEY = local baseline key`).
	if (/^[A-Za-z]+$/.test(value) && value.length < 20) return false;
	// Short, lower-case and digit-free is prose too (`KEY: daemon-access`); a credential of that
	// length carries a digit, an upper-case character, or enough length to be random.
	if (!/\d/.test(value) && !/[A-Z]/.test(value) && value.length < 16) return false;
	// A slug of three or more lower-case words (`daemon-access-token-for-xyz`) is a name someone
	// wrote, not a value someone generated; every generated credential mixes in a digit or case.
	if (value.length < 40 && /^[a-z]+(?:[.:_-][a-z]+){2,}$/.test(value)) return false;
	return !/^\d+$/.test(value);
}

/**
 * Front/back mask for a matched value: enough for the user to recognise which credential
 * is at risk, never enough to use it. Values too short to split safely are hidden whole.
 */
export function maskSecretValue(raw: string): string {
	const value = stripWrappingQuotes(raw.trim());
	if (value.length < 12) return `…(${value.length} characters hidden)`;
	const keep = value.length >= 24 ? 4 : 2;
	return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function shannonEntropyBitsPerChar(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	let bits = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		bits -= probability * Math.log2(probability);
	}
	return bits;
}

function characterClasses(value: string): number {
	let classes = 0;
	if (/[a-z]/.test(value)) classes += 1;
	if (/[A-Z]/.test(value)) classes += 1;
	if (/[0-9]/.test(value)) classes += 1;
	if (/[^A-Za-z0-9]/.test(value)) classes += 1;
	return classes;
}

/**
 * Hex (with or without dashes) is the shape of hashes, git SHAs and UUIDs, which every
 * coding session is full of, and it is also the shape of a few provider keys. Those keys
 * are covered by the exact-value comparison against this session's loaded credentials;
 * flagging every hash instead would make the warning meaningless.
 */
function looksLikeHash(value: string): boolean {
	return /^[0-9a-fA-F][0-9a-fA-F-]*$/.test(value);
}

function looksLikePath(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("~/") ||
		value.includes("//") ||
		// A URL fragment (`platform/…/`) or a file name is not a token, even when it is long and
		// random-looking; a credential is a single run with no path separator structure.
		value.includes("://") ||
		value.endsWith("/") ||
		value.split("/").length > 2 ||
		FILE_EXTENSION_TAIL.test(value)
	);
}

/** All matches of a global regex, with empty matches skipped the way a scanner must. */
function execAll(pattern: RegExp, text: string): RegExpExecArray[] {
	const matches: RegExpExecArray[] = [];
	pattern.lastIndex = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
		} else {
			matches.push(match);
		}
		match = pattern.exec(text);
	}
	return matches;
}

function detectPattern(text: string, pattern: ShareSecretPattern): ShareSecretMatch[] {
	const matches: ShareSecretMatch[] = [];
	for (const match of execAll(pattern.pattern, text)) {
		const group = pattern.valueGroup ?? 0;
		const value = match[group] ?? match[0];
		matches.push({ value, index: match.index + match[0].indexOf(value) });
	}
	return matches;
}

function detectorFromPattern(pattern: ShareSecretPattern): ShareSecretDetector {
	return {
		type: pattern.type,
		scansDocumentBytes: true,
		detect: (text) => detectPattern(text, pattern),
	};
}

/** A credential *location* (`GOOGLE_APPLICATION_CREDENTIALS=/etc/key.json`) is not a credential. */
function looksLikeLocation(value: string): boolean {
	return value.startsWith("/") || value.startsWith("./") || value.startsWith("~/") || value.startsWith("\\");
}

/**
 * A value that is really the next name in a names-only dump. `cat .env | cut -d= -f1` prints
 * `MYSQL_ROOT_PASSWORD= MYSQL_DATABASE= …`: the value is empty, the separator swallows the
 * whitespace, and the next name lands in the value. The stem of such a value is an
 * environment-style identifier, which a base64 secret with `=` padding never is.
 */
function looksLikeNextAssignmentName(value: string): boolean {
	const stem = value.replace(/[=:]+$/, "");
	if (stem === value) return false;
	// Either an environment-style identifier (`MYSQL_DATABASE=`), or a quoted pattern that
	// names a credential (`grep -E "^MYSQL_PASSWORD=`).
	const bare = stem.replace(/^[^A-Za-z0-9_]+/, "");
	if (/^[A-Z][A-Z0-9_]*$/.test(bare)) return true;
	return bare !== stem && isCredentialName(bare);
}

/** `TOKEN = os.environ["TOKEN"]` is a reference to a credential, not the credential. */
function looksLikeCodeReference(value: string): boolean {
	return /^(?:os|sys|process|Deno|globalThis)\.|\b(?:os\.environ|process\.env|getenv|System\.getenv)\b/i.test(value);
}

function detectCredentialAssignments(text: string): ShareSecretMatch[] {
	const matches: ShareSecretMatch[] = [];
	for (const match of execAll(CREDENTIAL_ASSIGNMENT, text)) {
		const name = match[1] ?? "";
		const value = match[2] ?? "";
		if (
			!isPlausibleSecretValue(value) ||
			BENIGN_CREDENTIAL_NAMES.test(name) ||
			looksLikeLocation(value) ||
			looksLikeNextAssignmentName(value) ||
			looksLikeCodeReference(value)
		) {
			continue;
		}
		matches.push({ value, index: match.index + (match[0]?.lastIndexOf(value) ?? 0), name });
	}
	return matches;
}

function detectHighEntropyTokens(text: string): ShareSecretMatch[] {
	const matches: ShareSecretMatch[] = [];
	for (const match of execAll(TOKEN_RUN, text)) {
		const token = match[0];
		if (token.length < HIGH_ENTROPY_MIN_LENGTH || token.length > HIGH_ENTROPY_MAX_LENGTH) continue;
		if (characterClasses(token) < 3) continue;
		if (looksLikeHash(token) || looksLikePath(token)) continue;
		if (shannonEntropyBitsPerChar(token) < HIGH_ENTROPY_MIN_BITS_PER_CHAR) continue;
		// The window is normalized first: the exported payload is JSON, so the name in front
		// of a value arrives as `\"DASHSCOPE_API_KEY\":\"`, and a raw scan for the anchor
		// would miss every escaped occurrence.
		const before = text.slice(Math.max(0, match.index - ANCHOR_WINDOW), match.index).replace(/\\/g, "");
		if (BENIGN_BLOB_CONTEXT.test(before)) continue;
		if (!CREDENTIAL_ANCHOR.test(before)) continue;
		matches.push({ value: token, index: match.index });
	}
	return matches;
}

/** All detectors in warning order: literal shapes, then names, then entropy. */
export const SHARE_SECRET_DETECTORS: readonly ShareSecretDetector[] = [
	...SHARE_SECRET_PATTERNS.map(detectorFromPattern),
	// Not document-scannable: the export document is a fixed template, and the template's own
	// `const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';` line is an assignment
	// shape. Reading it would warn on every share of every session.
	{ type: CREDENTIAL_ASSIGNMENT_TYPE, scansDocumentBytes: false, detect: detectCredentialAssignments },
	{ type: HIGH_ENTROPY_TOKEN_TYPE, scansDocumentBytes: false, detect: detectHighEntropyTokens },
];
