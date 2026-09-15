import { dirname, resolve } from "node:path";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";

/**
 * Which background services a stop command may touch.
 *
 * `socket-dir` is the set the calling shell actually talks to: every daemon
 * whose socket lives in one directory, which is exactly the daemon identity
 * (`$TMPDIR/prime-agent-<uid>`) that `list`/`attach`/`stop` resolve to. `socket`
 * names one daemon. `machine` is the whole-machine sweep and is only ever
 * reached through an explicit `--all`.
 */
/** A scope that still has to be bound to the process that will act on it. */
export type CurrentShutdownScope = { kind: "current" };

/** A scope that already names services by path. */
export type BoundShutdownScope =
	| { kind: "machine" }
	| { kind: "socket-dir"; socketDir: string }
	| { kind: "socket"; socketPath: string };

export type ShutdownScope = CurrentShutdownScope | BoundShutdownScope;

export const MACHINE_SCOPE: ShutdownScope = { kind: "machine" };

/** The set this process talks to. Never whole-machine. */
export function currentShutdownScope(): BoundShutdownScope {
	return { kind: "socket-dir", socketDir: resolve(defaultDaemonSocketDir()) };
}

/**
 * Bind a scope to this process. `current` is what the CLI layer carries: the
 * whole-machine check needs no path, and a path must not be frozen before the
 * command has resolved its own environment. On win32 there is no socket dir
 * (the daemon is one named pipe per user), so `current` binds to that pipe.
 */
export function resolveShutdownScope(scope: ShutdownScope): BoundShutdownScope {
	if (scope.kind !== "current") {
		return scope;
	}
	if (process.platform === "win32") {
		return { kind: "socket", socketPath: normalizeSocketPath(defaultDaemonSocketPath()) };
	}
	return currentShutdownScope();
}

export function describeShutdownScope(scope: ShutdownScope): string {
	switch (scope.kind) {
		case "current":
			return describeShutdownScope(resolveShutdownScope(scope));
		case "machine":
			return "every background service discovered on this machine";
		case "socket-dir":
			return `background services in socket dir ${scope.socketDir}`;
		case "socket":
			return `the background service on socket ${scope.socketPath}`;
	}
}

export function matchesShutdownScope(socketPath: string, scope: ShutdownScope): boolean {
	if (scope.kind === "current") {
		return matchesShutdownScope(socketPath, resolveShutdownScope(scope));
	}
	if (scope.kind === "machine") {
		return true;
	}
	const target = resolve(normalizeSocketPath(socketPath));
	if (scope.kind === "socket") {
		return target === resolve(normalizeSocketPath(scope.socketPath));
	}
	return dirname(target) === resolve(scope.socketDir);
}

export interface StopSelection {
	scope: ShutdownScope;
	/** Restrict to services with no live evidence: idle leftovers and dead sockets. */
	orphansOnly: boolean;
}

export const MACHINE_STOP_SELECTION: StopSelection = { scope: MACHINE_SCOPE, orphansOnly: false };

export interface StopSelectionFlags {
	all?: boolean;
	orphansOnly?: boolean;
	socketPath?: string;
	socketDir?: string;
}

export type StopSelectionResult = { ok: true; selection: StopSelection } | { ok: false; error: string };

/** Turn the scope flags into one selection. Whole-machine is never the fallback. */
export function resolveStopSelection(flags: StopSelectionFlags): StopSelectionResult {
	const named = flags.socketPath !== undefined || flags.socketDir !== undefined;
	if (flags.all && named) {
		return { ok: false, error: "--all cannot be combined with --socket/--socket-dir: pick one scope." };
	}
	if (flags.socketPath !== undefined && flags.socketDir !== undefined) {
		return { ok: false, error: "--socket and --socket-dir name different scopes; use one of them." };
	}
	const orphansOnly = flags.orphansOnly === true;
	if (flags.socketPath !== undefined) {
		return { ok: true, selection: { scope: { kind: "socket", socketPath: flags.socketPath }, orphansOnly } };
	}
	if (flags.socketDir !== undefined) {
		return { ok: true, selection: { scope: { kind: "socket-dir", socketDir: flags.socketDir }, orphansOnly } };
	}
	return {
		ok: true,
		selection: { scope: flags.all === true ? MACHINE_SCOPE : { kind: "current" }, orphansOnly },
	};
}
