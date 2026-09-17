/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
	findEnvKeys,
	getEnvApiKey,
	getLogger,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { ensurePrivateFile, readPrivateFile, writePrivateFileAtomic } from "../utils/private-files.js";
import { sleepSync } from "../utils/sleep.js";
import { findFilesHoldingSecrets, purgeLegacyTokenStores } from "./legacy-auth-files.js";
import {
	clearPrimeCliCredentialsWithReport,
	getPrimeCliConfigPath,
	loadPrimeCliConfig,
	PRIME_INFERENCE_PROVIDER_ID,
	type PrimeCliConfig,
	type PrimeTeam,
	savePrimeCliApiKey,
	savePrimeCliTeamSelection,
} from "./prime-inference-auth.js";
import { clearResolvedCommandCache, resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

/**
 * How many failed auth operations are kept for a caller to drain.
 *
 * The buffer exists so a failure is not lost, not as a history: a caller that drains
 * learns what went wrong, and a store that keeps failing (an unwritable token file, an
 * expired refresh token) must not turn that into unbounded memory.
 */
const MAX_RECORDED_AUTH_ERRORS = 20;

const authStorageLog = getLogger("coding-agent.auth-storage");

/**
 * A non-fatal, user-visible side effect of an auth operation.
 *
 * `errors` carries what failed. A notice carries what worked but reached outside this store —
 * today, the logout of Prime Inference when its credential is the shared Prime CLI config: the
 * removal is correct and complete, and the user still has to learn that another tool's key went
 * with it. Callers surface notices; nothing here decides how.
 */
export type AuthNotice = {
	provider: string;
	message: string;
};

export type PrimeTeamCredential = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	primeTeam?: PrimeTeamCredential | null;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

/**
 * A static token pasted for one MCP connection through the inline paste flow.
 * Deliberately NOT the OAuth shape: there is no refresh token, no expiry, and
 * no client identity to fake — the handshake sends `bearer` as
 * `Authorization: Bearer`. Exactly ONE credential per connection (the paste
 * flow prompts once; multiple catalog fields may only be alternative names for
 * that one credential). Bound to the exact endpoint it was pasted for, stored
 * only in the credential store under the owning connection's
 * `mcp:<connectionId>` key — never in settings.json.
 */
export type McpStaticTokenCredential = {
	type: "mcp_static_token";
	/** The endpoint the pasted token is bound to; a retargeted entry fails closed. */
	endpoint: string;
	/** The value the MCP handshake sends as the bearer. */
	bearer: string;
	/** The catalog setup field id the token was collected for (the first alternative name). */
	bearerFieldId: string;
	createdAt: number;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential | McpStaticTokenCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "prime_cli"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| "stale";
	label?: string;
};

export type AuthStorageOptions = {
	primeCliConfigPath?: string;
	usePrimeCliConfig?: boolean;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

type ActiveAuthStatusSource = Exclude<NonNullable<AuthStatus["source"]>, "stale">;

export type AuthSourceToken = {
	provider: string;
	source: ActiveAuthStatusSource;
	identityFingerprint: string;
	valueFingerprint: string;
	/** When the stale mark was set; a mark older than the cooldown stops matching. */
	markedAt?: number;
};

/**
 * How long a stale auth mark keeps suppressing its credential. The mark is a
 * cooldown, not a deletion: after it expires the credential is retried, and a
 * fresh 401 simply re-marks it (cost: one failed request round).
 */
export const STALE_AUTH_COOLDOWN_MS = 15 * 60_000;

/** True when the stale mark is older than the cooldown and should stop matching. */
export function isStaleAuthTokenExpired(token: AuthSourceToken, now: number = Date.now()): boolean {
	return token.markedAt !== undefined && now - token.markedAt >= STALE_AUTH_COOLDOWN_MS;
}

type AuthSourceCandidate = {
	source: ActiveAuthStatusSource;
	configured: boolean;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	resolveValueFingerprint?: () => string | undefined;
};

type AuthApiKeyResult = {
	apiKey?: string;
	sourceToken?: AuthSourceToken;
	credentialType?: AuthCredential["type"];
};

/** Values of a credential that must not stay readable anywhere after a logout. */
function credentialSecrets(credential: AuthCredential | undefined): string[] {
	if (!credential) return [];
	const values =
		credential.type === "oauth"
			? [credential.access, credential.refresh]
			: credential.type === "mcp_static_token"
				? [credential.bearer]
				: [credential.key];
	return values.filter((value): value is string => typeof value === "string");
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
	/**
	 * Directory holding the token-bearing files of this store, for backends that have
	 * one. Logout scans it for copies of the credential; an in-memory backend leaves
	 * this undefined because it has nothing to clean up.
	 */
	readonly stateDirectory?: string;
	/**
	 * Cheap identity of the backing file's current contents (mtime + size), stat'ed
	 * without reading it and without taking the lock. AuthStorage compares it before
	 * every credential read to pick up changes other processes made (round-27 F3: no
	 * event ever reaches a resident worker, so without this a revoked credential is
	 * served until it expires, and an `api_key` never does). Backends with no file
	 * omit it.
	 */
	statFingerprint?(): string | undefined;
	/**
	 * The backing file's current bytes without taking the lock. Every write goes
	 * through writePrivateFileAtomic (temp file + rename), so a lockless reader sees
	 * the old or the new file and never a partial one. Backends with no file omit it.
	 */
	readUnlocked?(): string | undefined;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	readonly stateDirectory: string;

	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {
		this.stateDirectory = dirname(this.authPath);
	}

	private ensureFileExists(): void {
		ensurePrivateFile(this.authPath, "{}");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;
		let compromisedError: Error | undefined;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const release = lockfile.lockSync(path, {
					realpath: false,
					onCompromised: (error) => {
						compromisedError ??= error;
					},
				});
				if (compromisedError) {
					release();
					throw compromisedError;
				}
				return release;
			} catch (error) {
				if (compromisedError) throw compromisedError;
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				// Sleep synchronously to avoid changing callers to async.
				sleepSync(delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = readPrivateFile(this.authPath, "utf-8");
			const { result, next } = fn(current);
			if (next !== undefined) {
				writePrivateFileAtomic(this.authPath, next);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	statFingerprint(): string | undefined {
		try {
			const stat = statSync(this.authPath);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	readUnlocked(): string | undefined {
		try {
			return readPrivateFile(this.authPath, "utf-8");
		} catch {
			return undefined;
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = readPrivateFile(this.authPath, "utf-8");
			const { result, next } = await fn(current);
			// Persist before surfacing a compromise detected during fn: a stolen lock
			// means the refresh inside fn already rotated the server-side pair, so
			// dropping `next` would strand auth.json on a refresh token the server has
			// revoked (every later refresh fails until a manual /login). Writing first
			// keeps the fresh pair recoverable through the caller's reload() path while
			// the throw below still reports the stolen lock.
			if (next !== undefined) {
				writePrivateFileAtomic(this.authPath, next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				if (lockCompromised) await release().catch(() => undefined);
				else await release();
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private staleAuthSources: Map<string, AuthSourceToken[]> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	/** Stat identity of the bytes `data` was parsed from (lazy on-disk invalidation). */
	private diskStat: string | undefined;
	/** The exact bytes `data` was parsed from, compared when the stat identity moved. */
	private diskBytes: string | undefined;
	private errors: Error[] = [];
	private errorsDropped = 0;
	private notices: AuthNotice[] = [];

	private constructor(
		private storage: AuthStorageBackend,
		private options: AuthStorageOptions = {},
	) {
		// Not `reload()`: constructing a store is not a credential change, so it must not
		// drop the process-level `!command` value cache.
		this.loadCredentialsFromDisk();
	}

	static create(authPath?: string, options?: AuthStorageOptions): AuthStorage {
		const authOptions = options ?? { usePrimeCliConfig: authPath === undefined };
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")), authOptions);
	}

	static fromStorage(storage: AuthStorageBackend, options?: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, options);
	}

	static inMemory(data: AuthStorageData = {}, options?: AuthStorageOptions): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage, options);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
		if (this.errors.length <= MAX_RECORDED_AUTH_ERRORS) {
			return;
		}
		// Drop the oldest, keep the newest: the failure that just happened is the one a
		// caller can still act on. The drop is reported rather than silent - a truncated
		// buffer that looks complete is worse than a bounded one that says it dropped.
		this.errors.shift();
		this.errorsDropped++;
		authStorageLog.warn("auth error buffer full, dropped the oldest recorded error", {
			dropped: this.errorsDropped,
			cap: MAX_RECORDED_AUTH_ERRORS,
		});
	}

	private fingerprintAuthSource(source: ActiveAuthStatusSource, material: string): string {
		const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
		return `${source}:${digest}`;
	}

	private createAuthSourceCandidate(options: {
		source: ActiveAuthStatusSource;
		configured: boolean;
		identityMaterial: string;
		valueMaterial?: string;
		label?: string;
		resolveValueMaterial?: () => string | undefined;
	}): AuthSourceCandidate {
		return {
			configured: options.configured,
			source: options.source,
			...(options.label ? { label: options.label } : {}),
			identityFingerprint: this.fingerprintAuthSource(options.source, `identity:${options.identityMaterial}`),
			...(options.valueMaterial !== undefined
				? {
						valueFingerprint: this.fingerprintAuthSource(
							options.source,
							`value:${options.identityMaterial}\0${options.valueMaterial}`,
						),
					}
				: {}),
			...(options.resolveValueMaterial
				? {
						resolveValueFingerprint: () => {
							const valueMaterial = options.resolveValueMaterial?.();
							return valueMaterial === undefined
								? undefined
								: this.fingerprintAuthSource(
										options.source,
										`value:${options.identityMaterial}\0${valueMaterial}`,
									);
						},
					}
				: {}),
		};
	}

	private getStoredCredentialValueMaterial(providerId: string, credential: AuthCredential): string | undefined {
		if (credential.type === "api_key") {
			if (credential.key.startsWith("!")) {
				const resolvedKey = resolveConfigValueUncached(credential.key);
				return resolvedKey === undefined ? undefined : `api_key:command:${credential.key}\0${resolvedKey}`;
			}
			return `api_key:${credential.key}\0${resolveConfigValue(credential.key) ?? ""}`;
		}
		// Static MCP tokens are not model-provider key material: they never
		// resolve to a provider API key value fingerprint.
		if (credential.type !== "oauth") return undefined;
		const provider = getOAuthProvider(providerId);
		const apiKey = provider?.getApiKey(credential) ?? credential.access;
		return `oauth:${apiKey}\0${credential.refresh}\0${credential.expires}`;
	}

	private getRuntimeAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.runtimeOverrides.get(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "--api-key",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "runtime",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getPrimeCliAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.getPrimeCliApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "Prime CLI",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "prime_cli",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getStoredAuthCandidate(
		provider: string,
		options?: { resolveCommandValue?: boolean; resolvedCommandValue?: string },
	): AuthSourceCandidate | undefined {
		const credential = this.data[provider];
		if (!credential) {
			return undefined;
		}
		const isCommandApiKey = credential.type === "api_key" && credential.key.startsWith("!");
		const identityMaterial = isCommandApiKey ? `api_key:command:${credential.key}` : `${provider}:${credential.type}`;
		const commandValueMaterial =
			isCommandApiKey && options?.resolvedCommandValue !== undefined
				? `api_key:command:${credential.key}\0${options.resolvedCommandValue}`
				: undefined;
		return this.createAuthSourceCandidate({
			configured: true,
			source: "stored",
			identityMaterial,
			valueMaterial:
				commandValueMaterial ??
				(isCommandApiKey && !options?.resolveCommandValue
					? undefined
					: this.getStoredCredentialValueMaterial(provider, credential)),
			resolveValueMaterial: isCommandApiKey
				? () => this.getStoredCredentialValueMaterial(provider, credential)
				: undefined,
		});
	}

	private getEnvironmentAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const envKeys = findEnvKeys(provider);
		const envKey = envKeys?.[0];
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		const label = envKey ?? "ambient credentials";
		const identityMaterial = envKey ?? this.getAmbientEnvironmentIdentityMaterial(provider);
		return this.createAuthSourceCandidate({
			configured: false,
			source: "environment",
			label,
			identityMaterial,
			valueMaterial: `${identityMaterial}\0${apiKey}`,
		});
	}

	private getAmbientEnvironmentIdentityMaterial(provider: string): string {
		if (provider === "amazon-bedrock") {
			if (process.env.AWS_PROFILE) return `amazon-bedrock:profile:${process.env.AWS_PROFILE}`;
			if (process.env.AWS_ACCESS_KEY_ID) {
				return `amazon-bedrock:access-key:${process.env.AWS_ACCESS_KEY_ID}:${process.env.AWS_SECRET_ACCESS_KEY ?? ""}:${process.env.AWS_SESSION_TOKEN ?? ""}`;
			}
			if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
				return `amazon-bedrock:bearer:${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
				return `amazon-bedrock:ecs-relative:${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
				return `amazon-bedrock:ecs-full:${process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI}`;
			}
			if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
				return `amazon-bedrock:web-identity:${process.env.AWS_WEB_IDENTITY_TOKEN_FILE}`;
			}
		}
		if (provider === "google-vertex") {
			const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
			const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
			const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "application-default";
			return `google-vertex:${project}:${location}:${credentialsPath}`;
		}
		return provider;
	}

	private getFallbackAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.fallbackResolver?.(provider);
		if (!apiKey) {
			return undefined;
		}
		return this.createAuthSourceCandidate({
			configured: false,
			source: "fallback",
			label: "custom provider config",
			identityMaterial: provider,
			valueMaterial: apiKey,
		});
	}

	private getAuthSourceCandidates(provider: string, options?: { includeFallback?: boolean }): AuthSourceCandidate[] {
		const fallbackCandidate =
			options?.includeFallback === false ? undefined : this.getFallbackAuthCandidate(provider);
		const candidates =
			provider === PRIME_INFERENCE_PROVIDER_ID
				? [
						this.getRuntimeAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						this.getPrimeCliAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						fallbackCandidate,
					]
				: [
						this.getRuntimeAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						fallbackCandidate,
					];
		return candidates.filter((candidate): candidate is AuthSourceCandidate => candidate !== undefined);
	}

	private isAuthSourceStale(provider: string, candidate: AuthSourceCandidate): boolean {
		const matchingStale = this.getActiveStaleAuthSources(provider, candidate);
		if (matchingStale.length === 0) {
			return false;
		}
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
	}

	private getMatchingStaleAuthSources(provider: string, candidate: AuthSourceCandidate): AuthSourceToken[] {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return [];
		}
		return stale.filter(
			(token) => token.source === candidate.source && token.identityFingerprint === candidate.identityFingerprint,
		);
	}

	private getActiveStaleAuthSources(provider: string, candidate: AuthSourceCandidate): AuthSourceToken[] {
		// Cooldown, not deletion: expired marks stay recorded but stop matching, so a
		// credential whose provider was rejecting it earlier is retried later.
		return this.getMatchingStaleAuthSources(provider, candidate).filter((token) => !isStaleAuthTokenExpired(token));
	}

	private getAvailableAuthCandidate(
		provider: string,
		options?: { includeFallback?: boolean },
	): { candidate?: AuthSourceCandidate; hasStaleCandidate: boolean } {
		let hasStaleCandidate = false;
		for (const candidate of this.getAuthSourceCandidates(provider, options)) {
			if (this.isAuthSourceStale(provider, candidate)) {
				hasStaleCandidate = true;
				continue;
			}
			return { candidate, hasStaleCandidate };
		}
		return { hasStaleCandidate };
	}

	private toAuthStatus(candidate: AuthSourceCandidate): AuthStatus {
		return {
			configured: candidate.configured,
			source: candidate.source,
			...(candidate.label ? { label: candidate.label } : {}),
		};
	}

	private getAuthStatusFromCandidates(provider: string): AuthStatus {
		const { candidate, hasStaleCandidate } = this.getAvailableAuthCandidate(provider);
		if (candidate) {
			return this.toAuthStatus(candidate);
		}
		if (hasStaleCandidate) {
			return { configured: false, source: "stale", label: "expired" };
		}
		return { configured: false };
	}

	markAuthStale(provider: string): boolean {
		const token = this.getCurrentAuthSourceToken(provider);
		return token ? this.markAuthSourceStale(token) : false;
	}

	private getAuthSourceTokenForCandidate(
		provider: string,
		candidate: AuthSourceCandidate,
	): AuthSourceToken | undefined {
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		if (!valueFingerprint) {
			return undefined;
		}
		return {
			provider,
			source: candidate.source,
			identityFingerprint: candidate.identityFingerprint,
			valueFingerprint,
		};
	}

	getCurrentAuthSourceToken(provider: string): AuthSourceToken | undefined {
		const { candidate } = this.getAvailableAuthCandidate(provider);
		if (!candidate) {
			return undefined;
		}
		return this.getAuthSourceTokenForCandidate(provider, candidate);
	}

	markAuthSourceStale(token: AuthSourceToken): boolean {
		if (token.provider.length === 0) {
			return false;
		}
		const stamped: AuthSourceToken = { ...token, markedAt: Date.now() };
		const stale = this.staleAuthSources.get(token.provider) ?? [];
		const existing = stale.find(
			(candidate) =>
				candidate.source === stamped.source &&
				candidate.identityFingerprint === stamped.identityFingerprint &&
				candidate.valueFingerprint === stamped.valueFingerprint,
		);
		if (existing) {
			// Re-marking after the cooldown expired restarts the cooldown.
			existing.markedAt = stamped.markedAt;
		} else {
			stale.push(stamped);
		}
		this.staleAuthSources.set(token.provider, stale);
		return true;
	}

	/** Forget every stale marking for a provider (explicit user re-selection). */
	clearAuthStale(provider: string): void {
		this.staleAuthSources.delete(provider);
	}

	private clearStaleAuthSource(provider: string, source: ActiveAuthStatusSource): void {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return;
		}
		const next = stale.filter((token) => token.source !== source);
		if (next.length === 0) {
			this.staleAuthSources.delete(provider);
		} else {
			this.staleAuthSources.set(provider, next);
		}
	}

	/** Clear every stale mark recorded for a provider (an explicit re-login resets all sources). */

	/**
	 * Clear stale marks on stored credentials after the auth file changed on disk.
	 * A moved stat identity means another process wrote the file - most commonly a
	 * /login - so stored-source stale marks must not outlive the write. Worst case an
	 * unrelated edit un-stales a really dead key: it gets re-marked after one 401.
	 */
	private clearStaleStoredAuthSources(): void {
		for (const [provider, tokens] of [...this.staleAuthSources]) {
			const next = tokens.filter((token) => token.source !== "stored");
			if (next.length === 0) {
				this.staleAuthSources.delete(provider);
			} else {
				this.staleAuthSources.set(provider, next);
			}
		}
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		const data: unknown = JSON.parse(content);
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			throw new Error("Invalid auth storage: expected a JSON object");
		}
		return data as AuthStorageData;
	}

	/**
	 * Read the store from disk without touching the process-level `!command` cache.
	 * The constructor uses this: a second store in the same process is a second *view* of
	 * the same credentials, not a credential change, so it must not respawn a credential
	 * helper (see "cache persists across AuthStorage instances").
	 */
	private loadCredentialsFromDisk(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
			this.rememberDiskState(content);
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	/** Record the on-disk identity the in-memory copy was just made current with. */
	private rememberDiskState(content: string | undefined): void {
		this.diskBytes = content;
		this.diskStat = this.storage.statFingerprint?.();
	}

	/**
	 * Lazy invalidation of the in-memory copy (round-27 F3 / SEC-6): auth.json can be
	 * edited by any other process - a /login or /logout in another window, a manual
	 * revoke - and no event reaches this one, so a resident worker would keep serving
	 * the revoked credential until it expires (an `api_key` never does). Every
	 * credential read stats the file first: an unchanged file costs one stat and no
	 * read, and a moved stat identity is confirmed against the exact bytes before the
	 * store reloads, so a touch or an atomic rewrite of identical bytes does not drop
	 * the `!command` value cache. Backends without a file have nothing to watch.
	 */
	private reloadIfAuthFileChanged(): void {
		const statFingerprint = this.storage.statFingerprint;
		if (statFingerprint === undefined) return;
		const stat = statFingerprint.call(this.storage);
		if (stat === this.diskStat) return;
		// A moved stat identity is an external write (another process logged in or
		// logged out), even when the bytes turn out identical: stored-source stale
		// marks must not survive it, or a same-value /login never recovers.
		this.clearStaleStoredAuthSources();
		const bytes = this.storage.readUnlocked?.();
		if (bytes !== undefined && bytes === this.diskBytes) {
			// Same bytes under a new stat identity: adopt the stat, not a reload.
			this.diskStat = stat;
			return;
		}
		this.reload();
	}

	/**
	 * Reload credentials from storage.
	 *
	 * This is the explicit "re-read external state" entry point (`AgentSession.reload`
	 * for `/reload`, a login saved by the client process, a model-registry refresh), so it
	 * also drops the `!command` value cache: a command-resolved key is exactly the
	 * credential whose *value* moves while its command text stays the same. Callers with
	 * no stale-source fallback of their own - `AgentSession._addWebsearchKeyEnv` writing
	 * `SERPER_API_KEY` into the kernel environment - have no second chance without this.
	 */
	reload(): void {
		clearResolvedCommandCache();
		this.loadCredentialsFromDisk();
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			let persisted: string | undefined;
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				persisted = JSON.stringify(merged, null, 2);
				return { result: undefined, next: persisted };
			});
			// The write just made the in-memory copy current with the disk: record it,
			// or the next read would mistake it for an external change and reload.
			this.rememberDiskState(persisted);
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		this.reloadIfAuthFileChanged();
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		// A new credential may point at a `!command` whose earlier failure is still inside
		// the retry window; the write has to drop that cached failure.
		clearResolvedCommandCache();
		// An explicit credential write is a full reset for the provider: a 401 marked
		// the runtime/environment source stale earlier in this process, and the user
		// re-logging in must recover every source, not only the stored one.
		// The stored source's stale mark always clears (the user just re-logged in).
		this.clearStaleAuthSource(provider, "stored");
		// The runtime source only clears when it carries the same value that was
		// just set: a stale runtime key must not be revived by an unrelated stored
		// login (the stored-update/do-not-revive-runtime contract).
		const runtimeValue = this.runtimeOverrides.get(provider);
		if (runtimeValue !== undefined && credential.type === "api_key" && runtimeValue === credential.key) {
			this.clearStaleAuthSource(provider, "runtime");
		}
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		clearResolvedCommandCache();
		this.clearStaleAuthSource(provider, "stored");
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * Remove a provider's credential with the disk write verified: throws on any
	 * load or write failure instead of recording it, so callers can refuse to
	 * proceed while the credential may still exist on disk. Disk-authoritative
	 * and idempotent — in-memory state is only updated after the write succeeds.
	 * Returns whether a credential was actually removed from disk.
	 */
	removeVerified(provider: string): boolean {
		const removed = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			if (!(provider in currentData)) return { result: false };
			const merged: AuthStorageData = { ...currentData };
			delete merged[provider];
			return { result: true, next: JSON.stringify(merged, null, 2) };
		});
		if (removed) {
			delete this.data[provider];
			clearResolvedCommandCache();
			// Post-success only: a failed removal must not make a stale-marked credential selectable again.
			this.clearStaleAuthSource(provider, "stored");
		}
		return removed;
	}

	/**
	 * Disk-authoritative conditional move for staged MCP logins: move
	 * `stagedProvider`'s credential to `provider` ONLY when no credential
	 * exists at `provider` ON DISK, reading and writing under the backend's
	 * own file lock. An ordinary login in another process — invisible to this
	 * instance's cache — can never be clobbered by a race between the get and
	 * the set. Returns "occupied" when the destination already holds a
	 * credential, "nothing" when the staged slot is empty, or the exact
	 * credential that moved (for exact-own rollback).
	 */
	moveStagedCredential(
		stagedProvider: string,
		provider: string,
	): { status: "occupied" } | { status: "nothing" } | { status: "moved"; credential: AuthCredential } {
		type MoveOutcome =
			| { status: "occupied" }
			| { status: "nothing" }
			| { status: "moved"; credential: AuthCredential };
		const outcome = this.storage.withLock<MoveOutcome>((current) => {
			const currentData = this.parseStorageData(current);
			if (provider in currentData) {
				return { result: { status: "occupied" } };
			}
			const staged = currentData[stagedProvider];
			if (!staged) {
				return { result: { status: "nothing" } };
			}
			const merged: AuthStorageData = { ...currentData, [provider]: staged };
			delete merged[stagedProvider];
			return {
				result: { status: "moved", credential: staged },
				next: JSON.stringify(merged, null, 2),
			};
		});
		// Post-success only: refresh the cache from disk under the same lock
		// discipline so no stale entry survives the move.
		if (outcome.status === "moved") {
			this.reload();
		}
		return outcome;
	}

	/**
	 * Disk-authoritative conditional restore: write `credential` to
	 * `provider` ONLY when the slot is empty ON DISK. A credential written by
	 * anyone else is never overwritten.
	 */
	restoreCredentialIfAbsent(provider: string, credential: AuthCredential): boolean {
		const restored = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			if (provider in currentData) {
				return { result: false };
			}
			const merged: AuthStorageData = { ...currentData, [provider]: credential };
			return { result: true, next: JSON.stringify(merged, null, 2) };
		});
		if (restored) {
			this.data[provider] = credential;
			this.clearStaleAuthSource(provider, "stored");
		}
		return restored;
	}

	/**
	 * Disk-authoritative conditional removal: remove `provider`'s credential
	 * ONLY when the ON-DISK value is exactly `expected` (full-object
	 * comparison, not token equality) — a credential written by anyone else is
	 * never deleted. The in-memory cache drops the key only after the write
	 * succeeds.
	 */
	removeIfCredentialMatches(provider: string, expected: AuthCredential): boolean {
		const removed = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			const currentCredential = currentData[provider];
			if (currentCredential === undefined) {
				return { result: false };
			}
			if (JSON.stringify(currentCredential) !== JSON.stringify(expected)) {
				return { result: false };
			}
			const merged: AuthStorageData = { ...currentData };
			delete merged[provider];
			return { result: true, next: JSON.stringify(merged, null, 2) };
		});
		if (removed) {
			delete this.data[provider];
			this.clearStaleAuthSource(provider, "stored");
		}
		return removed;
	}

	/**
	 * Disk-authoritative credential read under the backend's own file lock —
	 * a cross-instance writer is always visible, unlike the cached `get()`.
	 * Used to capture the full identity a guarded login's compare-and-swap
	 * expects to replace (legacy/credential-only accounts included).
	 */
	getVerified(provider: string): AuthCredential | undefined {
		return this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			return { result: currentData[provider] };
		});
	}

	/**
	 * Atomic full-identity compare-and-swap move for guarded MCP logins:
	 * move `stagedProvider`'s credential to `provider` ONLY when the on-disk
	 * value at `provider` is exactly `expectedOld` — the comparison INCLUDES
	 * absence (both present, or both absent) — read and written under the
	 * backend's own file lock. A changed OR deleted grant refuses ("occupied"):
	 * a logged-out account is never reactivated and a newer writer is never
	 * clobbered. Returns the exact credential that moved (for full-identity
	 * rollback).
	 */
	replaceStagedCredential(
		stagedProvider: string,
		provider: string,
		expectedOld: AuthCredential | undefined,
	): { status: "occupied" } | { status: "nothing" } | { status: "replaced"; credential: AuthCredential } {
		type ReplaceOutcome =
			| { status: "occupied" }
			| { status: "nothing" }
			| { status: "replaced"; credential: AuthCredential };
		const outcome = this.storage.withLock<ReplaceOutcome>((current) => {
			const currentData = this.parseStorageData(current);
			const existing = currentData[provider];
			// FULL-IDENTITY comparison INCLUDING absence: the on-disk value must
			// be exactly `expectedOld` (both present, or both absent). A
			// changed OR deleted grant refuses — never reactivate a logged-out
			// account, never clobber a newer writer.
			if (JSON.stringify(existing) !== JSON.stringify(expectedOld)) {
				return { result: { status: "occupied" as const } };
			}
			const staged = currentData[stagedProvider];
			if (!staged) {
				return { result: { status: "nothing" as const } };
			}
			const merged: AuthStorageData = { ...currentData, [provider]: staged };
			delete merged[stagedProvider];
			return {
				result: { status: "replaced" as const, credential: staged },
				next: JSON.stringify(merged, null, 2),
			};
		});
		// Post-success only: refresh the cache under the same lock discipline.
		if (outcome.status === "replaced") {
			this.reload();
		}
		return outcome;
	}

	/**
	 * Atomic full-identity compare-and-swap write: set `provider` to `next`
	 * ONLY when the on-disk value is exactly `expected`. Used to roll back a
	 * guarded replacement (restoring the PREVIOUS credential) and to undo
	 * only this attempt's own write — a newer writer is never clobbered.
	 */
	replaceCredentialIfMatches(provider: string, expected: AuthCredential, next: AuthCredential): boolean {
		const replaced = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			const existing = currentData[provider];
			if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(expected)) {
				return { result: false };
			}
			const merged: AuthStorageData = { ...currentData, [provider]: next };
			return { result: true, next: JSON.stringify(merged, null, 2) };
		});
		if (replaced) {
			this.data[provider] = next;
			this.clearStaleAuthSource(provider, "stored");
		}
		return replaced;
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		this.reloadIfAuthFileChanged();
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		this.reloadIfAuthFileChanged();
		return this.getAvailableAuthCandidate(provider).candidate !== undefined;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		this.reloadIfAuthFileChanged();
		return this.getAuthStatusFromCandidates(provider);
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		this.reloadIfAuthFileChanged();
		return { ...this.data };
	}

	/**
	 * Take the failures recorded so far, newest last.
	 *
	 * Bounded to `MAX_RECORDED_AUTH_ERRORS`: older entries are dropped and the drop is
	 * reported through the structured log. Callers that never drain are the reason an
	 * OAuth refresh failure used to be invisible, so this is consumed on the auth-failure
	 * path in `ModelRegistry`.
	 */
	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Take the pending user-visible side effects of auth operations. Drained rather than read:
	 * each notice describes one removal, and a caller that shows it twice would report a side
	 * effect that did not happen twice.
	 */
	drainNotices(): AuthNotice[] {
		const drained = [...this.notices];
		this.notices = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 *
	 * The store entry is only half of the credential: older versions left renames and
	 * copies of the store in the same directory (`oauth.json`, `oauth.json.migrated`,
	 * `auth.json.bak`, ...), which a refresh token can be exchanged from long after
	 * the store itself was cleared. They are removed here, and the removal is verified
	 * against the value being logged out — a logout that cannot show the token is gone
	 * throws instead of reporting success.
	 *
	 * Prime Inference is the one provider whose credential lives in a file this agent shares
	 * with another tool: the Prime CLI config holds the same `api_key`, and the team selection
	 * next to it is Prime CLI state rather than agent state. Removing it is the logout the user
	 * asked for, and it also signs the `prime` CLI out, so it is recorded as a notice instead of
	 * happening silently.
	 */
	logout(provider: string): void {
		if (provider === PRIME_INFERENCE_PROVIDER_ID && this.isPrimeCliConfigEnabled()) {
			try {
				const configPath = this.getEnabledPrimeCliConfigPath();
				const removal = clearPrimeCliCredentialsWithReport(configPath);
				this.clearStaleAuthSource(provider, "prime_cli");
				if (removal.removedApiKey || removal.removedTeamSelection) {
					this.notices.push({
						provider,
						message:
							`Logged out of Prime Inference by clearing the Prime CLI config at ${configPath}` +
							`${removal.removedApiKey ? ", including its api_key" : ""}` +
							`${removal.removedTeamSelection ? " and its team selection" : ""}.` +
							" Other tools that read that file (the prime CLI among them) lost those credentials too.",
					});
				}
			} catch (error) {
				this.recordError(error);
				throw error;
			}
		}

		// Snapshot before the removal: afterwards the value is gone from memory too.
		const secrets = credentialSecrets(this.data[provider]);
		// Verified removal: logout must not claim success while the entry is still on
		// disk (the silent variant skips the write when the store failed to load).
		this.removeVerified(provider);
		this.purgeLegacyCredentialCopies(secrets);
	}

	/**
	 * Delete every legacy copy of the credential store and confirm that the logged-out
	 * value is not readable in the store directory any more. Called after the store
	 * entry is gone, so the sweep also covers the write that just happened.
	 */
	private purgeLegacyCredentialCopies(secrets: string[]): void {
		const stateDirectory = this.storage.stateDirectory;
		if (!stateDirectory) return;

		purgeLegacyTokenStores(stateDirectory);
		const remaining = findFilesHoldingSecrets(stateDirectory, secrets);
		if (remaining.length > 0) {
			throw new Error(`the credential is still readable in ${remaining.join(", ")}`);
		}
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		let diskContent: string | undefined;
		const result = await this.storage.withLockAsync(async (current) => {
			diskContent = current;
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			diskContent = JSON.stringify(merged, null, 2);
			return { result: refreshed, next: diskContent };
		});

		// The lock's read (or its write) just made the in-memory copy current with the
		// disk: record it, or the next read would mistake it for an external change.
		this.rememberDiskState(diskContent);
		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Prime Inference: environment variable, Prime CLI config, auth.json
	 * 3. Other providers: auth.json, environment variable
	 * 4. Fallback resolver (models.json custom providers)
	 */
	async getApiKeyWithSourceToken(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<AuthApiKeyResult> {
		// The stored credential is served from memory, so this read is the point where a
		// change another process made to auth.json has to be noticed (see
		// reloadIfAuthFileChanged).
		this.reloadIfAuthFileChanged();
		// Runtime overrides take precedence over stored credentials and environment keys.
		const runtimeCandidate = this.getRuntimeAuthCandidate(providerId);
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey && runtimeCandidate && !this.isAuthSourceStale(providerId, runtimeCandidate)) {
			return {
				apiKey: runtimeKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, runtimeCandidate),
			};
		}

		const envCandidate = this.getEnvironmentAuthCandidate(providerId);
		const envKey = getEnvApiKey(providerId);
		if (
			providerId === PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}

		if (providerId === PRIME_INFERENCE_PROVIDER_ID) {
			const primeCliCandidate = this.getPrimeCliAuthCandidate(providerId);
			const primeCliKey = this.getPrimeCliApiKey(providerId);
			if (primeCliKey && primeCliCandidate && !this.isAuthSourceStale(providerId, primeCliCandidate)) {
				return {
					apiKey: primeCliKey,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, primeCliCandidate),
				};
			}
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const hasStaleRecord = this.getMatchingStaleAuthSources(providerId, storedCandidate).length > 0;
				const apiKey =
					cred.key.startsWith("!") && hasStaleRecord
						? resolveConfigValueUncached(cred.key)
						: resolveConfigValue(cred.key);
				const sourceToken =
					apiKey === undefined
						? undefined
						: this.getAuthSourceTokenForCandidate(
								providerId,
								cred.key.startsWith("!")
									? (this.getStoredAuthCandidate(providerId, { resolvedCommandValue: apiKey }) ??
											storedCandidate)
									: storedCandidate,
							);
				return { apiKey, sourceToken, credentialType: "api_key" };
			}
		}

		if (cred?.type === "oauth") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const provider = getOAuthProvider(providerId);
				if (!provider) {
					return {};
				}
				// Lock refreshes so concurrent instances cannot race on the credential file.
				const needsRefresh = Date.now() >= cred.expires;

				if (needsRefresh) {
					try {
						const result = await this.refreshOAuthTokenWithLock(providerId);
						if (result) {
							const refreshedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: result.apiKey,
								credentialType: "oauth",
								sourceToken: refreshedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, refreshedCandidate)
									: undefined,
							};
						}
					} catch (error) {
						this.recordError(error);
						// A peer may have refreshed successfully; reload before treating this refresh as failed.
						this.reload();
						const updatedCred = this.data[providerId];

						if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
							const updatedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: provider.getApiKey(updatedCred),
								credentialType: "oauth",
								sourceToken: updatedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, updatedCandidate)
									: undefined,
							};
						}

						// Preserve credentials for a later /login retry while discovery skips this provider.
						return {};
					}
				} else {
					return {
						apiKey: provider.getApiKey(cred),
						credentialType: "oauth",
						sourceToken: this.getAuthSourceTokenForCandidate(providerId, storedCandidate),
					};
				}
			}
		}
		// Stored auth wins over environment variables for non-Prime-Inference providers.
		if (
			providerId !== PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}
		if (options?.includeFallback !== false) {
			const fallbackCandidate = this.getFallbackAuthCandidate(providerId);
			if (fallbackCandidate && !this.isAuthSourceStale(providerId, fallbackCandidate)) {
				return {
					apiKey: this.fallbackResolver?.(providerId) ?? undefined,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, fallbackCandidate),
				};
			}
		}

		return {};
	}

	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		const result = await this.getApiKeyWithSourceToken(providerId, options);
		return result.apiKey;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}

	private updatePrimeInferenceCredential(
		update: (credential: AuthCredential | undefined) => ApiKeyCredential | undefined,
	): void {
		try {
			const data = this.storage.withLock((current) => {
				const data = this.parseStorageData(current);
				const credential = update(data[PRIME_INFERENCE_PROVIDER_ID]);
				if (!credential) return { result: data };
				data[PRIME_INFERENCE_PROVIDER_ID] = credential;
				return { result: data, next: JSON.stringify(data, null, 2) };
			});
			this.data = data;
			this.loadError = null;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	setPrimeInferenceTeamSelection(team: PrimeTeam | null, expectedApiKey?: string): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				savePrimeCliTeamSelection(team, this.getEnabledPrimeCliConfigPath());
				this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			return;
		}

		this.updatePrimeInferenceCredential((credential) =>
			credential?.type === "api_key" && (expectedApiKey === undefined || credential.key === expectedApiKey)
				? { ...credential, primeTeam: team ? this.toPrimeTeamCredential(team) : null }
				: undefined,
		);
	}

	setPrimeInferenceApiKey(apiKey: string, team?: PrimeTeam | null): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				const configPath = this.getEnabledPrimeCliConfigPath();
				const config = loadPrimeCliConfig(configPath);
				const existingCredential = this.data[PRIME_INFERENCE_PROVIDER_ID];
				const legacyPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
				if (config.apiKey !== apiKey) {
					savePrimeCliApiKey(apiKey, configPath);
				} else if (!config.teamIdFromEnv && (legacyPrimeTeam === null || (!config.teamId && legacyPrimeTeam))) {
					savePrimeCliTeamSelection(legacyPrimeTeam, configPath);
				}
				this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			if (this.data[PRIME_INFERENCE_PROVIDER_ID]) {
				this.remove(PRIME_INFERENCE_PROVIDER_ID);
			}
			return;
		}

		this.updatePrimeInferenceCredential((existing) => {
			// Omission semantics are the fork's: no primeTeam key at all when there is neither an
			// explicit selection nor a stored one, so a re-used Prime CLI key round-trips as
			// { type, key } (test/auth-flows.test.ts "stores a reused Prime CLI key ..."). An
			// explicit `null` still means "user picked no team" and is preserved on re-key
			// (test/auth-storage.test.ts:725).
			const existingPrimeTeam = existing?.type === "api_key" ? existing.primeTeam : undefined;
			return {
				type: "api_key",
				key: apiKey,
				...(team !== undefined
					? { primeTeam: team ? this.toPrimeTeamCredential(team) : null }
					: existingPrimeTeam !== undefined
						? { primeTeam: existingPrimeTeam }
						: {}),
			};
		});
		this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "stored");
	}

	getPrimeInferenceTeamSelection(): PrimeTeamCredential | null | undefined {
		if (process.env.PRIME_TEAM_ID?.trim()) return undefined;
		let config: PrimeCliConfig | undefined;
		if (this.isPrimeCliConfigEnabled()) {
			config = this.getPrimeCliConfig(PRIME_INFERENCE_PROVIDER_ID);
			if (config?.teamIdFromEnv) {
				return undefined;
			}
		}

		const credential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		const authSource = this.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID).source;
		if (authSource === "runtime" || authSource === "environment") {
			return undefined;
		}
		if (authSource === "prime_cli") {
			if (credential?.type === "api_key" && credential.primeTeam === null) {
				return null;
			}
			if (config?.teamId) {
				return this.toPrimeTeamCredential({
					teamId: config.teamId,
					name: config.teamName ?? "Prime CLI team",
					...(config.teamRole ? { role: config.teamRole } : {}),
				});
			}
			if (credential?.type === "api_key" && credential.primeTeam) {
				return credential.primeTeam;
			}
			return null;
		}
		if (credential?.type === "api_key" && credential.primeTeam !== undefined) {
			return credential.primeTeam;
		}
		if (!config?.apiKey && config?.teamId) {
			return this.toPrimeTeamCredential({
				teamId: config.teamId,
				name: config.teamName ?? "Prime CLI team",
				...(config.teamRole ? { role: config.teamRole } : {}),
			});
		}
		return undefined;
	}

	getProviderHeaders(providerId: string): Record<string, string> | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}

		const envTeamId = process.env.PRIME_TEAM_ID?.trim();
		if (envTeamId) {
			return { "X-Prime-Team-ID": envTeamId };
		}

		const primeCliConfig = this.getPrimeCliConfig(providerId);
		if (primeCliConfig?.teamIdFromEnv) {
			return primeCliConfig.teamId ? { "X-Prime-Team-ID": primeCliConfig.teamId } : undefined;
		}

		const teamId = this.getPrimeInferenceTeamSelection()?.teamId;
		return teamId ? { "X-Prime-Team-ID": teamId } : undefined;
	}

	getPrimeCliConfigPath(): string | undefined {
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return getPrimeCliConfigPath(this.options.primeCliConfigPath);
	}

	private toPrimeTeamCredential(team: PrimeTeam): PrimeTeamCredential {
		const credential: PrimeTeamCredential = {
			teamId: team.teamId,
			name: team.name,
		};
		if (team.slug) {
			credential.slug = team.slug;
		}
		if (team.role) {
			credential.role = team.role;
		}
		if (team.createdAt) {
			credential.createdAt = team.createdAt;
		}
		return credential;
	}

	private getPrimeCliConfig(providerId: string): PrimeCliConfig | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return loadPrimeCliConfig(this.options.primeCliConfigPath);
	}

	private getPrimeCliApiKey(providerId: string): string | undefined {
		return this.getPrimeCliConfig(providerId)?.apiKey;
	}

	/**
	 * The Prime CLI config path when that source is enabled, and a loud failure when
	 * it is not: callers here only run behind isPrimeCliConfigEnabled(), so an
	 * undefined path means the two checks disagreed.
	 */
	private getEnabledPrimeCliConfigPath(): string {
		const configPath = this.getPrimeCliConfigPath();
		if (!configPath) {
			throw new Error("Prime CLI config is not enabled");
		}
		return configPath;
	}

	private isPrimeCliConfigEnabled(): boolean {
		return Boolean(this.options.usePrimeCliConfig || this.options.primeCliConfigPath);
	}
}
