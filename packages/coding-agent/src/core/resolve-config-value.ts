/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.js";

/**
 * How long a *failed* command resolution is served from the cache before it is run
 * again. A failure is usually transient - `!cat /run/secrets/token` before the file
 * exists, a credential helper timing out, a network-backed command blipping - and
 * caching it forever meant the credential never resolved again without a restart.
 * The window is what keeps a permanently broken command from being spawned on every
 * model call: inside it, the cached failure is served and nothing runs.
 */
export const COMMAND_FAILURE_RETRY_AFTER_MS = 30_000;

interface CachedCommandResult {
	value: string | undefined;
	/** Epoch millis after which a failed result may be re-resolved; absent for a resolved value. */
	retryAfter?: number;
}

const commandResultCache = new Map<string, CachedCommandResult>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	return resolveEnvOrLiteral(config);
}

/** Unset env var: fall back to the literal string. Set-but-empty: missing credential, never the var name. */
function resolveEnvOrLiteral(config: string): string | undefined {
	const envValue = process.env[config];
	if (envValue !== undefined) {
		return envValue || undefined;
	}
	return config;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined && (cached.retryAfter === undefined || cached.retryAfter > Date.now())) {
		return cached.value;
	}

	const result = executeCommandUncached(commandConfig);
	// A resolved credential is cached for the lifetime of the process, as before; only
	// the failure gets an expiry.
	commandResultCache.set(
		commandConfig,
		result === undefined
			? { value: undefined, retryAfter: Date.now() + COMMAND_FAILURE_RETRY_AFTER_MS }
			: { value: result },
	);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommandUncached(config);
	}
	return resolveEnvOrLiteral(config);
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
	const resolvedValue = resolveConfigValueUncached(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}
