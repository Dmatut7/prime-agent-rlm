/**
 * The credential values this session has loaded, in raw form, for the /share preflight.
 *
 * Shape detection has a floor: it can miss a provider whose key format is unknown, and it
 * missed two of this machine's live credentials. The uploaded artifact, on the other hand,
 * is only dangerous when it contains a value that this session is actually configured
 * with, and that comparison needs no shape at all. Every value collected here is compared
 * verbatim against the bytes of the export; a value that is present is reported (masked)
 * whatever it looks like. Nothing is dropped for looking implausible - an all-digit key, a
 * lower-case slug and a passphrase are all compared like any other loaded value - and only a
 * value that *names a location* (`GOOGLE_APPLICATION_CREDENTIALS`) is held back from being
 * reported on its own.
 *
 * Sources, in the order they are consulted (first source wins for a duplicate value):
 *
 * - `auth.json` through live storage passed in by the caller, then the files under the
 *   agent directory: `auth.json`, `models.json`, `settings.json`,
 * - the process environment, for names that carry a credential word,
 * - a `--api-key` runtime override from this process's own command line (it is not in any
 *   file and not necessarily in the environment either).
 *
 * Loaded values never leave this module: callers receive them, compare them, and report
 * only a mask plus the source label (which names the variable or config path, not the value).
 */

import { readFileSync } from "node:fs";
import { getAgentDir } from "../config.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import { isComparableSecretValue, isLocationValuedCredential } from "./share-secret-detectors.js";

export interface ShareSecretValue {
	/** The credential value itself. Only ever compared, never displayed. */
	value: string;
	/** Non-secret origin label, e.g. `env DASHSCOPE_API_KEY` or `models.json (bailian.apiKey)`. */
	source: string;
	/**
	 * Compared, but never reported on its own: the value is a *location* (`GOOGLE_APPLICATION_CREDENTIALS`
	 * pointing at a key file), and a transcript mentions those paths constantly. Absent on the
	 * values that are reported, so a collected entry stays `{ value, source }`.
	 */
	compareOnly?: true;
}

export interface ShareSecretValueOptions {
	/** Environment to read. Defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Command line to read a `--api-key` override from. Defaults to `process.argv`. */
	argv?: readonly string[];
	/** Agent directory holding `auth.json` / `models.json` / `settings.json`. Defaults to `getAgentDir()`. */
	agentDir?: string;
}

const CREDENTIAL_ENV_NAME = /[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PASSCODE|CREDENTIAL)[A-Z0-9_]*/i;

/**
 * `PIN` only counts as a whole word: `DB_PIN` and `TOTP_PIN` hold a credential, while `PING`,
 * `SHIPPING` and `TYPING` do not.
 */
const CREDENTIAL_ENV_WORD = /(?:^|_)PINS?(?:_|$)/;

/**
 * The shortest value a report line is worth: a one- or two-character loaded value matches the
 * export by accident, and a warning about it is noise the reader learns to skip. It is still
 * compared - the set is never narrowed - only the report is.
 */
const MIN_REPORTABLE_SECRET_LENGTH = 4;

/**
 * Names that contain a credential word without holding a secret. Without this an ordinary
 * toolchain (`GPG_KEY`, `KEYBOARD_LAYOUT`, `MAX_TOKENS`) turns every share into a warning.
 */
const BENIGN_ENV_NAME =
	/(?:PUBLIC_KEY|KEYBOARD|KEYCHAIN|KEY_?PATH|KEY_?FILE|KEY_?ID|KEY_?NAME|KEY_?TYPE|KEY_?ALGORITHM|KEY_?SIZE|KEY_?BINDING|GPG_?KEY|PGP_?KEY|SSH_?KEY_?GEN|MAX_TOKENS|TOKEN_?LIMIT|TOKEN_?COUNT|TOKENIZER|TOKENS_?USED|SECRET_?NAME|PASSWORD_?POLICY|CREDENTIALS?_?PATH|CREDENTIALS?_?FILE)/i;

/** Config keys whose value is a credential. `access`/`refresh` cover the OAuth shapes. */
const CREDENTIAL_FIELD_NAME =
	/(?:^|[._-])(?:key|token|secret|password|passwd|credential|access|refresh|assertion|code|headers?)$|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)/i;

function isCredentialEnvName(name: string): boolean {
	return (CREDENTIAL_ENV_NAME.test(name) || CREDENTIAL_ENV_WORD.test(name)) && !BENIGN_ENV_NAME.test(name);
}

function isCredentialFieldName(name: string): boolean {
	return CREDENTIAL_FIELD_NAME.test(name) && !BENIGN_ENV_NAME.test(name);
}

/** `--api-key <value>` and `--api-key=<value>`, the runtime override that reaches no file. */
export function readApiKeyArguments(argv: readonly string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) continue;
		if (argument === "--api-key") {
			const next = argv[index + 1];
			if (next !== undefined) values.push(next);
			index += 1;
			continue;
		}
		if (argument.startsWith("--api-key=")) {
			values.push(argument.slice("--api-key=".length));
		}
	}
	return values;
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		// A missing, unreadable or malformed config contributes nothing; the scan must run
		// anyway, because the shape detectors do not depend on it.
		return undefined;
	}
}

function readConfigValue(raw: string): string | undefined {
	// `!cat /path/key` and env-var references resolve the same way the session resolved them
	// when it loaded its credentials; `resolveConfigValue` caches per command.
	const resolved = resolveConfigValue(raw);
	return resolved === undefined ? undefined : resolved;
}

/**
 * Every credential value the current session is configured with. Never throws: a broken
 * config file narrows the comparison instead of failing the share preflight.
 */
export function collectConfiguredShareSecretValues(options: ShareSecretValueOptions = {}): ShareSecretValue[] {
	const collected = new Map<string, ShareSecretValue>();

	const add = (raw: unknown, source: string): void => {
		if (typeof raw !== "string") return;
		const resolved = source.startsWith("env ") ? raw : readConfigValue(raw);
		if (resolved === undefined) return;
		const value = resolved.trim();
		// No plausibility filter: a value this session is configured with is compared verbatim
		// whatever it looks like. Shape-driven filtering here is what let an all-digit key, a
		// lower-case slug and a passphrase leave the machine unnoticed, and the comparison is the
		// one check that is supposed to have no shape to hide behind. A value that names a
		// location rather than a secret is still compared (never dropped) but is not reported on
		// its own; see `ShareSecretValue.compareOnly`.
		if (!isComparableSecretValue(value) || collected.has(value)) return;
		// Reported unless the value names a location, or is shorter than any credential (a flag,
		// a line number). Both stay in the compared set; only the report line is held back.
		const compareOnly = isLocationValuedCredential(value) || value.length < MIN_REPORTABLE_SECRET_LENGTH;
		collected.set(value, {
			value,
			source,
			...(compareOnly ? { compareOnly: true as const } : {}),
		});
	};

	const env = options.env ?? process.env;
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || !isCredentialEnvName(name)) continue;
		add(value, `env ${name}`);
	}

	for (const value of readApiKeyArguments(options.argv ?? process.argv)) {
		add(value, "cli --api-key");
	}

	const agentDir = options.agentDir ?? getAgentDir();
	collectFromAuthJson(agentDir, add);
	collectFromModelsJson(agentDir, add);
	collectFromSettingsJson(agentDir, add);

	return [...collected.values()];
}

function collectFromAuthJson(agentDir: string, add: (raw: unknown, source: string) => void): void {
	const auth = readJsonFile(`${agentDir}/auth.json`);
	if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return;
	for (const [provider, credential] of Object.entries(auth as Record<string, unknown>)) {
		if (typeof credential !== "object" || credential === null || Array.isArray(credential)) continue;
		for (const [field, raw] of Object.entries(credential as Record<string, unknown>)) {
			if (field === "type" || field === "expires") continue;
			add(raw, `auth.json (${provider}.${field})`);
		}
	}
}

function collectFromModelsJson(agentDir: string, add: (raw: unknown, source: string) => void): void {
	const models = readJsonFile(`${agentDir}/models.json`);
	const providers = (models as { providers?: unknown } | undefined)?.providers;
	if (typeof providers !== "object" || providers === null) return;
	for (const [provider, config] of Object.entries(providers as Record<string, unknown>)) {
		if (typeof config !== "object" || config === null) continue;
		collectCredentialFields(config as Record<string, unknown>, `models.json (${provider}`, add);
	}
}

function collectFromSettingsJson(agentDir: string, add: (raw: unknown, source: string) => void): void {
	const settings = readJsonFile(`${agentDir}/settings.json`);
	if (typeof settings !== "object" || settings === null) return;
	const record = settings as Record<string, unknown>;

	// Credentials the user configured through /login live in auth.json; settings.json keeps
	// MCP credentials in plaintext under `mcpServers`, and older versions kept apiKeys here.
	const servers = record.mcpServers;
	if (typeof servers === "object" && servers !== null) {
		for (const [server, config] of Object.entries(servers as Record<string, unknown>)) {
			if (typeof config !== "object" || config === null) continue;
			const serverConfig = config as Record<string, unknown>;
			for (const field of ["headers", "env"]) {
				const table = serverConfig[field];
				if (typeof table !== "object" || table === null) continue;
				for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
					if (!isCredentialFieldName(name)) continue;
					add(raw, `settings.json (mcpServers.${server}.${field}.${name})`);
				}
			}
			const args = serverConfig.args;
			if (Array.isArray(args)) {
				for (const value of readApiKeyArguments(args.map((entry) => String(entry)))) {
					add(value, `settings.json (mcpServers.${server}.args)`);
				}
			}
		}
	}

	const apiKeys = record.apiKeys;
	if (typeof apiKeys === "object" && apiKeys !== null) {
		for (const [provider, raw] of Object.entries(apiKeys as Record<string, unknown>)) {
			add(raw, `settings.json (apiKeys.${provider})`);
		}
	}
}

/** Credential-named fields of one provider entry, plus `headers`, which are auth headers. */
function collectCredentialFields(
	config: Record<string, unknown>,
	sourcePrefix: string,
	add: (raw: unknown, source: string) => void,
): void {
	const headers = config.headers;
	if (typeof headers === "object" && headers !== null) {
		for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
			add(raw, `${sourcePrefix}.headers.${name})`);
		}
	}
	for (const [field, raw] of Object.entries(config)) {
		if (field === "headers") continue;
		if (!isCredentialFieldName(field)) continue;
		add(raw, `${sourcePrefix}.${field})`);
	}
}
