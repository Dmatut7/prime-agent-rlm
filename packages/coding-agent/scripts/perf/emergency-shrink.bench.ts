// emergency-shrink.bench.ts — the emergency shrink valve: folded totals vs the per-cut walk.
//
// What is measured, and against what:
//   new  = planEmergencyShrink in src (one pricing pass + two folds + one walk of the chosen cut)
//   old  = planEmergencyShrinkReference, the pre-fix planner copied verbatim from edcc31ff7
//          into test/fixtures/emergency-shrink-reference.ts (one full span walk per candidate cut)
//   old2 = the same reference arm under a second label: the noise floor of the pairing. A
//          "speedup" that also shows up here is machine noise, not the fix.
//   ctrl = findCutPoint, touched by neither fix: the harness control. It must come out ~1.0.
//
// Arms are interleaved round by round (and the round's starting arm alternates) so a load
// spike lands on both arms of a pair instead of on one arm's whole run. Every tier checks
// the two planners return the same plan before it reports any timing: a faster different
// answer is a regression, and this bench exits 2 rather than print one.
//
// Flags:
//   --json <path>          write the machine-readable report
//   --sizes 250,500,1000,2000   entries per A/B tier
//   --scale-sizes 1000,10000,100000   entries per linearity tier
//   --iters 30             paired rounds per tier (both arms, every round)
//   --payload 60           characters per entry in the synthetic branch
//   --old-cap-ms 20000     skip the old arm at a tier whose first probe exceeds this
//   --fixture <path.jsonl> measure a real transcript instead of the synthetic branch
//   --threshold <tokens>   override the threshold (default: the real 1M-window trigger)
//   --no-scale             skip the three-decade scale section (the old arm cannot afford it)
//   --loaded               spawn 12 busy processes for the loaded tier, then reap them
//   --arm-label <name>     tag this run in the json (for cross-tree pairing)
//   --timeout-ms <n>       hard exit(9) guard, default 20 minutes
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import {
	compactionThresholdTokens,
	DEFAULT_COMPACTION_SETTINGS,
	EMERGENCY_SHRINK_TARGET_RATIO,
	estimateTokensByContent,
	findCutPoint,
	planEmergencyShrink,
} from "../../src/core/compaction/index.js";
import { buildSessionContext, SessionManager, type SessionEntry } from "../../src/core/session-manager.js";
import { planEmergencyShrinkReference } from "../../test/fixtures/emergency-shrink-reference.js";

const TIMEOUT_MS = optNum("--timeout-ms", 20 * 60 * 1000);
const hardExit = setTimeout(() => {
	console.error("[fatal] bench timeout");
	process.exit(9);
}, TIMEOUT_MS);
hardExit.unref?.();

function has(flag: string): boolean {
	return process.argv.includes(flag);
}
function opt(flag: string, fallback: string): string {
	const at = process.argv.indexOf(flag);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
function optNum(flag: string, fallback: number): number {
	const raw = opt(flag, "");
	const parsed = Number.parseFloat(raw);
	return raw && Number.isFinite(parsed) ? parsed : fallback;
}
function optList(flag: string, fallback: number[]): number[] {
	const raw = opt(flag, "");
	if (!raw) return fallback;
	return raw
		.split(",")
		.map((part) => Number.parseInt(part, 10))
		.filter((value) => Number.isFinite(value));
}

/* ---------------------------------- load ---------------------------------- */

const LOAD_SECONDS = 1200;
let busy: ChildProcess[] = [];

function startLoad(count = 12): number {
	const script = `const until = Date.now() + ${LOAD_SECONDS * 1000}; let x = 1; while (Date.now() < until) { x = Math.sqrt(x * 1.0000001) + 1; }`;
	for (let i = 0; i < count; i++) {
		// Not detached: a detached child survives this process and keeps the machine
		// busy for the next lane (perfC left ten orphans that way). The child also
		// kills itself after LOAD_SECONDS, so a lost parent cannot strand it.
		busy.push(spawn(process.execPath, ["-e", script], { stdio: "ignore" }));
	}
	return busy.length;
}

/**
 * Collect before a timed call, when the host was started with --expose-gc: the cold arm
 * allocates a transcript copy per round, and without this the warm arm's timing is a
 * reading of the cold arm's garbage. Run these benches as
 * `npx tsx --expose-gc scripts/perf/<name>.bench.ts ...`; without the flag this is a no-op
 * and the readings say so in the json.
 */
function tryGc(): void {
	const collect = (globalThis as { gc?: () => void }).gc;
	if (typeof collect === "function") collect();
}

function stopLoad(): void {
	for (const child of busy) {
		if (!child.killed) child.kill("SIGKILL");
	}
	busy = [];
}

/* --------------------------------- fixtures -------------------------------- */

/** Deterministic PRNG, so two runs of the same tier measure the same branch. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * A synthetic branch in the shape the valve sees: mostly user/assistant/toolResult
 * triples, a few summary and marker entries, some CJK and fenced code so the content
 * density walk is doing its real work rather than an ASCII fast path.
 */
function syntheticBranch(count: number, payload: number, seed = 5): SessionEntry[] {
	const rnd = lcg(seed);
	const entries: SessionEntry[] = [];
	const base = Date.parse("2026-09-18T00:00:00.000Z");
	let lastId: string | null = null;
	const filler = (tag: string): string => {
		const body = `${tag} 压缩阀门 ${"lorem ipsum dolor sit ".repeat(4)}\`\`\`ts\nconst v = 1;\n\`\`\`\n`;
		return body.repeat(Math.max(1, Math.ceil(payload / body.length))).slice(0, payload);
	};
	for (let i = 0; i < count; i++) {
		const id = `entry-${i}`;
		const parentId = lastId;
		const timestamp = new Date(base + i * 1000).toISOString();
		const shape = i % 16;
		let entry: SessionEntry;
		if (shape === 11) {
			entry = {
				type: "branch_summary",
				id,
				parentId,
				timestamp,
				fromId: parentId ?? id,
				summary: i % 64 === 11 ? "" : filler(`branch summary ${i}`),
			};
		} else if (shape === 13) {
			entry = { type: "model_change", id, parentId, timestamp, provider: "faux", modelId: "faux-1" };
		} else {
			const text = filler(`message ${i} ${Math.floor(rnd() * 1000)}`);
			const message =
				i % 3 === 2
					? ({
							role: "toolResult",
							toolCallId: `tc-${i}`,
							toolName: "bash",
							content: [{ type: "text", text }],
							isError: false,
							timestamp: Date.now(),
						} as never)
					: i % 3 === 1
						? ({
								role: "assistant",
								content: [
									{ type: "thinking", thinking: text },
									{ type: "text", text },
									{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { command: `cmd-${i}` } },
								],
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
								stopReason: "error",
								timestamp: Date.now(),
								api: "faux",
								provider: "faux",
								model: "faux-1",
							} as never)
						: ({ role: "user", content: text, timestamp: Date.now() } as never);
			entry = { type: "message", id, parentId, timestamp, message };
		}
		entries.push(entry);
		lastId = id;
	}
	return entries;
}

async function realBranch(path: string): Promise<SessionEntry[]> {
	const manager = await SessionManager.openInMemoryAsync(path);
	return manager.getBranch();
}

/** The branch's price in the planner's own caliber: the work one span walk has to do. */
function branchTokens(entries: SessionEntry[]): number {
	return buildSessionContext(entries).messages.reduce(
		(total, message) => total + estimateTokensByContent(message),
		0,
	);
}

/** A threshold whose target lands partway in, so the cut search walks a long way. */
function thresholdFor(entries: SessionEntry[], share: number, override: number): number {
	if (override > 0) return override;
	const total = buildSessionContext(entries).messages.reduce(
		(tokens, message) => tokens + estimateTokensByContent(message),
		0,
	);
	return Math.max(1, Math.ceil((total * share) / EMERGENCY_SHRINK_TARGET_RATIO));
}

/* ---------------------------------- stats --------------------------------- */

interface Stats {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
}

function statsOf(samples: number[]): Stats {
	if (samples.length === 0) return { n: 0, min: 0, p50: 0, p95: 0, max: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return { n: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function fmt(label: string, stats: Stats): string {
	return `${label.padEnd(28)} n=${String(stats.n).padStart(3)} min=${stats.min.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`;
}

function median(values: number[]): number {
	const known = values.filter((value) => Number.isFinite(value));
	if (known.length === 0) return Number.NaN;
	const sorted = [...known].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/* ---------------------------------- main ---------------------------------- */

type Report = Record<string, unknown>;
const report: Report = {};

async function main(): Promise<void> {
	const loaded = has("--loaded");
	const iters = Math.max(1, optNum("--iters", 30));
	const payload = optNum("--payload", 60);
	const oldCapMs = optNum("--old-cap-ms", 20000);
	const thresholdOverride = optNum("--threshold", 0);
	const fixture = opt("--fixture", "");
	const armLabel = opt("--arm-label", loaded ? "loaded" : "idle");

	if (loaded) {
		const spawned = startLoad();
		console.log(`[load] started ${spawned} busy processes (${LOAD_SECONDS}s self-kill)`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	report.bench = "emergency-shrink";
	report.armLabel = armLabel;
	report.loaded = loaded;
	report.node = process.version;
	report.loadavg = loadavg().map((value) => Number(value.toFixed(2)));
	report.iters = iters;
	report.payload = payload;
	report.startedAt = new Date().toISOString();
	report.gitSha = opt("--git-sha", "unknown");
	report.gcExposed = typeof (globalThis as { gc?: () => void }).gc === "function";

	const entries = fixture ? await realBranch(fixture) : syntheticBranch(4000, payload);
	const realThreshold = compactionThresholdTokens(1_000_000, DEFAULT_COMPACTION_SETTINGS, {
		provider: "faux",
		modelId: "faux-1",
	});
	report.source = fixture || "synthetic";
	report.realThreshold = realThreshold;
	console.log(
		`# bench=emergency-shrink source=${fixture || "synthetic"} entries=${entries.length} arm=${armLabel} loaded=${loaded} iters=${iters} realThreshold=${realThreshold}`,
	);

	/* ---- A/B: interleaved arms at tiers the old walk can still afford ---- */
	const abTiers = fixture ? [entries.length] : optList("--sizes", [250, 500, 1000, 2000]);
	const ab: Report[] = [];
	for (const count of abTiers) {
		const slice = count >= entries.length ? entries : entries.slice(0, count);
		const threshold = thresholdFor(slice, 0.55, thresholdOverride);
		const newPlan = planEmergencyShrink(slice, threshold);
		const oldPlan = planEmergencyShrinkReference(slice, threshold);
		const plansEqual = JSON.stringify(newPlan) === JSON.stringify(oldPlan);
		if (!plansEqual) {
			console.error(`[fatal] tier=${slice.length} planners disagree; refusing to report timings`);
			console.error(`  new=${JSON.stringify(newPlan)?.slice(0, 400)}`);
			console.error(`  old=${JSON.stringify(oldPlan)?.slice(0, 400)}`);
			stopLoad();
			process.exit(2);
		}
		// Whether this tier can afford the old arm at all is decided on a small slice and
		// extrapolated with perfC's measured power law (exponent 3.96): probing the full
		// tier would cost the very run the cap exists to avoid (hours on a 50MB branch).
		const probeEntries = Math.min(slice.length, Math.max(64, optNum("--old-probe-entries", 1500)));
		const probeSlice = slice.slice(0, probeEntries);
		const probeThreshold = thresholdFor(probeSlice, 0.55, thresholdOverride);
		const probe = performance.now();
		planEmergencyShrinkReference(probeSlice, probeThreshold);
		const probeMs = performance.now() - probe;
		const OLD_EXPONENT = 3.96;
		const projectedMs =
			probeEntries >= slice.length ? probeMs : probeMs * (slice.length / probeEntries) ** OLD_EXPONENT;
		const runOld = projectedMs <= oldCapMs;

		// Untimed warm-up, so the first paired round is not measuring JIT compilation.
		planEmergencyShrink(slice, threshold);
		if (runOld) planEmergencyShrinkReference(slice, threshold);
		findCutPoint(slice, 0, slice.length, Math.max(1, Math.floor(threshold * 0.3)));

		const samples: Record<string, number[]> = { new: [], old: [], old2: [], ctrl: [] };
		const pairs: Array<{ newOld: number; noise: number; ctrl: number }> = [];
		// The cap skips the old arm's work, not the rounds: the new arm is cheap and the
		// reading wants the full iteration count either way.
		const rounds = iters;
		for (let round = 0; round < rounds; round++) {
			// Alternate which arm goes first, so warm-up and drift hit both.
			const order =
				round % 2 === 0
					? (["new", "old", "old2", "ctrl"] as const)
					: (["ctrl", "old2", "old", "new"] as const);
			const taken: Partial<Record<string, number>> = {};
			for (const arm of order) {
				// The cap has to skip the work, not just the printing: an old arm on a
				// 20MB branch is minutes per call, and the cap exists to not pay it.
				if ((arm === "old" || arm === "old2") && !runOld) continue;
				tryGc();
				const started = performance.now();
				if (arm === "new") planEmergencyShrink(slice, threshold);
				else if (arm === "old" || arm === "old2") planEmergencyShrinkReference(slice, threshold);
				else findCutPoint(slice, 0, slice.length, Math.max(1, Math.floor(threshold * 0.3)));
				taken[arm] = performance.now() - started;
				samples[arm].push(taken[arm]);
			}
			pairs.push({
				newOld: runOld ? (taken.new ?? 0) / Math.max(taken.old ?? 0, 1e-9) : Number.NaN,
				noise: runOld ? (taken.old2 ?? 0) / Math.max(taken.old ?? 0, 1e-9) : Number.NaN,
				ctrl: taken.new / Math.max(taken.new, 1e-9),
			});
		}
		const stats = {
			new: statsOf(samples.new),
			old: statsOf(samples.old),
			old2: statsOf(samples.old2),
			ctrl: statsOf(samples.ctrl),
		};
		const row: Report = {
			tier: slice.length,
			tokens: branchTokens(slice),
			threshold,
			targetTokens: Math.floor(threshold * EMERGENCY_SHRINK_TARGET_RATIO),
			plansEqual,
			reachedTarget: newPlan?.reachedTarget ?? null,
			firstKeptEntryIndex: newPlan?.firstKeptEntryIndex ?? null,
			droppedEntries: newPlan?.span.droppedEntries ?? null,
			oldArmProbeEntries: probeEntries,
			oldArmProbeMs: Number(probeMs.toFixed(2)),
			oldArmProjectedMs: Number(projectedMs.toFixed(1)),
			oldArmRan: runOld,
			rounds,
			p50RatioNewOverOld: Number(median(pairs.map((p) => p.newOld)).toFixed(4)),
			p50RatioNoiseFloor: Number(median(pairs.map((p) => p.noise)).toFixed(4)),
			...stats,
		};
		ab.push(row);
		console.log(
			`[ab] tier=${slice.length} tokens=${row.tokens} threshold=${threshold} keptIdx=${row.firstKeptEntryIndex} oldProbe=${probeMs.toFixed(1)}ms@${probeEntries} projected=${(projectedMs / 1000).toFixed(1)}s oldArm=${runOld ? "ran" : "SKIPPED(cap)"}`,
		);
		for (const arm of ["new", "old", "old2", "ctrl"] as const) {
			if ((arm === "old" || arm === "old2") && !runOld) continue;
			console.log(`     ${fmt(arm, stats[arm])}`);
		}
		console.log(
			`     paired p50 new/old=${row.p50RatioNewOverOld} noiseFloor(old2/old)=${row.p50RatioNoiseFloor}`,
		);
	}
	report.ab = ab;

	/* ---- scale: the new arm over three decades, with its growth rate ---- */
	const scaleTiers = has("--no-scale")
		? []
		: optList("--scale-sizes", fixture ? [1000, 5000, 20000] : [1000, 10000, 100000]);
	const scale: Report[] = [];
	const times: number[] = [];
	for (const count of scaleTiers) {
		// With a real transcript the scale tiers slice it, so every tier carries the real
		// per-entry byte size; the synthetic branch is the self-contained default.
		const slice = fixture
			? entries.slice(0, Math.min(count, entries.length))
			: syntheticBranch(count, optNum("--scale-payload", 200), 5);
		const threshold = thresholdFor(slice, 0.55, thresholdOverride);
		const plan = planEmergencyShrink(slice, threshold);
		const runs: number[] = [];
		planEmergencyShrink(slice, threshold);
		for (let i = 0; i < iters; i++) {
			tryGc();
			const started = performance.now();
			planEmergencyShrink(slice, threshold);
			runs.push(performance.now() - started);
		}
		const stats = statsOf(runs);
		times.push(stats.p50);
		scale.push({
			tier: slice.length,
			tokens: branchTokens(slice),
			threshold,
			reachedTarget: plan?.reachedTarget ?? null,
			firstKeptEntryIndex: plan?.firstKeptEntryIndex ?? null,
			droppedEntries: plan?.span.droppedEntries ?? null,
			...stats,
		});
		console.log(
			`[scale] ${fmt(`entries=${slice.length}`, stats)} tokens=${branchTokens(slice)} keptIdx=${plan?.firstKeptEntryIndex} reached=${plan?.reachedTarget}`,
		);
	}
	if (times.length >= 2) {
		const growths: number[] = [];
		for (let i = 1; i < times.length; i++) {
			const sizeFactor = scaleTiers[i] / scaleTiers[i - 1];
			growths.push(times[i] / Math.max(times[i - 1], 1e-9) / sizeFactor);
		}
		const exponent =
			Math.log(times[times.length - 1] / Math.max(times[0], 1e-9)) /
			Math.log(scaleTiers[scaleTiers.length - 1] / scaleTiers[0]);
		report.scale = scale;
		report.scaleGrowthOverLinear = growths.map((g) => Number(g.toFixed(3)));
		report.scaleExponent = Number(exponent.toFixed(3));
		console.log(
			`[scale] growthOverLinear per decade=${growths.map((g) => g.toFixed(2)).join("/")} fittedExponent=${exponent.toFixed(2)} (1.0 = linear; perfC measured 3.96 before the fix)`,
		);
		const lastTier = scaleTiers[scaleTiers.length - 1];
		const lastTime = times[times.length - 1];
		for (const target of [8444, 21121]) {
			if (target <= lastTier) continue;
			const extrapolated = lastTime * (target / lastTier) ** Math.max(exponent, 1);
			console.log(`[scale] extrapolated entries=${target}: ${(extrapolated / 1000).toFixed(2)}s`);
			report[`extrapolated_${target}`] = Number(extrapolated.toFixed(1));
		}
	}

	report.finishedAt = new Date().toISOString();
	if (loaded) stopLoad();
	const jsonPath = opt("--json", "");
	if (jsonPath) {
		writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
		console.log(`[json] ${jsonPath}`);
	}
	clearTimeout(hardExit);
	process.exit(0);
}

void main().catch((error) => {
	console.error(error);
	stopLoad();
	process.exit(1);
});
