import chalk from "chalk";
import { APP_NAME } from "../config.js";
import type { DaemonInfo, DaemonStatus } from "./daemon-ps.js";

/**
 * What this CLI knows about its own build. The human views use it to turn
 * "outdated" into a comparison the operator can check, and it is the same
 * identity the daemon handshake carries (`getDaemonRuntimeIdentity`), which is
 * what the launch-side staleness check compares against.
 */
export interface ClientBuildIdentity {
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	/** A commit-level build id. Undefined when this process cannot name one. */
	buildId?: string;
	executablePath?: string;
	/** Why `buildId` is absent, phrased for the user. */
	buildIdUnavailableReason?: string;
}

const UNKNOWN_CELL = "-";

/** A build id that only repeats the version cannot tell two builds apart. */
export function isVersionOnlyBuildId(buildId: string | undefined, version: string | undefined): boolean {
	if (buildId === undefined || version === undefined) {
		return false;
	}
	return buildId === `release-${version}` || buildId === version || buildId === `v${version}`;
}

/**
 * Why a reachable service is not this build, spelled out with the fields that
 * decide it. Two builds of the same app version differ only in build id and in
 * the code they were started from, so "not this build" is never printed without
 * the criterion that says so.
 */
export function describeBuildMismatch(daemon: DaemonInfo, client: ClientBuildIdentity): string {
	const criteria = [
		buildIdComparison(daemon, client),
		...identityFieldDifferences(daemon, client),
		...executableComparison(daemon, client),
	];
	if (criteria.length === 1) {
		criteria.push("no other reported identity field differs");
	}
	return `built ${daemon.version ?? "unknown"} (${criteria.join("; ")})`;
}

function buildIdComparison(daemon: DaemonInfo, client: ClientBuildIdentity): string {
	const thisBuild = client.buildId === undefined ? clientBuildIdUnavailable(client) : `this build ${client.buildId}`;
	if (isVersionOnlyBuildId(daemon.buildId, daemon.version)) {
		return `daemon buildId ${daemon.buildId} names only its version, ${thisBuild}`;
	}
	if (daemon.buildId === undefined) {
		return `daemon reported no buildId, ${thisBuild}`;
	}
	if (client.buildId === undefined) {
		return `buildId ${daemon.buildId}, ${thisBuild}`;
	}
	return daemon.buildId === client.buildId
		? `buildId ${daemon.buildId} matches this build`
		: `buildId ${daemon.buildId} != this build ${client.buildId}`;
}

/** The code each side runs, when both name one. It is the last discriminator left. */
function executableComparison(daemon: DaemonInfo, client: ClientBuildIdentity): string[] {
	if (daemon.executablePath === undefined || client.executablePath === undefined) {
		return [];
	}
	return daemon.executablePath === client.executablePath
		? [`same executable ${daemon.executablePath}`]
		: [`executable ${daemon.executablePath} != this build ${client.executablePath}`];
}

/** The version/protocol/schema pairs that differ; an unknown side is no evidence. */
function identityFieldDifferences(daemon: DaemonInfo, client: ClientBuildIdentity): string[] {
	const differences: string[] = [];
	if (daemon.version !== undefined && client.version !== undefined && daemon.version !== client.version) {
		differences.push(`version ${daemon.version} != ${client.version}`);
	}
	if (
		daemon.protocolVersion !== undefined &&
		client.protocolVersion !== undefined &&
		daemon.protocolVersion !== client.protocolVersion
	) {
		differences.push(`protocol ${daemon.protocolVersion} != ${client.protocolVersion}`);
	}
	if (daemon.schemaId !== undefined && client.schemaId !== undefined && daemon.schemaId !== client.schemaId) {
		differences.push(`schema ${daemon.schemaId} != ${client.schemaId}`);
	}
	return differences;
}

function clientBuildIdUnavailable(client: ClientBuildIdentity): string {
	return thisBuildLabel(client);
}

/** This CLI's own build, or the honest reason it cannot name one. */
function thisBuildLabel(client: ClientBuildIdentity): string {
	return (
		client.buildId ??
		(client.buildIdUnavailableReason
			? `this process buildId unknown (${client.buildIdUnavailableReason})`
			: "this process buildId unknown")
	);
}

/** This CLI's own build, so a table of other builds has something to read against. */
export function formatClientBuildSummary(client: ClientBuildIdentity): string {
	return `this build  ${thisBuildLabel(client)}  executable ${client.executablePath ?? UNKNOWN_CELL}`;
}

/** What to do about an outdated service, in one line, naming this build. */
export function formatShutdownNextSteps(client: ClientBuildIdentity): string {
	return (
		`Next: this CLI is ${thisBuildLabel(client)} at ${client.executablePath ?? UNKNOWN_CELL}. ` +
		`After the services above stop, the next ${APP_NAME} command starts them on this build. ` +
		`Confirm with: ${APP_NAME} status`
	);
}

type DaemonRow = {
	socket: string;
	pid: string;
	version: string;
	buildId: string;
	status: string;
	sessions: string;
	live: string;
	uptime: string;
	executable: string;
};

export function formatDaemonListTable(daemons: readonly DaemonInfo[], client?: ClientBuildIdentity): string {
	const execCells = formatExecutableCells(daemons.map((daemon) => daemon.executablePath));
	const rows = daemons.map(
		(daemon, index): DaemonRow => ({
			socket: daemon.isDefault ? `${daemon.socketPath} *` : daemon.socketPath,
			pid: daemon.pid !== undefined ? String(daemon.pid) : "",
			version: daemon.version ?? "",
			buildId: daemon.buildId ?? UNKNOWN_CELL,
			status: daemon.status,
			sessions: daemon.sessionCount !== undefined ? String(daemon.sessionCount) : "",
			live: daemon.liveness === "live" ? (daemon.livenessEvidence ?? []).join(", ") : "",
			uptime: formatUptime(daemon.uptimeSeconds),
			executable: execCells[index] ?? UNKNOWN_CELL,
		}),
	);
	const table = formatTable(
		["socket", "pid", "version", "buildId", "status", "sessions", "live", "uptime", "executable"],
		rows,
		formatDaemonCell,
	);
	// Warm pool lines appear only for daemons that actually answered
	// get_warm_pool_stats (rev 45): a daemon that never advertised the capability
	// carries no warmPool field and gets no line, so an old daemon's output is
	// byte-identical to before.
	const poolLines = daemons.flatMap((daemon) => {
		const line = formatDaemonWarmPoolLine(daemon);
		return line === undefined ? [] : [line];
	});
	const withPools = poolLines.length === 0 ? table : `${table}\n\n${poolLines.join("\n")}`;
	const notes = daemons.some((daemon) => daemon.isDefault) ? ["* default background service"] : [];
	if (client) {
		notes.push(formatClientBuildSummary(client));
	}
	if (daemons.some((daemon) => daemon.status === "outdated" || daemon.status === "stale")) {
		notes.push(formatDaemonStatusLegend());
	}
	return notes.length === 0 ? withPools : `${withPools}\n\n${chalk.dim(notes.join("\n"))}`;
}

/**
 * One per-daemon warm pool line for the status/ps views, or undefined when the
 * daemon has no pool facts (an old daemon never carries the field, so nothing
 * renders for it). Claims/spawns are supervisor-lifetime counters and reset on
 * daemon restart; the line says so when any of them is nonzero.
 */
export function formatDaemonWarmPoolLine(
	daemon: Pick<DaemonInfo, "socketPath" | "isDefault" | "warmPool">,
): string | undefined {
	const pool = daemon.warmPool;
	if (pool === undefined) {
		return undefined;
	}
	const label = `warm pool ${daemon.isDefault ? `${daemon.socketPath} *` : daemon.socketPath}:`;
	if (!pool.enabled) {
		return `${label} disabled`;
	}
	const claimsTotal = pool.totals.claims.hit + pool.totals.claims.miss + pool.totals.claims.expired;
	const hitRate = claimsTotal === 0 ? "-" : `${((pool.totals.claims.hit / claimsTotal) * 100).toFixed(0)}%`;
	const reclaimBits = Object.entries(pool.totals.reclaims)
		.filter(([, count]) => count > 0)
		.map(([reason, count]) => `${reason} ${count}`);
	const segments = [
		`depth ready ${pool.depth.ready} warming ${pool.depth.warming}`,
		`claims hit ${pool.totals.claims.hit} (${hitRate}) miss ${pool.totals.claims.miss} expired ${pool.totals.claims.expired}`,
		`spawns ready ${pool.totals.spawns.ready} failed ${pool.totals.spawns.failed}`,
	];
	if (reclaimBits.length > 0) {
		segments.push(`reclaims ${reclaimBits.join(", ")}`);
	}
	if (pool.spares.length > 0) {
		segments.push(
			`spares ${pool.spares.map((spare) => `${spare.cwd} age ${formatUptime(spare.ageMs / 1000)}`).join(", ")}`,
		);
	}
	if (pool.cooldowns.length > 0) {
		segments.push(
			`cooldowns ${pool.cooldowns
				.map(
					(cooldown) => `${cooldown.cwd} retry in ${formatUptime(cooldown.retryInMs / 1000)} (${cooldown.reason})`,
				)
				.join(", ")}`,
		);
	}
	const lifetimeNote =
		claimsTotal > 0 || pool.totals.spawns.ready > 0 || pool.totals.spawns.failed > 0
			? " (counters reset on daemon restart)"
			: "";
	return `${label} ${segments.join(" · ")}${lifetimeNote}`;
}

const EXEC_CELL_BUDGET = 44;
const EXEC_CELL_HEAD_SEGMENTS = 3;

/**
 * Shorten each executable path for the table. A path that fits is shown whole;
 * a longer one keeps its root, where a worktree and an installed build differ,
 * plus as many trailing segments as it takes that no other discovered install
 * reads the same cell.
 */
function formatExecutableCells(paths: readonly (string | undefined)[]): (string | undefined)[] {
	const distinct = [...new Set(paths.filter((path): path is string => path !== undefined && path.length > 0))];
	if (distinct.length === 0) {
		return paths.map(() => undefined);
	}
	const segmentsOf = (path: string): string[] => path.split(/[/]+/).filter((segment) => segment.length > 0);
	const cellAt = (path: string, keep: number): string => {
		if (path.length <= EXEC_CELL_BUDGET) {
			return path;
		}
		const segments = segmentsOf(path);
		const headCount = Math.max(1, Math.min(EXEC_CELL_HEAD_SEGMENTS, segments.length - keep - 1));
		const head = segments.slice(0, headCount).join("/");
		const tail = segments.slice(-Math.min(keep, segments.length)).join("/");
		return `${path.startsWith("/") ? "/" : ""}${head}/.../${tail}`;
	};
	const longest = Math.max(...distinct.map((path) => segmentsOf(path).length));
	let keep = 1;
	let cells = new Map(distinct.map((path) => [path, cellAt(path, keep)]));
	while (keep < longest && new Set(cells.values()).size < cells.size) {
		keep += 1;
		cells = new Map(distinct.map((path) => [path, cellAt(path, keep)]));
	}
	return paths.map((path) => (path === undefined ? undefined : (cells.get(path) ?? path)));
}

function formatDaemonCell(_row: DaemonRow, column: keyof DaemonRow, value: string): string {
	if (column !== "status") {
		return value;
	}
	return colorStatus(value.trim() as DaemonStatus, value);
}

function colorStatus(status: DaemonStatus, value: string): string {
	switch (status) {
		case "current":
			return chalk.green(value);
		case "outdated":
			return chalk.magenta(value);
		case "stale":
			return chalk.yellow(value);
		case "unreachable":
			return chalk.red(value);
		case "orphan-file":
			return chalk.dim(value);
	}
}

/** What each status claims, so `stale` is never read as "live but old" again. */
export function formatDaemonStatusLegend(): string {
	return [
		"current      answers as this build",
		"outdated     answers with another build while sessions, workers or cpu show live work",
		"stale        answers as no known build and carries no live evidence",
		"unreachable  a process or worker holds the socket, but it does not answer",
		"orphan-file  a socket file is left behind with no process holding it",
	].join("\n");
}

export function formatUptime(uptimeSeconds: number | undefined): string {
	if (uptimeSeconds === undefined || !Number.isFinite(uptimeSeconds)) {
		return "";
	}
	const seconds = Math.max(0, Math.floor(uptimeSeconds));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}
	return `${Math.floor(days / 7)}w`;
}

function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
): string {
	const widths = columns.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
	);
	const lines = [columns.map((column, index) => String(column).padEnd(widths[index])).join("  ")];
	for (const row of rows) {
		const line = columns
			.map((column, index) => {
				const value = String(row[column]).padEnd(widths[index]);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}
