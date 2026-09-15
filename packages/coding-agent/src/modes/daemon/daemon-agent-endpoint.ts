import { getAgentDir } from "../../config.js";
import { defaultDaemonSocketPath, isDaemonSocketListening, normalizeSocketPath } from "./daemon-socket.js";
import { type DaemonSupervisorOwnerSummary, findLiveDaemonOwnersForAgentDir } from "./daemon-supervisor-ownership.js";

/** Where a resolved endpoint came from, so callers can say why they talk to that socket. */
export type DaemonEndpointSource = "default" | "agent-dir-registry";

export interface ResolvedDaemonEndpoint {
	socketPath: string;
	source: DaemonEndpointSource;
	/** The live daemon that owns this agent dir, when the endpoint was discovered rather than assumed. */
	owner?: DaemonSupervisorOwnerSummary;
}

/**
 * The socket a client without an explicit `--daemon-socket` should talk to.
 *
 * The default socket path is derived from `$TMPDIR` and the uid, so it names a
 * *shell*, not a daemon: the same agent dir reached from a shell with a different
 * `$TMPDIR` computes a different path, finds nothing there, and reports ENOENT
 * for sessions that are running perfectly well. The agent dir is the stable
 * identity — the daemon and the client that share it also share sessions,
 * harness state and leases — so the registry that already records each daemon's
 * agent dir (and lives outside `$TMPDIR`) is what decides the endpoint:
 *
 * 1. the shell's own default socket, when a daemon is bound there (the common
 *    case, unchanged, and it stays the path a fresh daemon is started on);
 * 2. otherwise the live daemon that owns this agent dir, wherever its socket is.
 *
 * Discovery is what makes a second daemon unnecessary: a client in a foreign
 * `$TMPDIR` reuses the running daemon for its agent dir instead of starting one.
 */
export async function resolveDaemonSocketForAgentDir(
	options: { agentDir?: string; registryDir?: string } = {},
): Promise<ResolvedDaemonEndpoint> {
	const defaultSocketPath = normalizeSocketPath(defaultDaemonSocketPath());
	if (await isDaemonSocketListening(defaultSocketPath)) {
		return { socketPath: defaultSocketPath, source: "default" };
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const owners = await findLiveDaemonOwnersForAgentDir(agentDir, options.registryDir);
	for (const owner of owners) {
		const socketPath = normalizeSocketPath(owner.socketPath);
		if (socketPath === defaultSocketPath) {
			// Alive in the registry but not listening (still booting, or a stale
			// record): the default path above is the better answer either way.
			continue;
		}
		if (await isDaemonSocketListening(socketPath)) {
			return { socketPath, source: "agent-dir-registry", owner };
		}
	}
	return { socketPath: defaultSocketPath, source: "default" };
}
