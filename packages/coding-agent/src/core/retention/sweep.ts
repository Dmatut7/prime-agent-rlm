// The retention sweep: one pass over every class, one shared budget, one report.
//
// Order matters and is fixed: generation/leftover classes first (they are the ones
// with a structural argument), then the leaf file classes. Every class judges with
// the same evidence set, gathered once by `collectLiveReferences`, so "who is in
// use" is answered in one place per sweep.
//
// `retention.enabled: false` and `retention.dryRun: true` both walk the identical
// judgement path; only the removal step differs, which is what makes a dry run a
// prediction instead of a different program (design section 4).
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { activeSessionLeaseDirectories, classifyLeaseDirectory } from "../session-lease.js";
import { artifactEmptyDirsModule, artifactResidueModule } from "./artifact-dirs.js";
import { bashTempFilesModule } from "./bash-temp.js";
import { childTranscriptsModule } from "./child-transcripts.js";
import { kernelSnapshotGenerationsModule } from "./kernel-snapshot.js";
import { staleLeasesModule } from "./leases.js";
import { scanRlmLedgerDirectory } from "./ledger-scan.js";
import { logsModule } from "./logs.js";
import { readRetentionHistory } from "./reports.js";
import { rlmLedgerCompactionModule } from "./rlm-ledger-compaction.js";
import { tmpOtherDirsModule, tmpRlmDirsModule } from "./tmp-dirs.js";
import { retentionCrashLeftoversModule } from "./trash.js";
import type {
	ResolvedRetentionSettings,
	RetentionBudget,
	RetentionClassContext,
	RetentionClassId,
	RetentionClassResult,
	RetentionLiveReferences,
	RetentionRoots,
	RetentionSweepReport,
} from "./types.js";
import { kernelVenvGenerationsModule } from "./venv.js";

/** Classes in sweep order: structural leftovers first, single files last. */
const CLASS_MODULES = [
	kernelSnapshotGenerationsModule,
	artifactResidueModule,
	artifactEmptyDirsModule,
	childTranscriptsModule,
	logsModule,
	tmpRlmDirsModule,
	tmpOtherDirsModule,
	bashTempFilesModule,
	staleLeasesModule,
	kernelVenvGenerationsModule,
	retentionCrashLeftoversModule,
	// Last: it rewrites the ledger the classes above read their evidence from,
	// so it must not change that evidence mid-sweep.
	rlmLedgerCompactionModule,
];

/** How many consecutive empty-but-scanned sweeps mark a class as stalled. */
const STALLED_AFTER_SWEEPS = 3;
const _HISTORY_LIMIT = 200;

/**
 * Evidence gathered once per sweep: transcript roots (multi-root, round-08 D-2),
 * resident sessions, live leases, and the daemon RLM ledger. `unverifiable`
 * entries stay empty rather than guessing: an evidence source that cannot be read
 * leaves its set empty, and every class treats an empty set as "keep".
 */
export function collectLiveReferences(options: {
	roots: RetentionRoots;
	env?: NodeJS.ProcessEnv;
	activeLeaseDirectories?: ReadonlySet<string>;
	residentSessionIds?: ReadonlySet<string>;
}): RetentionLiveReferences {
	const env = options.env ?? process.env;
	const sessionRootIds = new Set<string>();
	const leasedSessionIds = new Set<string>();
	const ledgerLiveChildIds = new Set<string>();
	const ledgerDeletedChildIds = new Set<string>();
	// The flat session root: one transcript per live top-level session.
	let names: string[] = [];
	try {
		names = readdirSync(options.roots.sessionsDir);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		sessionRootIds.add(name.replace(/\.jsonl$/, ""));
	}
	// Live leases name the session file they guard; that id is in use right now.
	let leaseDirs: string[] = [];
	try {
		leaseDirs = readdirSync(options.roots.leasesRoot);
	} catch {
		leaseDirs = [];
	}
	for (const name of leaseDirs.sort()) {
		const directory = join(options.roots.leasesRoot, name);
		const classification = classifyLeaseDirectory(directory, {
			activeLeaseDirectories: options.activeLeaseDirectories,
			environment: env,
		});
		if (classification.verdict !== "live" && classification.verdict !== "held-in-process") continue;
		if (!classification.sessionPath) continue;
		leasedSessionIds.add(basename(classification.sessionPath).replace(/\.jsonl$/, ""));
	}
	// The daemon ledger: one more reference root, and positive proof of a deletion.
	const ledger = scanRlmLedgerDirectory(join(options.roots.agentDir, "rlm-ledger"));
	if (ledger.scanned) {
		for (const id of ledger.liveChildIds) ledgerLiveChildIds.add(id);
		for (const id of ledger.deletedChildIds) ledgerDeletedChildIds.add(id);
	}
	return {
		residentSessionIds: options.residentSessionIds ?? new Set<string>(),
		ledgerLiveChildIds,
		ledgerDeletedChildIds,
		ledgerScanned: ledger.scanned,
		transcriptIds: new Map<string, string>(),
		sessionRootIds,
		leasedSessionIds,
		// Production callers pass nothing, so the in-process set of this very process is
		// the default: a lease this process holds is not stale (review N-8).
		activeLeaseDirectories: options.activeLeaseDirectories ?? activeSessionLeaseDirectories(),
	};
}

export interface RunRetentionSweepOptions {
	settings: ResolvedRetentionSettings;
	roots: RetentionRoots;
	/** Overrides "now" for tests; defaults to the wall clock. */
	now?: number;
	/** Force a dry run regardless of settings (CLI `--dry-run`). */
	forceDryRun?: boolean;
	live?: Partial<RetentionLiveReferences>;
	residentSessionIds?: ReadonlySet<string>;
	activeLeaseDirectories?: ReadonlySet<string>;
	log?: (line: string) => void;
}

/** One sweep. Returns the report; never throws for a class-level failure. */
export async function runRetentionSweep(options: RunRetentionSweepOptions): Promise<RetentionSweepReport> {
	const startedAt = Date.now();
	const now = options.now ?? startedAt;
	const log = options.log ?? (() => {});
	const { settings } = options;
	const roots = options.roots;
	const live: RetentionLiveReferences = {
		...collectLiveReferences({
			roots,
			residentSessionIds: options.residentSessionIds,
			activeLeaseDirectories: options.activeLeaseDirectories,
		}),
		...options.live,
	};
	if (options.residentSessionIds) live.residentSessionIds = options.residentSessionIds;
	if (options.activeLeaseDirectories) live.activeLeaseDirectories = options.activeLeaseDirectories;
	const dryRun = settings.dryRun || options.forceDryRun === true || !settings.enabled;
	const budget: RetentionBudget = {
		remainingBytes: settings.maxDeleteBytesPerSweep,
		remainingEntries: settings.maxDeleteEntriesPerSweep,
		capped: false,
	};
	const context: RetentionClassContext = {
		settings,
		roots,
		now,
		dryRun,
		budget,
		live,
		log,
	};
	const classes: RetentionClassResult[] = [];
	for (const module of CLASS_MODULES) {
		try {
			const result = await module.scanAndReclaim(context);
			classes.push(result);
			log(
				`retention sweep class=${result.class} scanned=${result.scanned} reclaimed=${result.reclaimed} bytes=${result.bytes} skipped=${result.skipped.length}`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unknown";
			classes.push({
				class: module.id,
				scanned: 0,
				reclaimed: 0,
				bytes: 0,
				skipped: [{ path: module.id, reason: `failed:${code}`, detail: String((error as Error).message ?? error) }],
				capped: false,
				disabled: false,
			});
		}
	}
	const totals = classes.reduce(
		(accumulator, entry) => ({
			scanned: accumulator.scanned + entry.scanned,
			reclaimed: accumulator.reclaimed + entry.reclaimed,
			bytes: accumulator.bytes + entry.bytes,
			entries: accumulator.entries + entry.reclaimed,
		}),
		{ scanned: 0, reclaimed: 0, bytes: 0, entries: 0 },
	);
	const previous = readRetentionHistory(roots);
	const stalled = stalledClasses(classes, previous);
	return {
		at: new Date(now).toISOString(),
		durationMs: Date.now() - startedAt,
		dryRun,
		enabled: settings.enabled,
		classes,
		totals,
		capped: budget.capped,
		stalled,
	};
}

/**
 * A class that scans candidates and reclaims none for three consecutive sweeps is
 * reported as stalled: "the sweeper runs but does nothing" must not read as health
 * (design section 4.5).
 */
function stalledClasses(
	classes: readonly RetentionClassResult[],
	history: readonly RetentionSweepReport[],
): RetentionClassId[] {
	const recent = history.slice(-(STALLED_AFTER_SWEEPS - 1));
	const stalled: RetentionClassId[] = [];
	for (const entry of classes) {
		if (entry.disabled || entry.reclaimed > 0 || entry.scanned === 0 || entry.skipped.length === 0) continue;
		const previousBarren = recent.every((report) => {
			const match = report.classes.find((candidate) => candidate.class === entry.class);
			return match !== undefined && match.reclaimed === 0 && match.scanned > 0;
		});
		if (previousBarren && recent.length === STALLED_AFTER_SWEEPS - 1) stalled.push(entry.class);
	}
	return stalled;
}
