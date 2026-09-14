/**
 * The gate every outbound trace upload passes through, for both halves of the request.
 *
 * A trace upload is built twice from the same facts and only one copy was ever inspected:
 * the body is the session file read as-is, while the headers are a second, independent
 * construction of the same session (`X-Cwd`, `X-Git-Repo`, `X-Git-Commit`, `X-Parent-Session`).
 * A credential reaches the service through either. `X-Git-Repo` was the sharpest example: a
 * remote fetched with userinfo (`https://x-access-token:<token>@github.com/org/repo.git`) was
 * passed through unchanged, both in that header and inside the body's `git_state`.
 *
 * So both halves go through the same two steps, in this order:
 *
 * 1. URL userinfo is stripped. `scheme://user:password@host/...` becomes `scheme://host/...`;
 *    the username in a git remote is `x-access-token` and the password is the token, and
 *    neither is a fact the trace service indexes on.
 * 2. The `/share` credential scan runs over the remaining text and the values this session is
 *    configured with are removed by exact comparison. A session that mentions a key must not
 *    put that key on the wire just because the upload was automatic and nobody was asked.
 *
 * The `Authorization` header is the one value not scanned: it *is* a credential, deliberately
 * built from the credential store for the trace API's own host, and redacting it would fail
 * every upload instead of protecting anything.
 */

import { collectConfiguredShareSecretValues, type ShareSecretValue } from "./share-secret-values.js";
import { REDACTED_SECRET_MARKER, redactShareSecrets } from "./share-session.js";

/**
 * Headers that carry a credential by design. `Authorization` is built from the credential
 * store for the trace API's own host; `Proxy-Authorization` and `Cookie` would be the same
 * kind of deliberate authorization if this client ever added them.
 */
const AUTHORIZATION_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

/**
 * `scheme://userinfo@host`. The userinfo class excludes `/`, quotes and whitespace, so a URL
 * with an `@` in its path (`https://github.com/org/repo@v1.0`) is not mistaken for one with
 * credentials in it.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^\s"'/@]+)@/gi;

export interface StripUrlUserinfoResult {
	value: string;
	/** How many `userinfo@` blocks were removed. */
	stripped: number;
}

/** Remove the `user:password@` part of every URL in `text`. */
export function stripUrlUserinfo(text: string): StripUrlUserinfoResult {
	let stripped = 0;
	const value = text.replace(URL_USERINFO, (_match, scheme: string) => {
		stripped += 1;
		return scheme;
	});
	return { value, stripped };
}

export interface UploadPrivacyGateInput {
	headers: Record<string, string>;
	body: string;
	/**
	 * Values compared verbatim against both halves. Defaults to the credentials this session is
	 * configured with (`auth.json`, `models.json`, `settings.json`, credential-named environment
	 * variables), which is the check no unknown key shape can slip past.
	 */
	secretValues?: readonly ShareSecretValue[];
	/** Agent directory the configured values are read from. Defaults to `getAgentDir()`. */
	agentDir?: string;
}

export interface UploadPrivacyGateResult {
	/** Headers that may be sent: userinfo stripped, credentials replaced. */
	headers: Record<string, string>;
	/** Body that may be sent: userinfo stripped, credentials replaced. */
	body: string;
	/** Header names whose URL userinfo was stripped. */
	headersWithoutUserinfo: string[];
	/** How many userinfo blocks were stripped out of the body. */
	bodyUserinfoCount: number;
	/** Shape labels of the credentials replaced, in detector order, deduplicated. No secret text. */
	redactedTypes: string[];
	/** How many credential values were replaced across the headers and the body. */
	redactedValues: number;
}

/** Both halves of one request through one gate. */
export function applyUploadPrivacyGate(input: UploadPrivacyGateInput): UploadPrivacyGateResult {
	const secretValues =
		input.secretValues ??
		collectConfiguredShareSecretValues(input.agentDir === undefined ? {} : { agentDir: input.agentDir });
	const headers: Record<string, string> = {};
	const headersWithoutUserinfo: string[] = [];
	const redactedTypes = new Set<string>();
	let redactedValues = 0;

	for (const [name, value] of Object.entries(input.headers)) {
		if (AUTHORIZATION_HEADERS.has(name.toLowerCase())) {
			headers[name] = value;
			continue;
		}
		const sanitized = sanitizeUploadText(value, secretValues);
		if (sanitized.strippedUserinfo > 0) {
			headersWithoutUserinfo.push(name);
		}
		redactedValues += sanitized.redaction.count;
		for (const type of sanitized.redaction.types) {
			redactedTypes.add(type);
		}
		headers[name] = sanitized.redaction.text;
	}

	const body = sanitizeUploadText(input.body, secretValues);
	redactedValues += body.redaction.count;
	for (const type of body.redaction.types) {
		redactedTypes.add(type);
	}

	return {
		headers,
		body: body.redaction.text,
		headersWithoutUserinfo,
		bodyUserinfoCount: body.strippedUserinfo,
		redactedTypes: [...redactedTypes],
		redactedValues,
	};
}

interface SanitizedUploadText {
	redaction: ReturnType<typeof redactShareSecrets>;
	strippedUserinfo: number;
}

/** The two steps, in one place: userinfo first, then the credential scan over what is left. */
function sanitizeUploadText(text: string, secretValues: readonly ShareSecretValue[]): SanitizedUploadText {
	const userinfo = stripUrlUserinfo(text);
	return {
		redaction: redactShareSecrets(userinfo.value, { secretValues }),
		strippedUserinfo: userinfo.stripped,
	};
}

/** Whether the gate has anything to report, without exposing `REDACTED_SECRET_MARKER` to callers. */
export function uploadPrivacyGateChanged(result: UploadPrivacyGateResult): boolean {
	return result.redactedValues > 0 || result.headersWithoutUserinfo.length > 0 || result.bodyUserinfoCount > 0;
}

export { REDACTED_SECRET_MARKER };
