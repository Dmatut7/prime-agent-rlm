// Shared contract for the disk-retention sweep (round-09 implementation of
// /tmp/audit_r/round-08/disk-retention.md). Class modules judge candidates and
// reclaim them through `reclaimWithinBudget`, so every class reports the same
// shape and shares one per-sweep circuit breaker.
//
// Safety law (verbatim from kernel/venv-in-use.ts): "this decides whether a
// directory may be deleted, so `cannot disprove` must not read as `gone`".
// A probe that fails, is refused, or cannot establish an identity keeps the
// candidate and reports an `unverifiable:` reason.

/** Every reclaimable class, in sweep order. */
export type RetentionClassId =
	| "kernel-snapshot-generations"
	| "artifact-residue-dirs"
	| "artifact-empty-dirs"
	| "child-transcripts"
	| "logs"
	| "tmp-rlm-dirs"
	| "tmp-other-dirs"
	| "bash-temp-files"
	| "stale-leases"
	| "kernel-venv-generations"
	| "crash-leftovers";

/**
 * Fixed reason vocabulary. Free text is not allowed in a skip entry: a report
 * that explains itself with prose cannot be asserted against (design §4).
 */
export type RetentionSkipReason =
	| `in-use:${string}`
	| `reference:${string}`
	| `young:${string}`
	| "not-empty"
	| "no-tombstone"
	| "no-transcript"
	| "cap-hit"
	| "disabled"
	| `unverifiable:${string}`
	| `failed:${string}`;

export const SKIP = {
	inUse: (who: "resident" | "lease" | "pid"): RetentionSkipReason => `in-use:${who}`,
	reference: (what: string): RetentionSkipReason => `reference:${what}`,
	young: (what: string): RetentionSkipReason => `young:${what}`,
	unverifiable: (code: string): RetentionSkipReason => `unverifiable:${code}`,
	failed: (code: string): RetentionSkipReason => `failed:${code}`,
	capHit: "cap-hit" as RetentionSkipReason,
	disabled: "disabled" as RetentionSkipReason,
	notEmpty: "not-empty" as RetentionSkipReason,
	noTombstone: "no-tombstone" as RetentionSkipReason,
	noTranscript: "no-transcript" as RetentionSkipReason,
} as const;

export interface RetentionSkip {
	path: string;
	reason: RetentionSkipReason;
	detail?: string;
}

export interface RetentionClassResult {
	class: RetentionClassId;
	scanned: number;
	/** Entries the class reclaimed (or would reclaim, under `dryRun`). */
	reclaimed: number;
	/** Bytes the class reclaimed (or would reclaim, under `dryRun`). */
	bytes: number;
	skipped: RetentionSkip[];
	/** The class stopped early because the shared per-sweep cap was reached. */
	capped: boolean;
	/** The class is switched off by settings; it scanned nothing. */
	disabled: boolean;
}

/** Resolved `retention.*` settings: every value is in the unit the sweep uses. */
export interface ResolvedRetentionSettings {
	/** Master switch. false = report-only for every class. */
	enabled: boolean;
	/** Report what would be reclaimed without deleting anything. */
	dryRun: boolean;
	/** Periodic sweep interval; 0 or negative disables the periodic trigger. */
	sweepIntervalMinutes: number;
	/** Circuit breaker: stop deleting once this many bytes were reclaimed (0 = unlimited). */
	maxDeleteBytesPerSweep: number;
	/** Circuit breaker: stop deleting once this many entries were reclaimed (0 = unlimited). */
	maxDeleteEntriesPerSweep: number;
	/** Cooldown window: any candidate touched more recently is kept. */
	cooldownMinutes: number;
	/** Empty artifact directories whose session is provably gone (0 = off). */
	emptyArtifactDirDays: number;
	/** Non-empty artifact directories left by a provably deleted session (0 = off). */
	deletedSessionResidueDays: number;
	/** Child transcripts by age (0 = off; the shipped default is off, see D-1). */
	childTranscriptDays: number;
	/** Log files whose socket is gone (0 = off). */
	logFileDays: number;
	/** `prime-agent-rlm-*` temp directories that are empty (0 = off). */
	tmpRlmDirHours: number;
	/** Any other `prime-agent-*` temp directory (0 = off; never the daemon socket dir). */
	tmpOtherDirDays: number;
	/** `pi-bash-*.log` temp files (0 = off). */
	bashTempFileHours: number;
	/** Write-side cap for one `pi-bash-*.log` file (0 = unlimited). */
	bashTempFileMaxBytes: number;
	/** Lease directories whose owner is provably gone (0 = off; the pid double-check still gates). */
	staleLeaseHours: number;
	/** Retired kernel snapshot generations kept after the referenced ones (0 = delete all retired). */
	kernelSnapshotGenerations: number;
	/** Kernel snapshot generation reclaim switch. Off by default (D-1: the bytes ride live references). */
	kernelSnapshotReclaimEnabled: boolean;
	/** Retired kernel venv generations kept (mirrors RETIRED_VENV_RETENTION). */
	venvRetention: number;
}

/** Filesystem roots one sweep works on. Everything derived from a single agent dir. */
export interface RetentionRoots {
	agentDir: string;
	sessionsDir: string;
	artifactRoot: string;
	logsDir: string;
	tmpDir: string;
	leasesRoot: string;
	retentionDir: string;
	/**
	 * Base path whose `<base>-<12 hex>` siblings are kernel venv generations.
	 * Defaults to `getKernelVenvDir()`; a test sets it so a sweep cannot touch the
	 * machine's real venv.
	 */
	kernelVenvBase?: string;
}

/** Shared per-sweep circuit breaker; every class spends from the same budget. */
export interface RetentionBudget {
	remainingBytes: number;
	remainingEntries: number;
	capped: boolean;
}

/** Evidence the runner can supply so classes can respect live references. */
export interface RetentionLiveReferences {
	/** Session ids currently resident in a daemon (never reclaimed). */
	residentSessionIds?: ReadonlySet<string>;
	/** Child session ids with a live ledger edge (never reclaimed). */
	ledgerLiveChildIds?: ReadonlySet<string>;
	/** Session ids whose transcript exists anywhere (multi-root, see D-2), mapped to where. */
	transcriptIds?: ReadonlyMap<string, string>;
	/** Session ids whose transcript lives in the flat session root (checked directly). */
	sessionRootIds?: ReadonlySet<string>;
	/** Session ids with a live session lease (never reclaimed). */
	leasedSessionIds?: ReadonlySet<string>;
	/** Child session ids the ledger recorded as deleted (positive evidence). */
	ledgerDeletedChildIds?: ReadonlySet<string>;
	/** Lease directories currently held in this process. */
	activeLeaseDirectories?: ReadonlySet<string>;
}

export interface RetentionClassContext {
	settings: ResolvedRetentionSettings;
	roots: RetentionRoots;
	now: number;
	dryRun: boolean;
	budget: RetentionBudget;
	live: RetentionLiveReferences;
	log: (line: string) => void;
}

export interface RetentionClassModule {
	id: RetentionClassId;
	scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult>;
}

export interface RetentionSweepReport {
	at: string;
	durationMs: number;
	dryRun: boolean;
	enabled: boolean;
	classes: RetentionClassResult[];
	totals: { scanned: number; reclaimed: number; bytes: number; entries: number };
	capped: boolean;
	stalled: RetentionClassId[];
}
