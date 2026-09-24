import { execFileSync } from "node:child_process";

/**
 * CPU time of a process tree, for the silent-step rule: a command that prints
 * nothing but keeps computing (a quiet test run, a linker, `pip install`) is busy,
 * not stuck. One `ps` snapshot per check, bounded by a short timeout; any failure
 * returns undefined so the caller falls back to output-only evidence.
 */

/** Wall-clock bound for the `ps` snapshot. */
export const PROCESS_TREE_PS_TIMEOUT_MS = 2_000;

/** `[dd-]hh:mm:ss[.ff]`, `mm:ss[.ff]` or `ss[.ff]` (both BSD and procps spellings) in ms; undefined when unreadable. */
export function parseCpuTime(value: string): number | undefined {
	const trimmed = value.trim();
	const match = /^(?:(\d+)-)?([\d:.]+)$/.exec(trimmed);
	if (!match?.[2]) return undefined;
	const days = match[1] ? Number(match[1]) : 0;
	const parts = match[2].split(":");
	if (parts.length > 3 || parts.some((part) => part === "" || !Number.isFinite(Number(part)))) return undefined;
	let seconds = 0;
	for (const part of parts) seconds = seconds * 60 + Number(part);
	return Math.round((days * 86_400 + seconds) * 1000);
}

/** One `ps -A -o pid=,ppid=,time=` row. */
interface PsRow {
	pid: number;
	ppid: number;
	cpuMs: number;
}

export function parsePsSnapshot(output: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 3) continue;
		const pid = Number(fields[0]);
		const ppid = Number(fields[1]);
		const cpuMs = parseCpuTime(fields[2] ?? "");
		if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs === undefined) continue;
		rows.push({ pid, ppid, cpuMs });
	}
	return rows;
}

function defaultPsSnapshot(): string {
	return execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], {
		encoding: "utf8",
		timeout: PROCESS_TREE_PS_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 8 * 1024 * 1024,
	});
}

/**
 * Summed user+sys CPU (ms) of `roots` and every descendant, or undefined when the
 * snapshot fails or none of the roots is running.
 */
export function readProcessTreeCpuMs(
	roots: readonly number[],
	snapshot: () => string = defaultPsSnapshot,
): number | undefined {
	const wanted = roots.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (wanted.length === 0 || process.platform === "win32") return undefined;
	let rows: PsRow[];
	try {
		rows = parsePsSnapshot(snapshot());
	} catch {
		return undefined;
	}
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const children = new Map<number, number[]>();
	for (const row of rows) {
		const list = children.get(row.ppid);
		if (list) list.push(row.pid);
		else children.set(row.ppid, [row.pid]);
	}
	const seen = new Set<number>();
	const queue = wanted.filter((pid) => byPid.has(pid));
	if (queue.length === 0) return undefined;
	let total = 0;
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		total += byPid.get(pid)?.cpuMs ?? 0;
		for (const child of children.get(pid) ?? []) queue.push(child);
	}
	return total;
}

/** Upper bound for a model-given timeout honoured by the silent-step rule (one day). */
const MAX_EXPLICIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * The longest timeout the model spelled out for this call, in ms: a numeric
 * `timeout` argument (seconds), `timeout=N` in cell code, `timeout N` / `timeout Ns`
 * as a shell prefix, or `--timeout N`. Undefined when none is given.
 */
export function explicitTimeoutMs(args: unknown): number | undefined {
	const found: number[] = [];
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
	const direct = record?.timeout;
	if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) found.push(direct * 1000);
	for (const key of ["code", "command"]) {
		const text = record?.[key];
		if (typeof text !== "string") continue;
		for (const match of text.matchAll(/\btimeout\s*=\s*(\d+(?:\.\d+)?)/g)) found.push(Number(match[1]) * 1000);
		for (const match of text.matchAll(/\btimeout_ms\s*=\s*(\d+(?:\.\d+)?)/g)) found.push(Number(match[1]));
		for (const match of text.matchAll(
			/(?:^|[\s;&|'"(])timeout\s+(?:(?:-[ks]|--kill-after|--signal)[= ]?\S+\s+|-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)\b/g,
		)) {
			const unit = match[2] === "m" ? 60 : match[2] === "h" ? 3_600 : match[2] === "d" ? 86_400 : 1;
			found.push(Number(match[1]) * unit * 1000);
		}
		for (const match of text.matchAll(/--timeout[= ](\d+(?:\.\d+)?)/g)) found.push(Number(match[1]) * 1000);
	}
	const valid = found.filter((ms) => Number.isFinite(ms) && ms > 0);
	return valid.length > 0 ? Math.min(MAX_EXPLICIT_TIMEOUT_MS, Math.max(...valid)) : undefined;
}
