// Leaf-class tests for the disk-retention sweep (round-09): the R3 `logs` class,
// the two R4 TMPDIR families, and the R5 bash-temp read side.
//
// Every test builds its own tree under `mkdtemp` and removes it in `afterEach`;
// nothing here reads or writes the real `~/.prime/agent`.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDaemonLogPath } from "../src/config.js";
import { bashTempFilesModule } from "../src/core/retention/bash-temp.js";
import { logsModule, socketLogFileName } from "../src/core/retention/logs.js";
import { tmpOtherDirsModule, tmpRlmDirsModule } from "../src/core/retention/tmp-dirs.js";
import type {
	ResolvedRetentionSettings,
	RetentionClassContext,
	RetentionClassModule,
	RetentionClassResult,
	RetentionRoots,
} from "../src/core/retention/types.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Unix socket paths are length-limited (~104 bytes on macOS), so the sandbox
// prefix stays short: tmpdir() + "ret-" + 6 random chars.
const SANDBOX_PREFIX = "ret-";

const sandboxes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await closeServer(server);
	for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

/** A real listening unix socket: the strongest form of "this socket is resident". */
async function listenOnSocket(socketPath: string): Promise<void> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => resolveListen());
	});
	expect(lstatSync(socketPath).isSocket()).toBe(true);
}

interface Sandbox {
	root: string;
	roots: RetentionRoots;
}

function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
	sandboxes.push(root);
	const roots: RetentionRoots = {
		agentDir: root,
		sessionsDir: join(root, "sessions"),
		artifactRoot: join(root, "session-artifacts"),
		logsDir: join(root, "logs"),
		tmpDir: join(root, "tmp"),
		leasesRoot: join(root, "session-leases"),
		retentionDir: join(root, "retention"),
	};
	mkdirSync(roots.logsDir, { recursive: true, mode: 0o700 });
	mkdirSync(roots.tmpDir, { recursive: true, mode: 0o700 });
	return { root, roots };
}

function baseSettings(overrides: Partial<ResolvedRetentionSettings> = {}): ResolvedRetentionSettings {
	return {
		enabled: true,
		dryRun: false,
		sweepIntervalMinutes: 60,
		maxDeleteBytesPerSweep: 512 * 1024 * 1024,
		maxDeleteEntriesPerSweep: 20000,
		cooldownMinutes: 10,
		emptyArtifactDirDays: 7,
		deletedSessionResidueDays: 30,
		childTranscriptDays: 0,
		logFileDays: 14,
		tmpRlmDirHours: 24,
		tmpOtherDirDays: 0,
		bashTempFileHours: 24,
		bashTempFileMaxBytes: 256 * 1024 * 1024,
		staleLeaseHours: 24,
		kernelSnapshotGenerations: 1,
		kernelSnapshotReclaimEnabled: false,
		venvRetention: 1,
		...overrides,
	};
}

function makeContext(
	roots: RetentionRoots,
	overrides: Partial<ResolvedRetentionSettings> = {},
	options: { dryRun?: boolean; budgetEntries?: number; budgetBytes?: number } = {},
): RetentionClassContext {
	const dryRun = options.dryRun ?? false;
	const settings = baseSettings({ dryRun, ...overrides });
	return {
		settings,
		roots,
		now: Date.now(),
		dryRun,
		budget: {
			remainingBytes: options.budgetBytes ?? 512 * 1024 * 1024,
			remainingEntries: options.budgetEntries ?? 20000,
			capped: false,
		},
		live: {},
		log: () => {},
	};
}

/** Run a class and assert the report invariants design §4.4 requires of every class. */
async function sweep(module: RetentionClassModule, context: RetentionClassContext): Promise<RetentionClassResult> {
	const result = await module.scanAndReclaim(context);
	expect(result.class).toBe(module.id);
	const paths = result.skipped.map((entry) => entry.path);
	expect(new Set(paths).size).toBe(paths.length);
	for (const entry of result.skipped) {
		expect(typeof entry.reason).toBe("string");
		expect(entry.reason.length).toBeGreaterThan(0);
	}
	return result;
}

/**
 * The mechanical form of "a skipped path must not also be in the reclaimed set":
 * every skipped entry is still on disk after a real run.
 */
function expectSkippedPathsSurvive(result: RetentionClassResult): void {
	for (const entry of result.skipped) {
		expect(existsSync(entry.path), `skipped path survived: ${entry.path} (${entry.reason})`).toBe(true);
	}
}

function reasonsOf(result: RetentionClassResult): string[] {
	return result.skipped.map((entry) => `${entry.path} ${entry.reason}`).sort();
}

function skippedReasonFor(result: RetentionClassResult, path: string): string | undefined {
	return result.skipped.find((entry) => entry.path === path)?.reason;
}

function snapshotTree(root: string, prefix = ""): string[] {
	const lines: string[] = [];
	for (const name of readdirSync(root).sort()) {
		const path = join(root, name);
		const relative = prefix === "" ? name : `${prefix}/${name}`;
		const stats = lstatSync(path);
		lines.push(`${relative} ${stats.isDirectory() ? "dir" : "entry"} ${stats.size} ${stats.mtimeMs}`);
		if (stats.isDirectory() && !stats.isSymbolicLink()) lines.push(...snapshotTree(path, relative));
	}
	return lines.sort();
}

function ageTo(path: string, ageMs: number): void {
	const when = new Date(Date.now() - ageMs);
	utimesSync(path, when, when);
}

function writeLog(dir: string, name: string, body: string, ageMs?: number): string {
	const path = join(dir, name);
	writeFileSync(path, body, "utf8");
	if (ageMs !== undefined) ageTo(path, ageMs);
	return path;
}

function uidSuffix(): string {
	const uid = process.getuid?.();
	return uid === undefined ? "" : String(uid);
}

/** `daemon.sock.1234abcd.log` -> the socket-path hash group the class keys on. */
function hashOfLogName(fileName: string): string {
	const match = /^(.+)\.([0-9a-f]{8})\.log$/.exec(fileName);
	if (match === null) throw new Error(`not a log file name: ${fileName}`);
	return match[2];
}

describe("logs retention (R3)", () => {
	it("derives exactly the log file name getDaemonLogPath would write", () => {
		const socketPaths = [
			join("/tmp", "prime-agent-501", "daemon.sock"),
			join("/var", "folders", "x", "T", "prime-agent-1000", "supervisor.sock"),
			join("/tmp", "worker-abc123-deadbeef.sock"),
		];
		for (const socketPath of socketPaths) {
			expect(socketLogFileName(socketPath)).toBe(basename(getDaemonLogPath(socketPath)));
		}
	});

	it("keeps a resident socket's log whatever its mtime, and reclaims a dead socket's old log (R-9)", async () => {
		const { roots } = createSandbox();
		const liveSocketPath = join(roots.tmpDir, `prime-agent-${uidSuffix()}`, "daemon.sock");
		await listenOnSocket(liveSocketPath);
		const liveLog = writeLog(roots.logsDir, socketLogFileName(liveSocketPath), "live\n", 30 * MS_PER_DAY);

		// A socket path that does not exist any more: its hash cannot be claimed by any resident socket.
		const deadSocketPath = join(roots.tmpDir, "gone-1234", "custom.sock");
		const deadLog = writeLog(roots.logsDir, socketLogFileName(deadSocketPath), "dead\n", 40 * MS_PER_DAY);
		const otherDeadSocketPath = join(roots.tmpDir, "gone-5678", "other.sock");
		const youngLog = writeLog(roots.logsDir, socketLogFileName(otherDeadSocketPath), "young\n");

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(3);
		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(5);
		expect(result.capped).toBe(false);
		expect(result.disabled).toBe(false);
		expect(skippedReasonFor(result, liveLog)).toBe("in-use:resident");
		expect(result.skipped.find((entry) => entry.path === liveLog)?.detail).toBe(liveSocketPath);
		expect(skippedReasonFor(result, youngLog)).toBe("young:log-file");
		// Ruling of 2026-09-14: the newest file only guards a multi-file family, so a
		// lone old log of a dead socket is reclaimed by age alone.
		expect(existsSync(liveLog)).toBe(true);
		expect(existsSync(youngLog)).toBe(true);
		expect(existsSync(deadLog)).toBe(false);
		expectSkippedPathsSurvive(result);
	});

	it("judges by socket hash, not by basename, when a resident socket shares the name", async () => {
		const { roots } = createSandbox();
		const liveSocketPath = join(roots.tmpDir, `prime-agent-${uidSuffix()}`, "daemon.sock");
		await listenOnSocket(liveSocketPath);
		// The same basename at a different path: the hash key decides, so the dead
		// socket's log is reclaimable while the live socket's own log is kept. With
		// BASENAME_KEY_IS_ACTIVE = true in logs.ts both stay, and this expectation
		// inverts - the shipped reading is hash-only because a basename key makes
		// every stale `daemon.sock.<hash>.log` on the machine immortal.
		const deadLog = writeLog(
			roots.logsDir,
			socketLogFileName(join(roots.tmpDir, "gone", "daemon.sock")),
			"dead\n",
			90 * MS_PER_DAY,
		);
		const liveLog = writeLog(roots.logsDir, socketLogFileName(liveSocketPath), "live\n", 90 * MS_PER_DAY);
		expect(hashOfLogName(basename(deadLog))).not.toBe(hashOfLogName(basename(liveLog)));

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(2);
		expect(result.reclaimed).toBe(1);
		expect(existsSync(deadLog)).toBe(false);
		expect(existsSync(liveLog)).toBe(true);
		expect(skippedReasonFor(result, liveLog)).toBe("in-use:resident");
	});

	it("treats a *.sock directly under the tmp root as resident too", async () => {
		const { roots } = createSandbox();
		const socketPath = join(roots.tmpDir, "custom.sock");
		await listenOnSocket(socketPath);
		const log = writeLog(roots.logsDir, socketLogFileName(socketPath), "live\n", 90 * MS_PER_DAY);

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(1);
		expect(result.reclaimed).toBe(0);
		expect(skippedReasonFor(result, log)).toBe("in-use:resident");
		expect(existsSync(log)).toBe(true);
	});

	it("keeps the newest of a multi-file socket family even when it is very old, and reclaims the rest", async () => {
		const { roots } = createSandbox();
		const hash = hashOfLogName(socketLogFileName(join(roots.tmpDir, "gone", "daemon.sock")));
		const newest = writeLog(roots.logsDir, `daemon.sock.${hash}.log`, "newest\n", 60 * MS_PER_DAY);
		const older = writeLog(roots.logsDir, `custom.sock.${hash}.log`, "older\n", 90 * MS_PER_DAY);
		const sibling = writeLog(roots.logsDir, `daemon.sock.${hash}.log.old`, "rotated\n", 120 * MS_PER_DAY);

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(2);
		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(6);
		expect(skippedReasonFor(result, newest)).toBe("reference:newest-log");
		expect(existsSync(newest)).toBe(true);
		expect(existsSync(older)).toBe(false);
		// A rotation sibling groups with the family but is outside the candidate whitelist.
		expect(existsSync(sibling)).toBe(true);
		expect(result.skipped.some((entry) => entry.path === sibling)).toBe(false);
		expectSkippedPathsSurvive(result);
	});

	it("refuses symlinks, directories and sockets named like a log", async () => {
		const { root, roots } = createSandbox();
		const hashA = hashOfLogName(socketLogFileName(join(roots.tmpDir, "a", "daemon.sock")));
		const hashB = hashOfLogName(socketLogFileName(join(roots.tmpDir, "b", "worker.sock")));
		const target = join(root, "outside-target.log");
		writeFileSync(target, "secret\n", "utf8");
		ageTo(target, 90 * MS_PER_DAY);
		const link = join(roots.logsDir, `daemon.sock.${hashA}.log`);
		symlinkSync(target, link);
		const directory = join(roots.logsDir, `worker.sock.${hashB}.log`);
		mkdirSync(directory, { mode: 0o700 });
		const socketPath = join(roots.logsDir, `custom.sock.${hashB}.log`);
		await listenOnSocket(socketPath);

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(3);
		expect(result.reclaimed).toBe(0);
		expect(skippedReasonFor(result, link)).toBe("unverifiable:symlink");
		expect(skippedReasonFor(result, directory)).toBe("unverifiable:not-regular-file");
		expect(skippedReasonFor(result, socketPath)).toBe("unverifiable:socket");
		// The symlink target is old and log-shaped, but it is not a direct child of the log dir.
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("secret\n");
		expect(existsSync(link)).toBe(true);
		expect(existsSync(directory)).toBe(true);
	});

	it("leaves the log dir's other names alone and does not count them", async () => {
		const { roots } = createSandbox();
		const hash = hashOfLogName(socketLogFileName(join(roots.tmpDir, "gone", "daemon.sock")));
		const keep = [
			writeLog(roots.logsDir, "agent.jsonl", "{}\n", 90 * MS_PER_DAY),
			writeLog(roots.logsDir, "client-errors.log", "err\n", 90 * MS_PER_DAY),
			// Uppercase hex is not the producer's shape (`randomBytes(8).toString("hex")` is lowercase),
			// and a name with more than 8 hex chars is not a socket hash either.
			writeLog(roots.logsDir, "daemon.sock.ABCDEF12.log", "upper\n", 90 * MS_PER_DAY),
			writeLog(roots.logsDir, `daemon.sock.${hash}ab.log`, "long hash\n", 90 * MS_PER_DAY),
			writeLog(roots.logsDir, `daemon.sock.${hash}.log.old`, "rotated\n", 90 * MS_PER_DAY),
		];

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(0);
		expect(result.reclaimed).toBe(0);
		expect(result.skipped).toEqual([]);
		for (const path of keep) expect(existsSync(path)).toBe(true);
	});

	it("is disabled, not silently idle, when logFileDays is off", async () => {
		const { roots } = createSandbox();
		const hash = hashOfLogName(socketLogFileName(join(roots.tmpDir, "gone", "daemon.sock")));
		const log = writeLog(roots.logsDir, `daemon.sock.${hash}.log`, "dead\n", 90 * MS_PER_DAY);

		const result = await sweep(logsModule, makeContext(roots, { logFileDays: 0 }));

		expect(result.disabled).toBe(true);
		expect(result.scanned).toBe(0);
		expect(result.reclaimed).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(existsSync(log)).toBe(true);
	});

	it("treats a missing log directory as an empty scan", async () => {
		const { roots } = createSandbox();
		rmSync(roots.logsDir, { recursive: true, force: true });

		const result = await sweep(logsModule, makeContext(roots));

		expect(result.scanned).toBe(0);
		expect(result.reclaimed).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(result.disabled).toBe(false);
	});

	it("honors the shared cooldown as a floor on the age rule", async () => {
		const { roots } = createSandbox();
		const hash = hashOfLogName(socketLogFileName(join(roots.tmpDir, "gone", "daemon.sock")));
		const log = writeLog(roots.logsDir, `daemon.sock.${hash}.log`, "recent\n", 2 * MS_PER_HOUR);

		const result = await sweep(logsModule, makeContext(roots, { logFileDays: 1, cooldownMinutes: 600 }));

		expect(result.reclaimed).toBe(0);
		expect(skippedReasonFor(result, log)).toBe("young:log-file");
		expect(existsSync(log)).toBe(true);
	});
});

describe("tmp dir retention (R4)", () => {
	function makeTmpDir(tmpDir: string, prefix: string): string {
		return mkdtempSync(join(tmpDir, prefix));
	}

	/** Age a whole subtree: the class takes the newest mtime anywhere in it. */
	function ageTree(path: string, ageMs: number): void {
		for (const name of readdirSync(path)) {
			const child = join(path, name);
			const stats = lstatSync(child);
			if (stats.isDirectory() && !stats.isSymbolicLink()) ageTree(child, ageMs);
			else ageTo(child, ageMs);
		}
		ageTo(path, ageMs);
	}

	it("reclaims recursively empty old prime-agent-rlm-* dirs and keeps every other shape", async () => {
		const { roots } = createSandbox();
		const oldEmpty = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		const oldNested = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		mkdirSync(join(oldNested, "sub-a1b2c3d4"), { mode: 0o700 });
		const youngEmpty = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		const notEmpty = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		mkdirSync(join(notEmpty, "sub-deadbeef"), { mode: 0o700 });
		writeFileSync(join(notEmpty, "sub-deadbeef", "notes.txt"), "x", "utf8");
		const held = [
			{ dir: makeTmpDir(roots.tmpDir, "prime-agent-rlm-"), entry: "holder.lock" },
			{ dir: makeTmpDir(roots.tmpDir, "prime-agent-rlm-"), entry: "daemon.sock" },
			{ dir: makeTmpDir(roots.tmpDir, "prime-agent-rlm-"), entry: "cleanup.guard" },
		];
		for (const { dir, entry } of held) {
			mkdirSync(join(dir, "sub-cafebabe"), { mode: 0o700 });
			writeFileSync(join(dir, "sub-cafebabe", entry), "", "utf8");
		}
		for (const path of [oldEmpty, oldNested, notEmpty, ...held.map((item) => item.dir)]) {
			ageTree(path, 30 * MS_PER_HOUR);
		}

		const result = await sweep(tmpRlmDirsModule, makeContext(roots));

		expect(result.scanned).toBe(7);
		expect(result.reclaimed).toBe(2);
		expect(result.bytes).toBe(0);
		expect(skippedReasonFor(result, youngEmpty)).toBe("young:tmp-rlm-dir");
		expect(skippedReasonFor(result, notEmpty)).toBe("not-empty");
		for (const { dir } of held) expect(skippedReasonFor(result, dir)).toBe("in-use:pid");
		expect(existsSync(oldEmpty)).toBe(false);
		expect(existsSync(oldNested)).toBe(false);
		expect(existsSync(youngEmpty)).toBe(true);
		expect(existsSync(notEmpty)).toBe(true);
		for (const { dir } of held) expect(existsSync(dir)).toBe(true);
		expectSkippedPathsSurvive(result);
	});

	it("never counts the daemon socket dir or any name outside its own family", async () => {
		const { roots } = createSandbox();
		const daemonDir = join(roots.tmpDir, "prime-agent-501");
		mkdirSync(daemonDir, { mode: 0o700 });
		writeFileSync(join(daemonDir, "daemon.sock"), "", "utf8");
		writeFileSync(join(daemonDir, "daemon.sock.lock"), "", "utf8");
		const userDir = join(roots.tmpDir, "prime-agent-user");
		mkdirSync(userDir, { mode: 0o700 });
		writeFileSync(join(userDir, "daemon.sock"), "", "utf8");
		const foreignDir = join(roots.tmpDir, "rlm-tmp");
		mkdirSync(foreignDir, { mode: 0o700 });
		writeFileSync(join(foreignDir, "data.txt"), "x", "utf8");
		const familyFile = join(roots.tmpDir, "prime-agent-rlm-file");
		writeFileSync(familyFile, "x", "utf8");
		ageTo(familyFile, 30 * MS_PER_HOUR);

		const rlm = await sweep(tmpRlmDirsModule, makeContext(roots));
		// Hard rule: the daemon socket dir is not a candidate, not a skip and not scanned.
		expect(rlm.scanned).toBe(1);
		expect(rlm.reclaimed).toBe(0);
		expect(skippedReasonFor(rlm, familyFile)).toBe("unverifiable:not-directory");
		for (const excluded of [daemonDir, userDir, foreignDir]) {
			expect(rlm.skipped.some((entry) => entry.path.startsWith(excluded))).toBe(false);
			expect(existsSync(excluded)).toBe(true);
		}
		expect(existsSync(join(daemonDir, "daemon.sock"))).toBe(true);

		const other = await sweep(tmpOtherDirsModule, makeContext(roots, { tmpOtherDirDays: 30 }));
		// Every remaining name in the tmp root belongs to an excluded family.
		expect(other.scanned).toBe(0);
		expect(other.reclaimed).toBe(0);
		expect(other.skipped).toEqual([]);
		for (const excluded of [daemonDir, userDir, foreignDir]) expect(existsSync(excluded)).toBe(true);
	});

	it("keeps other prime-agent-* families by default and reclaims empty old ones only when enabled", async () => {
		const { roots } = createSandbox();
		const oldEmpty = makeTmpDir(roots.tmpDir, "prime-agent-telemetry-");
		const youngEmpty = makeTmpDir(roots.tmpDir, "prime-agent-telemetry-");
		const notEmpty = makeTmpDir(roots.tmpDir, "prime-agent-test-");
		writeFileSync(join(notEmpty, "out.txt"), "x", "utf8");
		for (const path of [oldEmpty, notEmpty]) ageTree(path, 30 * MS_PER_DAY);

		const off = await sweep(tmpOtherDirsModule, makeContext(roots));
		expect(off.disabled).toBe(true);
		expect(off.scanned).toBe(0);
		expect(off.reclaimed).toBe(0);
		expect(off.skipped).toEqual([]);
		for (const path of [oldEmpty, youngEmpty, notEmpty]) expect(existsSync(path)).toBe(true);

		const on = await sweep(tmpOtherDirsModule, makeContext(roots, { tmpOtherDirDays: 7 }));
		expect(on.disabled).toBe(false);
		expect(on.scanned).toBe(3);
		expect(on.reclaimed).toBe(1);
		expect(skippedReasonFor(on, youngEmpty)).toBe("young:tmp-other-dir");
		expect(skippedReasonFor(on, notEmpty)).toBe("not-empty");
		expect(existsSync(oldEmpty)).toBe(false);
		expect(existsSync(youngEmpty)).toBe(true);
		expect(existsSync(notEmpty)).toBe(true);
		expectSkippedPathsSurvive(on);
	});

	it("refuses a symlinked candidate instead of following it out of the tmp root", async () => {
		const { root, roots } = createSandbox();
		const outside = join(root, "outside-dir");
		mkdirSync(outside, { mode: 0o700 });
		const link = join(roots.tmpDir, "prime-agent-rlm-link");
		symlinkSync(outside, link);
		ageTo(outside, 30 * MS_PER_HOUR);

		const result = await sweep(tmpRlmDirsModule, makeContext(roots));

		expect(result.scanned).toBe(1);
		expect(result.reclaimed).toBe(0);
		expect(skippedReasonFor(result, link)).toBe("unverifiable:symlink");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(outside)).toBe(true);
	});

	it("treats a missing tmp root as an empty scan", async () => {
		const { roots } = createSandbox();
		rmSync(roots.tmpDir, { recursive: true, force: true });

		const rlm = await sweep(tmpRlmDirsModule, makeContext(roots));
		const other = await sweep(tmpOtherDirsModule, makeContext(roots, { tmpOtherDirDays: 7 }));

		for (const result of [rlm, other]) {
			expect(result.scanned).toBe(0);
			expect(result.skipped).toEqual([]);
		}
	});

	it("dry-run matches the real run, and the shared cap stops every deletion", async () => {
		const { roots } = createSandbox();
		const oldEmpty = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		const youngEmpty = makeTmpDir(roots.tmpDir, "prime-agent-rlm-");
		ageTree(oldEmpty, 30 * MS_PER_HOUR);
		const before = snapshotTree(roots.tmpDir);

		const dry = await sweep(tmpRlmDirsModule, makeContext(roots, {}, { dryRun: true }));
		expect(dry.scanned).toBe(2);
		expect(dry.reclaimed).toBe(1);
		expect(skippedReasonFor(dry, youngEmpty)).toBe("young:tmp-rlm-dir");
		expect(snapshotTree(roots.tmpDir)).toEqual(before);

		// The class must not run its own fuse: the shared budget records cap-hit.
		const capped = await sweep(tmpRlmDirsModule, makeContext(roots, {}, { budgetEntries: 0 }));
		expect(capped.reclaimed).toBe(0);
		expect(capped.capped).toBe(true);
		expect(skippedReasonFor(capped, oldEmpty)).toBe("cap-hit");
		expect(existsSync(oldEmpty)).toBe(true);
		expect(snapshotTree(roots.tmpDir)).toEqual(before);

		const real = await sweep(tmpRlmDirsModule, makeContext(roots));
		expect(real.scanned).toBe(dry.scanned);
		expect(real.reclaimed).toBe(dry.reclaimed);
		expect(real.bytes).toBe(dry.bytes);
		expect(reasonsOf(real)).toEqual(reasonsOf(dry));
		expect(existsSync(oldEmpty)).toBe(false);
		expect(existsSync(youngEmpty)).toBe(true);
		expect(snapshotTree(roots.tmpDir)).not.toEqual(before);
	});
});

describe("bash temp files (R5 read side)", () => {
	it("reclaims old pi-bash-<hex>.log files and leaves every other name alone", async () => {
		const { root, roots } = createSandbox();
		const old = writeLog(roots.tmpDir, "pi-bash-abcdef0123456789.log", "old output\n", 40 * MS_PER_HOUR);
		const young = writeLog(roots.tmpDir, "pi-bash-0011223344556677.log", "running\n");
		const directory = join(roots.tmpDir, "pi-bash-cafebabe.log");
		mkdirSync(directory, { mode: 0o700 });
		const target = join(root, "target.log");
		writeFileSync(target, "not a temp file\n", "utf8");
		ageTo(target, 40 * MS_PER_HOUR);
		const link = join(roots.tmpDir, "pi-bash-deadbeef.log");
		symlinkSync(target, link);
		const kept = [
			writeLog(roots.tmpDir, "pi-bash-not-hex.log", "x\n", 40 * MS_PER_HOUR),
			writeLog(roots.tmpDir, "pi-other-abcdef01.log", "x\n", 40 * MS_PER_HOUR),
			writeLog(roots.tmpDir, "pi-bash-abcdef01.log.old", "x\n", 40 * MS_PER_HOUR),
			writeLog(roots.tmpDir, "bash-output.log", "x\n", 40 * MS_PER_HOUR),
		];

		const result = await sweep(bashTempFilesModule, makeContext(roots));

		expect(result.scanned).toBe(4);
		expect(result.reclaimed).toBe(1);
		expect(result.bytes).toBe(11);
		expect(skippedReasonFor(result, young)).toBe("young:bash-temp-file");
		expect(skippedReasonFor(result, directory)).toBe("unverifiable:not-regular-file");
		expect(skippedReasonFor(result, link)).toBe("unverifiable:symlink");
		expect(existsSync(old)).toBe(false);
		expect(existsSync(young)).toBe(true);
		expect(existsSync(directory)).toBe(true);
		expect(existsSync(target)).toBe(true);
		for (const path of kept) expect(existsSync(path)).toBe(true);
		expectSkippedPathsSurvive(result);
	});

	it("is off when the hours knob is off, and floors the age rule with the cooldown", async () => {
		const { roots } = createSandbox();
		const log = writeLog(roots.tmpDir, "pi-bash-abcdef0123456789.log", "old\n", 2 * MS_PER_HOUR);

		const off = await sweep(bashTempFilesModule, makeContext(roots, { bashTempFileHours: 0 }));
		expect(off.disabled).toBe(true);
		expect(off.scanned).toBe(0);
		expect(off.skipped).toEqual([]);
		expect(existsSync(log)).toBe(true);

		const floored = await sweep(
			bashTempFilesModule,
			makeContext(roots, { bashTempFileHours: 1, cooldownMinutes: 600 }),
		);
		expect(floored.reclaimed).toBe(0);
		expect(skippedReasonFor(floored, log)).toBe("young:bash-temp-file");
		expect(existsSync(log)).toBe(true);
	});

	it("treats a missing tmp root as an empty scan", async () => {
		const { roots } = createSandbox();
		rmSync(roots.tmpDir, { recursive: true, force: true });

		const result = await sweep(bashTempFilesModule, makeContext(roots));

		expect(result.scanned).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(result.disabled).toBe(false);
	});

	it("dry-run matches the real run, and the shared cap stops deletions", async () => {
		const { roots } = createSandbox();
		const old = writeLog(roots.tmpDir, "pi-bash-abcdef0123456789.log", "old\n", 40 * MS_PER_HOUR);
		const young = writeLog(roots.tmpDir, "pi-bash-0011223344556677.log", "running\n");
		const before = snapshotTree(roots.tmpDir);

		const dry = await sweep(bashTempFilesModule, makeContext(roots, {}, { dryRun: true }));
		expect(dry.reclaimed).toBe(1);
		expect(snapshotTree(roots.tmpDir)).toEqual(before);

		const capped = await sweep(bashTempFilesModule, makeContext(roots, {}, { budgetBytes: 0 }));
		expect(capped.reclaimed).toBe(0);
		expect(capped.capped).toBe(true);
		expect(skippedReasonFor(capped, old)).toBe("cap-hit");
		expect(snapshotTree(roots.tmpDir)).toEqual(before);

		const real = await sweep(bashTempFilesModule, makeContext(roots));
		expect(real.scanned).toBe(dry.scanned);
		expect(real.reclaimed).toBe(dry.reclaimed);
		expect(real.bytes).toBe(dry.bytes);
		expect(reasonsOf(real)).toEqual(reasonsOf(dry));
		expect(existsSync(old)).toBe(false);
		expect(existsSync(young)).toBe(true);
		expect(snapshotTree(roots.tmpDir)).not.toEqual(before);
	});
});

describe("logs dry-run parity (design §4.3, R-5)", () => {
	it("scans, judges and reports identically under dryRun, then really deletes", async () => {
		const { roots } = createSandbox();
		const liveSocketPath = join(roots.tmpDir, `prime-agent-${uidSuffix()}`, "daemon.sock");
		await listenOnSocket(liveSocketPath);
		writeLog(roots.logsDir, socketLogFileName(liveSocketPath), "live\n", 60 * MS_PER_DAY);
		const first = writeLog(
			roots.logsDir,
			socketLogFileName(join(roots.tmpDir, "gone-a", "custom.sock")),
			"dead a\n",
			30 * MS_PER_DAY,
		);
		const second = writeLog(
			roots.logsDir,
			socketLogFileName(join(roots.tmpDir, "gone-b", "other.sock")),
			"dead b\n",
			45 * MS_PER_DAY,
		);
		writeLog(roots.logsDir, socketLogFileName(join(roots.tmpDir, "gone-c", "third.sock")), "young\n");
		const before = snapshotTree(roots.logsDir);

		const dry = await sweep(logsModule, makeContext(roots, {}, { dryRun: true }));
		expect(dry.scanned).toBe(4);
		expect(dry.reclaimed).toBe(2);
		expect(dry.bytes).toBe(14);
		expect(snapshotTree(roots.logsDir)).toEqual(before);
		expectSkippedPathsSurvive(dry);

		const real = await sweep(logsModule, makeContext(roots));
		expect(real.scanned).toBe(dry.scanned);
		expect(real.reclaimed).toBe(dry.reclaimed);
		expect(real.bytes).toBe(dry.bytes);
		expect(reasonsOf(real)).toEqual(reasonsOf(dry));
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expectSkippedPathsSurvive(real);
		expect(snapshotTree(roots.logsDir)).not.toEqual(before);
	});
});
