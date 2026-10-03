#!/usr/bin/env node
/**
 * Warm spare pool telemetry analyzer (wave-34/36 consumer; local only, no daemon
 * protocol surface).
 *
 * Reads the structured lines that DaemonSupervisor.logWarmPoolTelemetry writes
 * into the shared agent log (~/.prime/agent/logs/agent.jsonl): one JSON object
 * per line, envelope `{ts, level, component, msg, pid, ...fields}`, with
 * `msg` = "warm pool spawn|claim|reclaim".
 *
 * Field shape (daemon-supervisor.ts, verified against a live log):
 *   spawn    outcome: ready|failed   cwd, workerId, durationMs, reason? (free text on failed)
 *            — pre-345093198 entries carry the discriminator as `status`, not `outcome`
 *   claim    outcome: hit|miss|expired
 *            hit:     cwd, workerId, ageMs
 *            miss:    missReason (no_ready_spare|warming_timeout|env_mismatch|claim_check_failed),
 *                     cwd, workerId?/ageMs? (present when a spare existed)
 *            expired: reclaimReason (ttl_expired|exited), cwd, workerId, ageMs
 *   reclaim  reason: ttl_expired|exited|memory_pressure|pool_closed|claim_failed|drain,
 *            detail (free text), cwd, workerId, ageMs
 *   every event also carries depth {ready, warming} and supervisor-lifetime
 *   totals {spawns, claims, reclaims} sampled at event time.
 *
 * Usage
 * -----
 *   node scripts/warm-pool-stats.mjs [--file <agent.jsonl> ...] [--since <iso>] [--json]
 *   node scripts/warm-pool-stats.mjs --self-test
 *
 * `--file` is repeatable (pass agent.jsonl.old alongside agent.jsonl to span a
 * rotation). Exit codes: 0 = report printed, 1 = self-test mismatch, 2 = usage
 * or unreadable input.
 */

import { accessSync, createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_LOG_FILE = path.join(homedir(), ".prime/agent/logs/agent.jsonl");
const MSG_PREFIX = "warm pool ";
const KNOWN_EVENTS = ["spawn", "claim", "reclaim"];
const RECLAIM_REASONS = ["ttl_expired", "exited", "memory_pressure", "pool_closed", "claim_failed", "drain"];

class UsageError extends Error {}

function parseArgs(argv) {
	const options = { files: [], since: undefined, json: false, selfTest: false, help: false };
	const takeValue = (index, inline, flag) => {
		if (inline !== undefined) return { value: inline, next: index };
		const value = argv[index + 1];
		if (value === undefined) throw new UsageError(`${flag} needs a value`);
		return { value, next: index + 1 };
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		if (flag === "--help" || flag === "-h") {
			options.help = true;
		} else if (flag === "--json") {
			options.json = true;
		} else if (flag === "--self-test") {
			options.selfTest = true;
		} else if (flag === "--file") {
			const taken = takeValue(i, inline, "--file");
			options.files.push(taken.value);
			i = taken.next;
		} else if (flag === "--since") {
			const taken = takeValue(i, inline, "--since");
			const ms = Date.parse(taken.value);
			if (!Number.isFinite(ms)) throw new UsageError(`--since needs an ISO timestamp, got "${taken.value}"`);
			options.since = { raw: taken.value, ms };
			i = taken.next;
		} else {
			throw new UsageError(`unknown option "${arg}"`);
		}
	}
	if (options.files.length === 0) options.files.push(DEFAULT_LOG_FILE);
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/warm-pool-stats.mjs [options]

Options:
  --file <path>   agent.jsonl to read, repeatable (default: ~/.prime/agent/logs/agent.jsonl)
  --since <iso>   Only count events at or after this timestamp
  --json          Print the machine-readable summary instead of the text report
  --self-test     Run the built-in fixture assertions
  -h, --help      Show this help
`);
}

// ---------------------------------------------------------------------------
// parsing / summarization (pure: fed lines, returns a summary object)
// ---------------------------------------------------------------------------

/** One log line -> a normalized pool event, or null when the line is not a pool event. Throws on malformed JSON. */
function parsePoolLine(line) {
	const trimmed = line.trim();
	if (trimmed === "" || !trimmed.includes(MSG_PREFIX)) return null;
	const entry = JSON.parse(trimmed);
	if (typeof entry.msg !== "string" || !entry.msg.startsWith(MSG_PREFIX)) return null;
	const event = entry.msg.slice(MSG_PREFIX.length);
	if (!KNOWN_EVENTS.includes(event)) return null;
	// Pre-345093198 spawn entries used `status` for what is now `outcome`.
	const outcome = typeof entry.outcome === "string" ? entry.outcome : typeof entry.status === "string" ? entry.status : undefined;
	return {
		ts: typeof entry.ts === "string" ? entry.ts : undefined,
		tsMs: Number.isFinite(Date.parse(entry.ts)) ? Date.parse(entry.ts) : undefined,
		pid: typeof entry.pid === "number" ? entry.pid : undefined,
		event,
		outcome,
		outcomeKey: typeof entry.outcome === "string" ? "outcome" : typeof entry.status === "string" ? "status" : "missing",
		missReason: typeof entry.missReason === "string" ? entry.missReason : undefined,
		reason: typeof entry.reason === "string" ? entry.reason : undefined,
		reclaimReason: typeof entry.reclaimReason === "string" ? entry.reclaimReason : undefined,
		cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
		ageMs: typeof entry.ageMs === "number" ? entry.ageMs : undefined,
		durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
		depthReady: typeof entry.depth?.ready === "number" ? entry.depth.ready : undefined,
		depthWarming: typeof entry.depth?.warming === "number" ? entry.depth.warming : undefined,
		totals: typeof entry.totals === "object" && entry.totals !== null ? entry.totals : undefined,
	};
}

function bump(bucket, key) {
	bucket[key] = (bucket[key] ?? 0) + 1;
}

function emptySummary() {
	return {
		events: 0,
		byEvent: { spawn: 0, claim: 0, reclaim: 0 },
		malformedLines: 0,
		firstTs: undefined,
		lastTs: undefined,
		firstTsMs: undefined,
		lastTsMs: undefined,
		spawns: {
			ready: 0,
			failed: 0,
			otherOutcome: {},
			outcomeKey: { outcome: 0, status: 0, missing: 0 },
			durationsReady: [],
			durationsFailed: [],
			failReasons: {},
		},
		claims: {
			hit: 0,
			miss: 0,
			expired: 0,
			otherOutcome: {},
			missReasons: {},
			expiredCauses: {},
			hitAges: [],
			expiredAges: [],
		},
		reclaims: {
			total: 0,
			reasons: Object.fromEntries(RECLAIM_REASONS.map((reason) => [reason, 0])),
			unknownReasons: {},
			ages: [],
		},
		depth: { readySamples: [], warmingSamples: [], eventsWithReady: 0, sampledEvents: 0 },
		// pid -> { events, firstTsMs, lastTsMs, samples, counted, lastTotals } for the cross-check and depth integral
		lifetimes: new Map(),
	};
}

function addEvent(summary, event) {
	summary.events += 1;
	summary.byEvent[event.event] += 1;
	if (event.tsMs !== undefined) {
		if (summary.firstTsMs === undefined || event.tsMs < summary.firstTsMs) {
			summary.firstTsMs = event.tsMs;
			summary.firstTs = event.ts;
		}
		if (summary.lastTsMs === undefined || event.tsMs > summary.lastTsMs) {
			summary.lastTsMs = event.tsMs;
			summary.lastTs = event.ts;
		}
	}
	if (event.depthReady !== undefined) {
		summary.depth.readySamples.push(event.depthReady);
		summary.depth.sampledEvents += 1;
		if (event.depthReady >= 1) summary.depth.eventsWithReady += 1;
	}
	if (event.depthWarming !== undefined) summary.depth.warmingSamples.push(event.depthWarming);

	if (event.event === "spawn") {
		bump(summary.spawns.outcomeKey, event.outcomeKey);
		if (event.outcome === "ready") summary.spawns.ready += 1;
		else if (event.outcome === "failed") summary.spawns.failed += 1;
		else bump(summary.spawns.otherOutcome, event.outcome ?? "missing");
		if (event.durationMs !== undefined) {
			(event.outcome === "failed" ? summary.spawns.durationsFailed : summary.spawns.durationsReady).push(event.durationMs);
		}
		if (event.outcome === "failed" && event.reason !== undefined) bump(summary.spawns.failReasons, event.reason);
	} else if (event.event === "claim") {
		if (event.outcome === "hit") summary.claims.hit += 1;
		else if (event.outcome === "miss") summary.claims.miss += 1;
		else if (event.outcome === "expired") summary.claims.expired += 1;
		else bump(summary.claims.otherOutcome, event.outcome ?? "missing");
		if (event.outcome === "miss" && event.missReason !== undefined) bump(summary.claims.missReasons, event.missReason);
		if (event.outcome === "expired" && event.reclaimReason !== undefined) bump(summary.claims.expiredCauses, event.reclaimReason);
		if (event.outcome === "hit" && event.ageMs !== undefined) summary.claims.hitAges.push(event.ageMs);
		if (event.outcome === "expired" && event.ageMs !== undefined) summary.claims.expiredAges.push(event.ageMs);
	} else if (event.event === "reclaim") {
		summary.reclaims.total += 1;
		if (event.reason !== undefined && event.reason in summary.reclaims.reasons) {
			summary.reclaims.reasons[event.reason] += 1;
		} else {
			bump(summary.reclaims.unknownReasons, event.reason ?? "missing");
		}
		if (event.ageMs !== undefined) summary.reclaims.ages.push(event.ageMs);
	}

	if (event.pid !== undefined) {
		let lifetime = summary.lifetimes.get(event.pid);
		if (lifetime === undefined) {
			lifetime = { events: 0, firstTsMs: event.tsMs, lastTsMs: event.tsMs, samples: [], counted: emptyTotals(), lastTotals: undefined };
			summary.lifetimes.set(event.pid, lifetime);
		}
		lifetime.events += 1;
		if (event.tsMs !== undefined) {
			lifetime.firstTsMs = Math.min(lifetime.firstTsMs ?? event.tsMs, event.tsMs);
			lifetime.lastTsMs = Math.max(lifetime.lastTsMs ?? event.tsMs, event.tsMs);
		}
		if (event.tsMs !== undefined && event.depthReady !== undefined && event.depthWarming !== undefined) {
			lifetime.samples.push({ tsMs: event.tsMs, ready: event.depthReady, warming: event.depthWarming });
		}
		countIntoTotals(lifetime.counted, event);
		if (event.totals !== undefined) lifetime.lastTotals = event.totals;
	}
}

function emptyTotals() {
	return {
		spawns: { ready: 0, failed: 0 },
		claims: { hit: 0, miss: 0, expired: 0 },
		reclaims: Object.fromEntries(RECLAIM_REASONS.map((reason) => [reason, 0])),
	};
}

/** Mirror of the supervisor's counter increments, for the per-lifetime cross-check. */
function countIntoTotals(counted, event) {
	if (event.event === "spawn") {
		if (event.outcome === "ready") counted.spawns.ready += 1;
		if (event.outcome === "failed") counted.spawns.failed += 1;
	} else if (event.event === "claim") {
		if (event.outcome === "hit") counted.claims.hit += 1;
		if (event.outcome === "miss") counted.claims.miss += 1;
		if (event.outcome === "expired") counted.claims.expired += 1;
	} else if (event.event === "reclaim" && event.reason !== undefined && event.reason in counted.reclaims) {
		counted.reclaims[event.reason] += 1;
	}
}

/** Summarize pool events from raw log text (one JSON entry per line). */
function summarizeText(text, { sinceMs } = {}) {
	const summary = emptySummary();
	for (const line of text.split("\n")) {
		let event;
		try {
			event = parsePoolLine(line);
		} catch {
			summary.malformedLines += 1;
			continue;
		}
		if (event === null) continue;
		if (sinceMs !== undefined && event.tsMs !== undefined && event.tsMs < sinceMs) continue;
		addEvent(summary, event);
	}
	return summary;
}

// ---------------------------------------------------------------------------
// quantiles
// ---------------------------------------------------------------------------

/** Linear-interpolation quantile on an ascending-sorted array; null when empty. */
function quantile(sorted, p) {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0];
	const pos = (sorted.length - 1) * p;
	const base = Math.floor(pos);
	const rest = pos - base;
	const next = sorted[base + 1];
	return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

/** min/p50/p90/p99/max/mean for a sample list, or null when empty. */
function describe(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
	return {
		n: sorted.length,
		min: sorted[0],
		p50: quantile(sorted, 0.5),
		p90: quantile(sorted, 0.9),
		p99: quantile(sorted, 0.99),
		max: sorted[sorted.length - 1],
		mean,
	};
}

/**
 * Step-function average of the ready/warming gauge: each event's sample holds
 * until the next event of the same daemon lifetime. Null when no lifetime spans
 * more than one timestamped event.
 */
function timeWeightedDepth(summary) {
	let weightedReady = 0;
	let weightedWarming = 0;
	let spanMs = 0;
	for (const lifetime of summary.lifetimes.values()) {
		if (lifetime.samples === undefined || lifetime.samples.length < 2) continue;
		const ordered = [...lifetime.samples].sort((a, b) => a.tsMs - b.tsMs);
		for (let i = 0; i < ordered.length - 1; i++) {
			const dt = ordered[i + 1].tsMs - ordered[i].tsMs;
			if (dt <= 0) continue;
			weightedReady += ordered[i].ready * dt;
			weightedWarming += ordered[i].warming * dt;
			spanMs += dt;
		}
	}
	if (spanMs === 0) return null;
	return { ready: weightedReady / spanMs, warming: weightedWarming / spanMs, spanMs };
}

/** Compare what we counted per lifetime against the totals the supervisor last reported. */
function crossCheckTotals(summary) {
	const verdicts = [];
	for (const [pid, lifetime] of summary.lifetimes) {
		if (lifetime.lastTotals === undefined) {
			verdicts.push({ pid, events: lifetime.events, verdict: "no totals snapshot" });
			continue;
		}
		const counted = flattenTotals(lifetime.counted);
		const reported = flattenTotals({
			spawns: lifetime.lastTotals.spawns ?? {},
			claims: lifetime.lastTotals.claims ?? {},
			reclaims: lifetime.lastTotals.reclaims ?? {},
		});
		const shortfall = Object.keys(reported).filter((key) => (counted[key] ?? 0) < (reported[key] ?? 0));
		const overcount = Object.keys(reported).filter((key) => (counted[key] ?? 0) > (reported[key] ?? 0));
		verdicts.push({
			pid,
			events: lifetime.events,
			verdict: shortfall.length === 0 && overcount.length === 0 ? "consistent" : overcount.length > 0 ? "counted more than reported (file interleave?)" : "file begins mid-lifetime (rotation cut earlier events)",
			counted,
			reported,
		});
	}
	return verdicts;
}

function flattenTotals(totals) {
	const flat = {};
	for (const [group, counters] of Object.entries(totals)) {
		for (const [key, value] of Object.entries(counters)) {
			if (typeof value === "number") flat[`${group}.${key}`] = value;
		}
	}
	return flat;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function fmtMs(value) {
	if (value === null || value === undefined) return "-";
	if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
	return `${Math.round(value)}ms`;
}

/** Depth gauges are integer counts; interpolated quantiles get one decimal. */
function fmtDepth(value) {
	if (value === null || value === undefined) return "-";
	return `${Math.round(value * 10) / 10}`;
}

function fmtPercent(part, whole) {
	if (whole === 0) return "-";
	return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtDescribe(label, stats, unit = fmtMs) {
	if (stats === null) return `  ${label}: no samples`;
	return `  ${label}: n=${stats.n} p50=${unit(stats.p50)} p90=${unit(stats.p90)} p99=${unit(stats.p99)} max=${unit(stats.max)}`;
}

function fmtBucketMap(map, order) {
	const keys = order ?? Object.keys(map);
	return keys
		.filter((key) => (map[key] ?? 0) > 0)
		.map((key) => `${key} ${map[key]}`)
		.join(", ");
}

function formatReport(summary, { files }) {
	const lines = [];
	lines.push("Warm pool stats");
	lines.push("");
	lines.push(`source:   ${files.join(", ")}`);
	const span =
		summary.firstTsMs === undefined
			? "no events"
			: `${summary.firstTs} -> ${summary.lastTs} (${fmtMs(summary.lastTsMs - summary.firstTsMs)})`;
	lines.push(`span:     ${span}; ${summary.events} pool event(s) across ${summary.lifetimes.size} daemon lifetime(s)`);
	if (summary.malformedLines > 0) lines.push(`skipped:  ${summary.malformedLines} malformed pool-looking line(s)`);
	const shapeBits = Object.entries(summary.spawns.outcomeKey)
		.filter(([, count]) => count > 0)
		.map(([key, count]) => `"${key}" x${count}`);
	if (shapeBits.length > 0) {
		lines.push(`shape:    spawn discriminator key — ${shapeBits.join(", ")} (legacy "status" = pre-345093198 entries)`);
	}
	lines.push("");

	const claimsTotal = summary.claims.hit + summary.claims.miss + summary.claims.expired;
	lines.push(
		`claims    hit ${summary.claims.hit} (${fmtPercent(summary.claims.hit, claimsTotal)})  ` +
			`miss ${summary.claims.miss} (${fmtPercent(summary.claims.miss, claimsTotal)})  ` +
			`expired ${summary.claims.expired} (${fmtPercent(summary.claims.expired, claimsTotal)})`,
	);
	const missLine = fmtBucketMap(summary.claims.missReasons, ["no_ready_spare", "warming_timeout", "env_mismatch", "claim_check_failed"]);
	if (missLine !== "") lines.push(`  miss reasons:   ${missLine}`);
	const expiredLine = fmtBucketMap(summary.claims.expiredCauses, ["ttl_expired", "exited"]);
	if (expiredLine !== "") lines.push(`  expired causes: ${expiredLine}`);
	const otherClaims = fmtBucketMap(summary.claims.otherOutcome);
	if (otherClaims !== "") lines.push(`  unknown outcomes: ${otherClaims}`);

	lines.push(`spawns    ready ${summary.spawns.ready}  failed ${summary.spawns.failed}`);
	lines.push(fmtDescribe("spawn duration (ready)", describe(summary.spawns.durationsReady)));
	lines.push(fmtDescribe("spawn duration (failed)", describe(summary.spawns.durationsFailed)));
	const failLine = fmtBucketMap(summary.spawns.failReasons);
	if (failLine !== "") lines.push(`  fail reasons: ${failLine}`);

	lines.push(fmtDescribe("spare age at claim hit", describe(summary.claims.hitAges)));
	lines.push(fmtDescribe("spare age at claim expired", describe(summary.claims.expiredAges)));
	lines.push(fmtDescribe("spare age at reclaim", describe(summary.reclaims.ages)));

	const reclaimsLine = fmtBucketMap(summary.reclaims.reasons, RECLAIM_REASONS);
	const unknownReclaims = fmtBucketMap(summary.reclaims.unknownReasons);
	lines.push(
		`reclaims  total ${summary.reclaims.total}${reclaimsLine === "" ? "" : ` — ${reclaimsLine}`}${unknownReclaims === "" ? "" : ` (unknown: ${unknownReclaims})`}`,
	);

	const ready = describe(summary.depth.readySamples);
	const warming = describe(summary.depth.warmingSamples);
	lines.push(
		`depth     sampled on ${summary.depth.sampledEvents} event(s); ready>=1 on ${fmtPercent(summary.depth.eventsWithReady, summary.depth.sampledEvents)} of them`,
	);
	if (ready !== null) lines.push(`  ready:   p50=${fmtDepth(ready.p50)} p90=${fmtDepth(ready.p90)} max=${ready.max}`);
	if (warming !== null) lines.push(`  warming: p50=${fmtDepth(warming.p50)} p90=${fmtDepth(warming.p90)} max=${warming.max}`);
	const weighted = timeWeightedDepth(summary);
	if (weighted !== null) {
		lines.push(
			`  time-weighted (step approx over ${fmtMs(weighted.spanMs)}): ready=${weighted.ready.toFixed(2)} warming=${weighted.warming.toFixed(2)}`,
		);
	}

	const verdicts = crossCheckTotals(summary);
	if (verdicts.length > 0) {
		lines.push("");
		lines.push("totals cross-check (counted events vs the supervisor's last reported totals, per lifetime):");
		for (const verdict of verdicts) {
			lines.push(`  pid ${verdict.pid}: ${verdict.events} event(s) — ${verdict.verdict}`);
		}
	}
	return lines.join("\n");
}

function toJsonSummary(summary, files) {
	return {
		files,
		events: summary.events,
		byEvent: summary.byEvent,
		malformedLines: summary.malformedLines,
		span: { first: summary.firstTs ?? null, last: summary.lastTs ?? null },
		lifetimes: summary.lifetimes.size,
		spawns: {
			ready: summary.spawns.ready,
			failed: summary.spawns.failed,
			outcomeKey: summary.spawns.outcomeKey,
			otherOutcome: summary.spawns.otherOutcome,
			durationReadyMs: describe(summary.spawns.durationsReady),
			durationFailedMs: describe(summary.spawns.durationsFailed),
			failReasons: summary.spawns.failReasons,
		},
		claims: {
			hit: summary.claims.hit,
			miss: summary.claims.miss,
			expired: summary.claims.expired,
			hitRate: summary.claims.hit + summary.claims.miss + summary.claims.expired === 0 ? null : summary.claims.hit / (summary.claims.hit + summary.claims.miss + summary.claims.expired),
			missReasons: summary.claims.missReasons,
			expiredCauses: summary.claims.expiredCauses,
			otherOutcome: summary.claims.otherOutcome,
			hitAgeMs: describe(summary.claims.hitAges),
			expiredAgeMs: describe(summary.claims.expiredAges),
		},
		reclaims: {
			total: summary.reclaims.total,
			reasons: summary.reclaims.reasons,
			unknownReasons: summary.reclaims.unknownReasons,
			ageMs: describe(summary.reclaims.ages),
		},
		depth: {
			sampledEvents: summary.depth.sampledEvents,
			eventsWithReady: summary.depth.eventsWithReady,
			ready: describe(summary.depth.readySamples),
			warming: describe(summary.depth.warmingSamples),
			timeWeighted: timeWeightedDepth(summary),
		},
		totalsCrossCheck: crossCheckTotals(summary),
	};
}

// ---------------------------------------------------------------------------
// file reading
// ---------------------------------------------------------------------------

async function summarizeFile(file, options) {
	const summary = emptySummary();
	const stream = createReadStream(file, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		let event;
		try {
			event = parsePoolLine(line);
		} catch {
			summary.malformedLines += 1;
			continue;
		}
		if (event === null) continue;
		if (options.sinceMs !== undefined && event.tsMs !== undefined && event.tsMs < options.sinceMs) continue;
		addEvent(summary, event);
	}
	return summary;
}

function mergeSummaries(target, source) {
	const merged = emptySummary();
	const restate = (summary) => {
		// Replaying raw samples is lossy for lifetimes; merge via a synthetic replay of
		// the aggregate fields the report reads, and union the lifetime maps by pid.
		merged.events += summary.events;
		merged.malformedLines += summary.malformedLines;
		for (const event of KNOWN_EVENTS) merged.byEvent[event] += summary.byEvent[event];
		if (summary.firstTsMs !== undefined && (merged.firstTsMs === undefined || summary.firstTsMs < merged.firstTsMs)) {
			merged.firstTsMs = summary.firstTsMs;
			merged.firstTs = summary.firstTs;
		}
		if (summary.lastTsMs !== undefined && (merged.lastTsMs === undefined || summary.lastTsMs > merged.lastTsMs)) {
			merged.lastTsMs = summary.lastTsMs;
			merged.lastTs = summary.lastTs;
		}
		merged.spawns.ready += summary.spawns.ready;
		merged.spawns.failed += summary.spawns.failed;
		for (const key of ["outcome", "status", "missing"]) merged.spawns.outcomeKey[key] += summary.spawns.outcomeKey[key];
		merged.spawns.durationsReady.push(...summary.spawns.durationsReady);
		merged.spawns.durationsFailed.push(...summary.spawns.durationsFailed);
		mergeBucket(merged.spawns.failReasons, summary.spawns.failReasons);
		mergeBucket(merged.spawns.otherOutcome, summary.spawns.otherOutcome);
		merged.claims.hit += summary.claims.hit;
		merged.claims.miss += summary.claims.miss;
		merged.claims.expired += summary.claims.expired;
		mergeBucket(merged.claims.missReasons, summary.claims.missReasons);
		mergeBucket(merged.claims.expiredCauses, summary.claims.expiredCauses);
		mergeBucket(merged.claims.otherOutcome, summary.claims.otherOutcome);
		merged.claims.hitAges.push(...summary.claims.hitAges);
		merged.claims.expiredAges.push(...summary.claims.expiredAges);
		merged.reclaims.total += summary.reclaims.total;
		mergeBucket(merged.reclaims.reasons, summary.reclaims.reasons);
		mergeBucket(merged.reclaims.unknownReasons, summary.reclaims.unknownReasons);
		merged.reclaims.ages.push(...summary.reclaims.ages);
		merged.depth.readySamples.push(...summary.depth.readySamples);
		merged.depth.warmingSamples.push(...summary.depth.warmingSamples);
		merged.depth.eventsWithReady += summary.depth.eventsWithReady;
		merged.depth.sampledEvents += summary.depth.sampledEvents;
		for (const [pid, lifetime] of summary.lifetimes) {
			const existing = merged.lifetimes.get(pid);
			if (existing === undefined) {
				merged.lifetimes.set(pid, lifetime);
			} else {
				existing.events += lifetime.events;
				existing.firstTsMs = Math.min(existing.firstTsMs ?? lifetime.firstTsMs, lifetime.firstTsMs ?? existing.firstTsMs);
				existing.lastTsMs = Math.max(existing.lastTsMs ?? 0, lifetime.lastTsMs ?? 0);
				existing.samples.push(...lifetime.samples);
				mergeTotalsInto(existing.counted, lifetime.counted);
				// The later file's snapshot supersedes: it carries the older counts too.
				if (lifetime.lastTotals !== undefined) existing.lastTotals = lifetime.lastTotals;
			}
		}
	};
	restate(target);
	restate(source);
	return merged;
}

function mergeBucket(target, source) {
	for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function mergeTotalsInto(target, source) {
	for (const [group, counters] of Object.entries(source)) {
		for (const [key, value] of Object.entries(counters)) target[group][key] = (target[group][key] ?? 0) + value;
	}
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function fixtureEntry(msg, fields, ts) {
	return JSON.stringify({ ts, level: "info", component: "coding-agent.daemon-supervisor", pid: 4242, mode: "daemon", msg, ...fields });
}

function fixtureTotals(overrides = {}) {
	return {
		spawns: { ready: 0, failed: 0, ...overrides.spawns },
		claims: { hit: 0, miss: 0, expired: 0, ...overrides.claims },
		reclaims: { ttl_expired: 0, exited: 0, memory_pressure: 0, pool_closed: 0, claim_failed: 0, drain: 0, ...overrides.reclaims },
	};
}

/** A coherent single-lifetime sequence: every counter the supervisor would bump is bumped. */
function coherentFixture() {
	const depth = { ready: 0, warming: 1 };
	const lines = [
		fixtureEntry("warm pool spawn", { status: "ready", cwd: "/repo", workerId: "w1", durationMs: 200, depth, totals: fixtureTotals({ spawns: { ready: 1 } }) }, "2026-10-03T10:00:00.000Z"),
		fixtureEntry("warm pool claim", { outcome: "hit", cwd: "/repo", workerId: "w1", ageMs: 50, depth: { ready: 0, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 1 }, claims: { hit: 1 } }) }, "2026-10-03T10:00:01.000Z"),
		fixtureEntry("warm pool spawn", { outcome: "ready", cwd: "/repo", workerId: "w2", durationMs: 400, depth, totals: fixtureTotals({ spawns: { ready: 2 }, claims: { hit: 1 } }) }, "2026-10-03T10:00:02.000Z"),
		fixtureEntry("warm pool claim", { outcome: "miss", missReason: "no_ready_spare", cwd: "/elsewhere", depth: { ready: 1, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 2 }, claims: { hit: 1, miss: 1 } }) }, "2026-10-03T10:00:03.000Z"),
		fixtureEntry("warm pool spawn", { outcome: "failed", cwd: "/repo", workerId: "w3", durationMs: 900, reason: "boot budget exceeded", depth: { ready: 1, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 2, failed: 1 }, claims: { hit: 1, miss: 1 } }) }, "2026-10-03T10:00:04.000Z"),
		fixtureEntry("warm pool claim", { outcome: "expired", reclaimReason: "ttl_expired", cwd: "/repo", workerId: "w2", ageMs: 300000, depth: { ready: 0, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 2, failed: 1 }, claims: { hit: 1, miss: 1, expired: 1 } }) }, "2026-10-03T10:05:04.000Z"),
		fixtureEntry("warm pool reclaim", { reason: "ttl_expired", detail: "idle TTL expired", cwd: "/repo", workerId: "w2", ageMs: 300100, depth: { ready: 0, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 2, failed: 1 }, claims: { hit: 1, miss: 1, expired: 1 }, reclaims: { ttl_expired: 1 } }) }, "2026-10-03T10:05:05.000Z"),
		fixtureEntry("warm pool reclaim", { reason: "drain", detail: "daemon shutdown", cwd: "/repo", workerId: "w4", ageMs: 60000, depth: { ready: 0, warming: 0 }, totals: fixtureTotals({ spawns: { ready: 2, failed: 1 }, claims: { hit: 1, miss: 1, expired: 1 }, reclaims: { ttl_expired: 1, drain: 1 } }) }, "2026-10-03T10:05:06.000Z"),
	];
	return lines.join("\n");
}

async function runSelfTest() {
	const controls = [];
	const fixture = coherentFixture();
	const summary = summarizeText(fixture);

	controls.push({
		name: "event counts by type",
		run: () => (summary.events === 8 && summary.byEvent.spawn === 3 && summary.byEvent.claim === 3 && summary.byEvent.reclaim === 2 ? [] : [`got ${JSON.stringify(summary.byEvent)} over ${summary.events}`]),
	});
	controls.push({
		name: "claim outcome distribution and hit rate",
		run: () =>
			summary.claims.hit === 1 && summary.claims.miss === 1 && summary.claims.expired === 1
				? []
				: [`got hit=${summary.claims.hit} miss=${summary.claims.miss} expired=${summary.claims.expired}`],
	});
	controls.push({
		name: "miss reasons and expired causes attributed",
		run: () =>
			summary.claims.missReasons.no_ready_spare === 1 && summary.claims.expiredCauses.ttl_expired === 1
				? []
				: [`got ${JSON.stringify(summary.claims.missReasons)} / ${JSON.stringify(summary.claims.expiredCauses)}`],
	});
	controls.push({
		name: "legacy spawn `status` key is still counted as an outcome",
		run: () =>
			summary.spawns.ready === 2 && summary.spawns.failed === 1 && summary.spawns.outcomeKey.status === 1 && summary.spawns.outcomeKey.outcome === 2
				? []
				: [`got ${JSON.stringify({ ready: summary.spawns.ready, failed: summary.spawns.failed, key: summary.spawns.outcomeKey })}`],
	});
	controls.push({
		name: "spawn duration samples land in the ready/failed series",
		run: () => {
			const ready = describe(summary.spawns.durationsReady);
			const failed = describe(summary.spawns.durationsFailed);
			return ready?.n === 2 && ready.p50 === 300 && failed?.n === 1 && failed.max === 900 ? [] : [`ready=${JSON.stringify(ready)} failed=${JSON.stringify(failed)}`];
		},
	});
	controls.push({
		name: "reclaim reasons distribute over the six buckets",
		run: () =>
			summary.reclaims.total === 2 && summary.reclaims.reasons.ttl_expired === 1 && summary.reclaims.reasons.drain === 1 && summary.reclaims.reasons.exited === 0
				? []
				: [`got ${JSON.stringify(summary.reclaims.reasons)}`],
	});
	controls.push({
		name: "spare ages collected for hits and reclaims",
		run: () => {
			const hit = describe(summary.claims.hitAges);
			const reclaim = describe(summary.reclaims.ages);
			return hit?.n === 1 && hit.max === 50 && reclaim?.n === 2 && reclaim.p50 === 180050 ? [] : [`hit=${JSON.stringify(hit)} reclaim=${JSON.stringify(reclaim)}`];
		},
	});
	controls.push({
		name: "depth gauge sampled with ready>=1 fraction",
		run: () =>
			summary.depth.sampledEvents === 8 && summary.depth.eventsWithReady === 2 && describe(summary.depth.readySamples)?.max === 1
				? []
				: [`got sampled=${summary.depth.sampledEvents} withReady=${summary.depth.eventsWithReady}`],
	});
	controls.push({
		name: "per-lifetime totals cross-check passes on a coherent log",
		run: () => {
			const verdicts = crossCheckTotals(summary);
			return verdicts.length === 1 && verdicts[0].verdict === "consistent" ? [] : [`got ${JSON.stringify(verdicts)}`];
		},
	});
	controls.push({
		name: "a rotation-truncated log is flagged, not silently trusted",
		run: () => {
			const truncated = summarizeText(fixture.split("\n").slice(3).join("\n"));
			const verdicts = crossCheckTotals(truncated);
			return verdicts.length === 1 && verdicts[0].verdict.startsWith("file begins mid-lifetime") ? [] : [`got ${JSON.stringify(verdicts)}`];
		},
	});
	controls.push({
		name: "malformed JSON and non-pool lines are skipped, not fatal",
		run: () => {
			const mixed = summarizeText(`{"msg":"warm pool spawn", not json\n{"msg":"unrelated","ts":"2026-10-03T09:00:00Z"}\n${fixture}`);
			return mixed.events === 8 && mixed.malformedLines === 1 ? [] : [`got events=${mixed.events} malformed=${mixed.malformedLines}`];
		},
	});
	controls.push({
		name: "--since filters events before the cutoff",
		run: () => {
			const since = summarizeText(fixture, { sinceMs: Date.parse("2026-10-03T10:05:00.000Z") });
			return since.events === 3 && since.claims.expired === 1 && since.reclaims.total === 2 ? [] : [`got ${since.events} events`];
		},
	});
	controls.push({
		name: "quantile interpolates and degenerates cleanly",
		run: () =>
			quantile([10, 20, 30, 40], 0.5) === 25 && quantile([7], 0.99) === 7 && quantile([], 0.5) === null
				? []
				: ["quantile mismatch"],
	});
	controls.push({
		name: "unknown option is a usage error",
		run: () => {
			try {
				parseArgs(["--bogus"]);
				return ["--bogus was accepted"];
			} catch (error) {
				return error instanceof UsageError ? [] : [`threw ${error}`];
			}
		},
	});
	controls.push({
		name: "the report renders the fixture's headline numbers",
		run: () => {
			const report = formatReport(summary, { files: ["fixture"] });
			const needles = ["hit 1 (33.3%)", "miss 1 (33.3%)", "expired 1 (33.3%)", "ready 2  failed 1", "no_ready_spare 1", "ttl_expired 1, drain 1", 'legacy "status" = pre-345093198 entries'];
			return needles.filter((needle) => !report.includes(needle)).map((needle) => `report is missing "${needle}"`);
		},
	});
	controls.push({
		name: "reading a fixture file from disk matches the in-memory summary",
		run: async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "warm-pool-stats-selftest-"));
			try {
				const file = path.join(dir, "agent.jsonl");
				writeFileSync(file, `${fixture}\n`, "utf8");
				const fromDisk = await summarizeFile(file, {});
				return fromDisk.events === summary.events && fromDisk.claims.hit === summary.claims.hit && fromDisk.reclaims.total === summary.reclaims.total
					? []
					: [`disk=${fromDisk.events} memory=${summary.events}`];
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	});

	let mismatches = 0;
	for (const control of controls) {
		let failures;
		let threw;
		try {
			failures = await control.run();
		} catch (error) {
			threw = error;
		}
		const passed = threw === undefined && failures.length === 0;
		if (!passed) mismatches += 1;
		const detail = threw ? `threw ${threw.message}` : `${failures.length} failure(s)`;
		console.log(`${passed ? "ok  " : "FAIL"} ${control.name} (${detail})`);
		if (!passed && failures) for (const failure of failures) console.log(`       ${failure}`);
	}
	console.log(`self-test: ${controls.length} controls, ${mismatches} mismatch(es)`);
	return mismatches === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof UsageError ? error.message : String(error));
		return 2;
	}
	if (options.help) {
		printHelp();
		return 0;
	}
	if (options.selfTest) return runSelfTest();
	for (const file of options.files) {
		try {
			accessSync(file);
		} catch (error) {
			console.error(`cannot read ${file}: ${error.message}`);
			return 2;
		}
	}
	let summary = emptySummary();
	for (const file of options.files) {
		summary = mergeSummaries(summary, await summarizeFile(file, { sinceMs: options.since?.ms }));
	}
	if (options.json) {
		console.log(JSON.stringify(toJsonSummary(summary, options.files), null, 2));
	} else {
		console.log(formatReport(summary, { files: options.files }));
	}
	return 0;
}

process.exit(await main(process.argv.slice(2)));
