import { findClaudeCodeExecutable } from "@earendil-works/pi-ai";
import { execFileHidden } from "../../utils/child-process.js";

/**
 * The claude-code provider's availability probe is ambient: an installed `claude` binary
 * counts as a credential (packages/ai env-api-keys.ts), so a machine that never ran
 * `claude auth login` shows every claude-code model as signed in. The binary is not the
 * credential — the CLI's own login state is, and it answers cheaply and locally via
 * `claude auth status` (exit code is 1 when logged out, but the JSON answer is on stdout
 * either way). This module asks the CLI; callers cache the answer.
 */

const AUTH_STATUS_TIMEOUT_MS = 5000;

export interface ClaudeCodeLoginProbeDeps {
	findExecutable?: () => string | undefined;
	/** Override for CLAUDE_CODE_OAUTH_TOKEN; the provider passes it through to the CLI. */
	envToken?: string;
	runAuthStatus?: (executable: string, timeoutMs: number) => Promise<string>;
}

function defaultRunAuthStatus(executable: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFileHidden(executable, ["auth", "status"], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
			// A logged-out CLI exits 1 with the answer still on stdout; only a missing
			// answer (spawn failure, timeout, ancient CLI without the subcommand) is an error.
			if (stdout.trim().length > 0) {
				resolve(stdout);
				return;
			}
			reject(error ?? new Error("claude auth status returned no output"));
		});
	});
}

function parseAuthStatusLoggedIn(stdout: string): boolean {
	try {
		const parsed: unknown = JSON.parse(stdout);
		return typeof parsed === "object" && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true;
	} catch {
		return false;
	}
}

/**
 * True when a claude-code request can actually run: the binary exists and either carries
 * the long-lived token env var or reports `loggedIn` from `claude auth status`. Anything
 * unverifiable (no binary, dead probe, garbled answer) is false — the badge errs toward
 * "需登录", which is the direction the menu knows how to act on.
 */
export async function checkClaudeCodeLoggedIn(deps: ClaudeCodeLoginProbeDeps = {}): Promise<boolean> {
	const executable = (deps.findExecutable ?? findClaudeCodeExecutable)();
	if (!executable) return false;
	const envToken = deps.envToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
	if (envToken) return true;
	const runAuthStatus = deps.runAuthStatus ?? defaultRunAuthStatus;
	try {
		return parseAuthStatusLoggedIn(await runAuthStatus(executable, AUTH_STATUS_TIMEOUT_MS));
	} catch {
		return false;
	}
}
