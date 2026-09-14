// The one entry point every trigger shares: CLI, daemon interval, and tests.
//
// The in-flight guard mirrors the failed-worker reaper (daemon-supervisor.ts): a
// second trigger while a sweep is running returns the running sweep instead of
// walking the tree twice, and a long sweep can never stack.
import { getLogger } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../settings-manager.js";
import { retentionRoots, writeRetentionReport } from "./reports.js";
import { runRetentionSweep } from "./sweep.js";
import type { ResolvedRetentionSettings, RetentionSweepReport } from "./types.js";

const retentionLog = getLogger("coding-agent.core.retention");

let inFlight: Promise<RetentionSweepReport> | undefined;
let lastReport: RetentionSweepReport | undefined;

export interface RetentionRunOptions {
	agentDir?: string;
	/** Force a dry run for this sweep (CLI flag or the env rollback lever). */
	dryRun?: boolean;
	/** Pre-resolved settings; the default reads the process settings. */
	settings?: ResolvedRetentionSettings;
	now?: number;
	/** Resident sessions, when the caller is a daemon that knows them. */
	residentSessionIds?: ReadonlySet<string>;
	activeLeaseDirectories?: ReadonlySet<string>;
}

export function resolveRetentionSettingsForProcess(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): ResolvedRetentionSettings {
	return SettingsManager.create(cwd, agentDir).getRetentionSettings();
}

/** True while a sweep is running, so a caller can skip scheduling another. */
export function retentionSweepInFlight(): boolean {
	return inFlight !== undefined;
}

export function lastRetentionSweepReport(): RetentionSweepReport | undefined {
	return lastReport;
}

export async function runRetentionSweepOnce(options: RetentionRunOptions = {}): Promise<RetentionSweepReport> {
	if (inFlight) {
		return inFlight;
	}
	const promise = (async () => {
		const roots = retentionRoots({ ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
		const settings = options.settings ?? resolveRetentionSettingsForProcess();
		const report = await runRetentionSweep({
			settings,
			roots,
			...(options.now !== undefined ? { now: options.now } : {}),
			...(options.dryRun ? { forceDryRun: true } : {}),
			...(options.residentSessionIds ? { residentSessionIds: options.residentSessionIds } : {}),
			...(options.activeLeaseDirectories ? { activeLeaseDirectories: options.activeLeaseDirectories } : {}),
			log: (line) => retentionLog.info(line),
		});
		writeRetentionReport(roots, report);
		lastReport = report;
		return report;
	})().finally(() => {
		inFlight = undefined;
	});
	inFlight = promise;
	return promise;
}
