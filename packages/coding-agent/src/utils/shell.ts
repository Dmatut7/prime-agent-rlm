import { existsSync } from "node:fs";
import { delimiter, win32 } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

// Hardcoded literals: ProgramFiles env vars are ambient attacker-influenceable
// input, the same trust-laundering class as PATH.
const WINDOWS_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the canonical Git Bash install paths,
 * never PATH (a repo-controlled PATH/where.exe must not pick the kernel shell).
 * undefined = no shell found: kernel startup must not fail, bash() raises its
 * teaching error.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	for (const path of WINDOWS_GIT_BASH_PATHS) {
		if (existsSync(path)) {
			return path;
		}
	}
	return undefined;
}

/**
 * Env keys shell-tool children (the bash tool, exec, extensions) may inherit.
 * These children run model-authored or third-party code (npm postinstall
 * scripts, test suites), so the base is an allowlist — mirroring the kernel's
 * MCP stdio `_SAFE_ENV` — rather than the worker's full process.env: supervisor
 * auth tokens (PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN), recursion
 * bookkeeping (RLM_*), provider credentials (SERPER_API_KEY, ANTHROPIC_*,
 * ...) and the user's agent sockets (SSH_AUTH_SOCK) must not ride along into
 * arbitrary commands.
 *
 * The agent's own CLI also travels through this channel (self-update, nested
 * `prime-agent` runs), so the non-secret routing and opt-out names that CLI
 * reads are forwarded: the update routing pair (supervisor socket path, origin
 * session id — paths and ids, never the worker token), the agentDir/sessionDir
 * pins and supervisor registry dir (a nested CLI must target the daemon and
 * directories its parent already owns), and the documented privacy opt-outs
 * (DO_NOT_TRACK/PI_OFFLINE/PRIME_AGENT_TELEMETRY — losing them would silently
 * undo the offline/telemetry switches for nested runs). Keep the kernel table
 * (`prime-agent-runtime/src/rlm/bash.py` `_CHILD_SAFE_ENV`) in sync.
 */
const SHELL_CHILD_SAFE_ENV_KEYS = [
	"HOME",
	"PATH",
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"OS",
	"SYSTEMDRIVE",
	"USERPROFILE",
	// Non-secret routing/opt-out names for the agent's own CLI (see above).
	"PRIME_AGENT_CODING_AGENT_DIR",
	"PRIME_AGENT_SESSION_DIR",
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR",
	"DO_NOT_TRACK",
	"PI_OFFLINE",
	"PRIME_AGENT_TELEMETRY",
	"PRIME_AGENT_TRUSTED_UPDATE_ORIGINS",
] as const;

/** Comma-separated env names a user opts back in for shell-tool children. */
export const SHELL_ENV_PASSTHROUGH_VAR = "PRIME_AGENT_ENV_PASSTHROUGH";

export function sanitizedChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SHELL_CHILD_SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const name of (process.env[SHELL_ENV_PASSTHROUGH_VAR] ?? "").split(",")) {
		const trimmed = name.trim();
		const value = trimmed ? process.env[trimmed] : undefined;
		if (value !== undefined) {
			env[trimmed] = value;
		}
	}
	return {
		...env,
		// Agent-spawned shells never have a usable stdin (stdio: ["ignore", "pipe", "pipe"]),
		// so any interactive prompt opened via /dev/tty is a guaranteed hang until killed:
		// `git commit` without -m launches $EDITOR, credential helpers block waiting for a
		// password, pagers read the terminal directly. Make those cases fail fast or no-op
		// instead of hanging.
		//
		// These deliberately override inherited terminal settings — an EDITOR=vim inherited
		// from the launching shell (or opted back in through PRIME_AGENT_ENV_PASSTHROUGH) is
		// exactly the hang we are preventing, and stdin is ignored even for user `!`
		// commands, so an interactive editor can never receive keystrokes anyway. A user who
		// wants a prompt in a specific command can override inline (`GIT_EDITOR=vim git
		// commit`), which takes precedence over exported vars. Kept in sync with the kernel
		// side in `prime-agent-runtime/src/rlm/bash.py` `_child_env()`.
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_TERMINAL_PROMPTS: "0",
		GIT_ASKPASS: "true",
		SSH_ASKPASS_REQUIRE: "never",
		EDITOR: "true",
		VISUAL: "true",
		PAGER: "cat",
		GIT_PAGER: "cat",
		DEBIAN_FRONTEND: "noninteractive",
	};
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const base = sanitizedChildEnv();
	const binDir = getBinDir();
	const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = base[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...base,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	recordOrphanProcessState(pid, true);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	recordOrphanProcessState(pid, false);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
		recordOrphanProcessState(pid, false);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Absolute System32 taskkill, like killOrphanProcess: a bare "taskkill"
		// name can resolve a planted PATH/CWD binary. Spawn failures surface as
		// async "error" events, so the listener is mandatory, not optional.
		try {
			const child = spawn(
				win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
				},
			);
			child.on("error", () => {
				// A dead, reused, or unkillable pid must not crash the caller.
			});
		} catch {
			// Ignore synchronous spawn failures
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
