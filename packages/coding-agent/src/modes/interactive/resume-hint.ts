import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Args } from "../../cli/args.js";
import { APP_NAME } from "../../config.js";
import type { SessionStats } from "../../core/session-stats.js";

export type ResumeHintStats = Pick<SessionStats, "sessionId" | "sessionFile" | "userMessages">;

/**
 * The connection flags the session was started with. The exit hint replays them
 * so copying the printed command reattaches to the same daemon/session store
 * instead of the default one (wave-47 B).
 */
export interface ResumeHintConnection {
	daemonSocket?: string;
	sessionDir?: string;
}

/** The parsed CLI flags the exit hint replays; undefined when the launch used defaults throughout. */
export function resumeHintConnectionFromArgs(
	parsed: Pick<Args, "daemonSocket" | "sessionDir">,
): ResumeHintConnection | undefined {
	const connection: ResumeHintConnection = {
		...(parsed.daemonSocket ? { daemonSocket: parsed.daemonSocket } : {}),
		...(parsed.sessionDir ? { sessionDir: parsed.sessionDir } : {}),
	};
	return connection.daemonSocket || connection.sessionDir ? connection : undefined;
}

/** A shell-safe flag value: bare when it is one, single-quoted otherwise. */
function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_\-./:~]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Omit ephemeral and unflushed empty sessions because neither can be resumed. */
export function formatResumeHint(
	stats: ResumeHintStats | undefined,
	connection?: ResumeHintConnection,
): string | undefined {
	if (!stats?.sessionFile || stats.userMessages === 0) return undefined;
	// Persistence is lazy: nothing is written until the first assistant message
	// arrives, so exiting before then leaves no file to resume from.
	if (!existsSync(stats.sessionFile)) return undefined;
	const flags = [
		connection?.daemonSocket ? `--daemon-socket ${shellQuote(connection.daemonSocket)}` : undefined,
		connection?.sessionDir ? `--session-dir ${shellQuote(connection.sessionDir)}` : undefined,
	].filter((flag): flag is string => flag !== undefined);
	const command = [APP_NAME, ...flags, "--resume", stats.sessionId].join(" ");
	return chalk.dim(`下次继续：${command}`);
}
