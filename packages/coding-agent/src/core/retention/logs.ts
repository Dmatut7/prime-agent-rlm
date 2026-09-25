// R3 retention class: `<logsDir>/<basename>.<8hex>.log` files whose socket is
// provably gone.
//
// Design: /tmp/audit_r/round-08/disk-retention.md §1 R3 (the one class where age
// is the correct criterion — a log is diagnostic residue with no cross-session
// reference), §3 (load-bearing law: "cannot disprove" must not read as "gone"),
// §4 (fixed reason vocabulary, dry-run parity, no silent skips).
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeSocketPath } from "../../utils/daemon-socket-path.js";
import { defaultDaemonSocketDir } from "../../modes/daemon/daemon-socket.js";
import { type ReclaimRequest, reclaimWithinBudget, statSignature } from "./delete.js";
import type {
	RetentionClassContext,
	RetentionClassModule,
	RetentionClassResult,
	RetentionSkipReason,
} from "./types.js";
import { SKIP } from "./types.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** `getDaemonLogPath` shape (config.ts:552): `<basename(socketPath)>.<sha256(socketPath)[0:8]>.log`. */
const LOG_FILE_SHAPE = /^(.+)\.([0-9a-f]{8})\.log$/;
/** Rotation sibling of the same log family (`<...>.log.old`, `<...>.log.1`). */
const LOG_ROTATION_SIBLING_SHAPE = /^(.+)\.([0-9a-f]{8})\.log\.([0-9a-z]+)$/;

/**
 * Which reading of "keep the newest file of a socket's log family" is in force
 * (fixed by the orchestrator's ruling of 2026-09-14):
 *
 *  - true (in force): the newest file only guards a *multi-file* group. A group
 *    holding a single file is judged by age alone, so the lone old log of a dead
 *    socket is reclaimed — design §6 R-9's positive control.
 *  - false: the literal "keep the newest of every hash group" reading, which
 *    keeps that one file forever. Measured on this machine: ~/.prime/agent/logs
 *    holds 2167 shape-matching files in 2167 hash groups, every group being
 *    exactly one file, so the literal reading reclaims 0 bytes forever and trips
 *    design §4.5's `stalled` false-green.
 *
 * Flip this constant (and the matching test) to change readings.
 */
const KEEP_NEWEST_IS_MULTI_FILE_GUARD = true;

/**
 * The log file name `getDaemonLogPath(socketPath)` would use, derived without
 * touching the agent dir. Exported so a test can pin it to the real function.
 */
export function socketLogFileName(socketPath: string): string {
	const normalized = normalizeSocketPath(socketPath);
	return `${basename(normalized)}.${sha8(normalized)}.log`;
}

function sha8(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function errnoCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? "unknown";
}

/** `defaultDaemonSocketDir()` suffix (daemon-socket.ts:296). */
function currentUidSuffix(): string {
	const uid = process.getuid?.();
	return uid === undefined ? "" : String(uid);
}

/**
 * Whether a live socket's *basename* is an active key as well as its hash.
 *
 * Measured on this machine (`~/.prime/agent/logs`, 1,426 shape-matching files,
 * `logFileDays = 14`): the live `.../prime-agent-<uid>/daemon.sock` basename would
 * match every `daemon.sock.<hash>.log` file, keeping 1,606 files unconditionally
 * and reclaiming 166. The shipped reading is hash-only (`false`) - a basename key
 * makes every stale log of a long-gone socket immortal, which is the class's whole
 * point. Either reading keeps every log whose own socket hash is live (that is the
 * design's criterion), so flipping the constant can only ever reclaim more; the
 * test that pins the current reading says so too.
 */
const BASENAME_KEY_IS_ACTIVE = false;

/**
 * Keys a live socket path contributes: its hash, its basename, and the same two
 * again for the realpath-normalized path (on a symlinked tmpdir, `/var` ->
 * `/private/var`, the lexical and resolved paths hash differently). Extra keys
 * can only ever keep more logs, and the hash is always tried first so the
 * reported socket path is the precise one.
 */
function socketKeysFor(socketPath: string): string[] {
	const keys: string[] = [];
	if (BASENAME_KEY_IS_ACTIVE) keys.push(basename(socketPath));
	keys.push(sha8(normalizeSocketPath(socketPath)));
	try {
		const real = realpathSync(socketPath);
		if (BASENAME_KEY_IS_ACTIVE) keys.push(basename(real));
		keys.push(sha8(real));
	} catch {
		// An unverifiable realpath still contributes the lexical keys.
	}
	return keys;
}

/**
 * Live sockets are discovered by shape, never by mtime: a resident daemon may
 * have stopped writing long ago, and a rotated log may have a brand-new mtime.
 */
export function collectActiveSocketKeys(tmpDir: string, agentDir?: string): Map<string, string> {
	const keys = new Map<string, string>();
	const directories = [
		tmpDir,
		join(tmpDir, `prime-agent-${currentUidSuffix()}`),
		// The stable default socket dir (`~/.prime/daemon`): since the stable-path
		// move the live socket and its workers live here, and their logs must be
		// discovered the same way. Hash keys keep working for both generations.
		defaultDaemonSocketDir(),
		// A daemon started with `--socket <path>` keeps its socket where the operator
		// put it. The default agent dir and one level under it cover the layouts this
		// repo creates; a socket outside both roots stays invisible here, which is the
		// irreducible part of this class's criterion (adversarial review N-4) - the
		// escape for an operator with a custom socket location is `logFileDays: 0`.
		...(agentDir ? [agentDir] : []),
	];
	if (currentUidSuffix() !== "user") directories.push(join(tmpDir, "prime-agent-user"));
	if (agentDir) {
		let names: string[] = [];
		try {
			names = readdirSync(agentDir);
		} catch {
			names = [];
		}
		for (const name of names) {
			if (!name.startsWith("daemon") && !name.startsWith("worker")) continue;
			const candidate = join(agentDir, name);
			try {
				if (lstatSync(candidate).isDirectory()) directories.push(candidate);
			} catch {
				// Unreadable: it contributes no keys.
			}
		}
	}
	for (const directory of directories) {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			continue;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".sock")) continue;
			const socketPath = join(directory, name);
			try {
				lstatSync(socketPath);
			} catch {
				continue;
			}
			for (const key of socketKeysFor(socketPath)) {
				if (!keys.has(key)) keys.set(key, socketPath);
			}
		}
	}
	return keys;
}

/** A non-regular entry is never reclaimed; the reason says which shape was seen. */
function nonRegularReason(stats: Stats): RetentionSkipReason {
	if (stats.isSymbolicLink()) return SKIP.unverifiable("symlink");
	if (stats.isSocket()) return SKIP.unverifiable("socket");
	return SKIP.unverifiable("not-regular-file");
}

interface LogNameShape {
	role: "candidate" | "rotation-sibling";
	basenamePart: string;
	hash: string;
}

function parseLogName(name: string): LogNameShape | undefined {
	const asCandidate = LOG_FILE_SHAPE.exec(name);
	if (asCandidate !== null) {
		return { role: "candidate", basenamePart: asCandidate[1], hash: asCandidate[2] };
	}
	const asSibling = LOG_ROTATION_SIBLING_SHAPE.exec(name);
	if (asSibling !== null) {
		return { role: "rotation-sibling", basenamePart: asSibling[1], hash: asSibling[2] };
	}
	return undefined;
}

interface LogCandidate {
	path: string;
	size: number;
}

interface LogGroupMember {
	path: string;
	mtimeMs: number;
	candidate?: LogCandidate;
}

/** Newest wins; the path breaks ties so two runs over one tree judge identically. */
function pickNewest(members: readonly LogGroupMember[]): LogGroupMember {
	let newest = members[0];
	for (const member of members) {
		if (member.mtimeMs > newest.mtimeMs) newest = member;
		else if (member.mtimeMs === newest.mtimeMs && member.path > newest.path) newest = member;
	}
	return newest;
}

async function scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
	const { settings, roots } = context;
	const result: RetentionClassResult = {
		class: "logs",
		scanned: 0,
		reclaimed: 0,
		bytes: 0,
		skipped: [],
		capped: false,
		disabled: false,
	};
	if (!(settings.logFileDays > 0)) {
		// Silent no-ops read as health; the switch that turned the class off is logged.
		context.log(`retention logs: disabled (retention.logFileDays=${settings.logFileDays})`);
		return { ...result, disabled: true };
	}

	let names: string[];
	try {
		names = readdirSync(roots.logsDir).sort();
	} catch (error) {
		const code = errnoCode(error);
		// A fresh agent dir with no logs yet is not a failure.
		if (code === "ENOENT") return result;
		return {
			...result,
			skipped: [{ path: roots.logsDir, reason: SKIP.unverifiable(code), detail: `readdir failed: ${code}` }],
		};
	}

	const activeKeys = collectActiveSocketKeys(roots.tmpDir, roots.agentDir);
	// cooldownMinutes is a floor as well: a log touched seconds ago has a writer in flight.
	const thresholdMs = Math.max(settings.logFileDays * MS_PER_DAY, settings.cooldownMinutes * MS_PER_MINUTE);
	const groups = new Map<string, LogGroupMember[]>();
	const requests: ReclaimRequest[] = [];

	for (const name of names) {
		// Shape whitelist, direct children only: agent.jsonl, client-errors.log and
		// any other name in the log dir is not a candidate and is not scanned.
		const shape = parseLogName(name);
		if (shape === undefined) continue;
		const isCandidate = shape.role === "candidate";
		const path = join(roots.logsDir, name);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			if (isCandidate) {
				result.scanned += 1;
				result.skipped.push({ path, reason: SKIP.unverifiable(errnoCode(error)) });
			}
			continue;
		}
		if (!stats.isFile()) {
			// lstat, so a symlink is never a file here: nothing outside the log dir is reachable.
			if (isCandidate) {
				result.scanned += 1;
				result.skipped.push({ path, reason: nonRegularReason(stats) });
			}
			continue;
		}
		if (isCandidate) {
			result.scanned += 1;
			const residentSocket = activeKeys.get(shape.hash) ?? activeKeys.get(shape.basenamePart);
			if (residentSocket !== undefined) {
				// R-9: the socket decides, mtime never does.
				result.skipped.push({ path, reason: SKIP.inUse("resident"), detail: residentSocket });
				continue;
			}
		}
		const member: LogGroupMember = {
			path,
			mtimeMs: stats.mtimeMs,
			candidate: isCandidate ? { path, size: stats.size } : undefined,
		};
		const members = groups.get(shape.hash);
		if (members === undefined) groups.set(shape.hash, [member]);
		else members.push(member);
	}

	for (const hash of [...groups.keys()].sort()) {
		const members = groups.get(hash);
		if (members === undefined) continue;
		const candidates = members.filter((member) => member.candidate !== undefined);
		// Rotation siblings only: nothing this class may reclaim.
		if (candidates.length === 0) continue;
		const newest = pickNewest(candidates);
		const keepNewest = KEEP_NEWEST_IS_MULTI_FILE_GUARD ? members.length > 1 : true;
		for (const member of candidates) {
			if (keepNewest && member === newest) {
				result.skipped.push({
					path: member.path,
					reason: SKIP.reference("newest-log"),
					detail: `newest of ${members.length} file(s) in log family ${hash}`,
				});
				continue;
			}
			const ageMs = context.now - member.mtimeMs;
			if (ageMs <= thresholdMs) {
				result.skipped.push({
					path: member.path,
					reason: SKIP.young("log-file"),
					detail: `age ${Math.round(ageMs / MS_PER_MINUTE)}m <= ${Math.round(thresholdMs / MS_PER_MINUTE)}m`,
				});
				continue;
			}
			requests.push({
				path: member.path,
				kind: "file",
				bytes: member.candidate?.size ?? 0,
				entries: 1,
				signature: statSignature(member.path),
			});
		}
	}

	const outcome = await reclaimWithinBudget(context, requests);
	result.reclaimed = outcome.reclaimed;
	result.bytes = outcome.bytes;
	result.capped = outcome.capped;
	result.skipped.push(...outcome.skipped);
	return result;
}

/** R3: reclaim dead-socket log files, keeping the newest of each multi-file family. */
export const logsModule: RetentionClassModule = {
	id: "logs",
	scanAndReclaim,
};
