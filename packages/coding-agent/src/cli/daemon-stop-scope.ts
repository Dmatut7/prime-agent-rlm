import { dirname, resolve } from "node:path";
import { getAgentDir } from "../config.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { findLiveDaemonOwnersForAgentDir } from "../modes/daemon/daemon-supervisor-ownership.js";

/**
 * Which background services a stop command may touch.
 *
 * `daemon-identity` is the set the calling process actually talks to: every
 * daemon whose socket lives in this shell's socket dir, plus every live daemon
 * that owns this process's agent dir. `socket-dir` and `socket` are what the
 * user named with `--socket-dir`/`--socket`. `machine` is the whole-machine
 * sweep and is only ever reached through an explicit `--all`.
 */
/** A scope that still has to be bound to the process that will act on it. */
export type CurrentShutdownScope = { kind: "current" };

/** A scope that already names services by path. */
export type BoundShutdownScope =
	| { kind: "machine" }
	| { kind: "socket-dir"; socketDir: string }
	| { kind: "socket"; socketPath: string }
	// One agent dir's own services: the socket dir plus the sockets of the live
	// daemons the supervisor registry says own this agent dir. The extra paths are
	// never found by name or by directory, so another instance's services stay out.
	| { kind: "daemon-identity"; socketDir: string; agentDir: string; agentSocketPaths: readonly string[] };

export type ShutdownScope = CurrentShutdownScope | BoundShutdownScope;

export const MACHINE_SCOPE: ShutdownScope = { kind: "machine" };

/**
 * The socket dir this process talks to, without reading the registry.
 *
 * A stop command binds through `bindStopSelection` instead, which adds the
 * daemons this agent dir owns on other paths. This sync form is the conservative
 * fallback for anything that must decide without awaiting.
 */
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
		case "daemon-identity":
			return scope.agentSocketPaths.length === 0
				? `background services in socket dir ${scope.socketDir}`
				: `background services in socket dir ${scope.socketDir} and the daemon(s) serving agent dir ${scope.agentDir}`;
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
	if (scope.kind === "daemon-identity") {
		return (
			dirname(target) === resolve(scope.socketDir) ||
			scope.agentSocketPaths.some((agentSocketPath) => resolve(normalizeSocketPath(agentSocketPath)) === target)
		);
	}
	return dirname(target) === resolve(scope.socketDir);
}

/**
 * The services this process owns: its shell's socket dir, plus every live daemon
 * that owns its agent dir.
 *
 * Whole-machine this is not: the second leg is read from the supervisor
 * registry, filtered to one agent dir and to records whose process identity is
 * still alive, which is the same authority `resolveDaemonSocketForAgentDir` uses
 * to decide what to connect to. Degrades to the socket dir when the registry is
 * unreachable or names nothing outside it.
 */
export async function currentDaemonIdentityScope(
	options: { agentDir?: string; registryDir?: string } = {},
): Promise<BoundShutdownScope> {
	if (process.platform === "win32") {
		// One named pipe per user is the whole identity there; there is no socket
		// dir to widen and no second listening face to discover.
		return { kind: "socket", socketPath: normalizeSocketPath(defaultDaemonSocketPath()) };
	}
	const socketDir = resolve(defaultDaemonSocketDir());
	const agentDir = options.agentDir ?? getAgentDir();
	const owners = await findLiveDaemonOwnersForAgentDir(agentDir, options.registryDir);
	const agentSocketPaths = [
		...new Set(
			owners
				.map((owner) => resolve(normalizeSocketPath(owner.socketPath)))
				.filter((socketPath) => dirname(socketPath) !== socketDir),
		),
	];
	return { kind: "daemon-identity", socketDir, agentDir, agentSocketPaths };
}

/** Replace an unbound `current` scope with what this process owns; never widen a named scope. */
export async function bindStopSelection(
	selection: StopSelection,
	options: { agentDir?: string; registryDir?: string } = {},
): Promise<StopSelection> {
	if (selection.scope.kind !== "current") {
		return selection;
	}
	return { ...selection, scope: await currentDaemonIdentityScope(options) };
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
