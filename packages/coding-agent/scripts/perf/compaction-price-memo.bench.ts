// compaction-price-memo.bench.ts — the trigger's context read, cold against warm.
//
// What is measured, and against what:
//   cold = a full context read over message objects the price memo has never seen, which is
//          what every read cost before estimateTokensByContent kept a price per message.
//          The objects are shallow copies of the same messages, so the content - and the
//          number the read returns - is identical; only the identity is new.
//   warm = the same read over the same objects it priced a moment ago: the trigger's real
//          shape, because a transcript grows by appending and a turn boundary reads the
//          context three to five times without the head changing.
//   ctrl = buildSessionContext over the same entries, touched by neither fix: the harness
//          control. A "win" that also shows up here is machine noise.
//
// Both arms must return the same token total or the bench exits 2 instead of reporting.
//
// Shapes measured: one read; a turn boundary (five reads: the shouldStopAfterTurn hook,
// _getThresholdContextTokens' two reads at agent_end, the admission gate, /usage); and the
// summarizedTokens reduce buildCompactionAppendix pays before it sizes the fact ledger.
//
// Flags: --json <path> --messages <n> --payload <chars> --fixture <path.jsonl> --iters <n>
//        --no-anchor (mark every assistant turn errored, so a real transcript has no usage anchor)
//        --loaded --arm-label <name> --git-sha <sha> --timeout-ms <n>
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens, estimateTokensByContent } from "../../src/core/compaction/index.js";
import { buildSessionContext, SessionManager, type SessionEntry } from "../../src/core/session-manager.js";

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

const LOAD_SECONDS = 1200;
let busy: ChildProcess[] = [];

function startLoad(count = 12): number {
	const script = `const until = Date.now() + ${LOAD_SECONDS * 1000}; let x = 1; while (Date.now() < until) { x = Math.sqrt(x * 1.0000001) + 1; }`;
	for (let i = 0; i < count; i++) {
		// Not detached, and the child kills itself: a stranded load generator keeps the
		// machine busy for whoever measures next.
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
	for (const child of busy) if (!child.killed) child.kill("SIGKILL");
	busy = [];
}

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * A transcript with no readable usage anchor, which is the shape that costs a full
 * character walk per read: every assistant message carries stopReason "error", so
 * estimateContextTokens finds no provider count to anchor on.
 */
function syntheticTranscript(messages: number, payload: number): AgentMessage[] {
	const rnd = lcg(11);
	const out: AgentMessage[] = [];
	const filler = (tag: string): string => {
		const body = `${tag} 压缩触发判据 ${"lorem ipsum dolor sit ".repeat(4)}\`\`\`ts\nconst v = 1;\n\`\`\`\n`;
		return body.repeat(Math.max(1, Math.ceil(payload / body.length))).slice(0, payload);
	};
	for (let i = 0; i < messages; i++) {
		const text = filler(`message ${i} ${Math.floor(rnd() * 1000)}`);
		if (i % 3 === 1) {
			out.push({
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error",
				timestamp: Date.now(),
				api: "faux",
				provider: "faux",
				model: "faux-1",
			} as never);
		} else if (i % 3 === 2) {
			out.push({
				role: "toolResult",
				toolCallId: `tc-${i}`,
				toolName: "bash",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			} as never);
		} else {
			out.push({ role: "user", content: text, timestamp: Date.now() } as never);
		}
	}
	return out;
}

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
	return `${label.padEnd(22)} n=${String(stats.n).padStart(3)} min=${stats.min.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`;
}

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

type Report = Record<string, unknown>;

async function main(): Promise<void> {
	const loaded = has("--loaded");
	const iters = Math.max(2, optNum("--iters", 30));
	const fixture = opt("--fixture", "");
	const report: Report = {
		bench: "compaction-price-memo",
		armLabel: opt("--arm-label", loaded ? "loaded" : "idle"),
		loaded,
		node: process.version,
		loadavg: loadavg().map((value) => Number(value.toFixed(2))),
		iters,
		gitSha: opt("--git-sha", "unknown"),
		gcExposed: typeof (globalThis as { gc?: () => void }).gc === "function",
		startedAt: new Date().toISOString(),
	};

	if (loaded) {
		const spawned = startLoad();
		console.log(`[load] started ${spawned} busy processes (${LOAD_SECONDS}s self-kill)`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	let messages: AgentMessage[];
	let entries: SessionEntry[] = [];
	if (fixture) {
		const manager = await SessionManager.openInMemoryAsync(fixture);
		entries = manager.getBranch();
		messages = buildSessionContext(entries).messages;
	} else {
		messages = syntheticTranscript(optNum("--messages", 2000), optNum("--payload", 400));
	}
	if (has("--no-anchor")) {
		// A real transcript ends on an assistant message carrying usage, and that anchor
		// makes estimateContextTokens price only the tail - nothing to measure. Marking
		// every assistant turn as errored reproduces the shape perfC measured (no
		// readable usage anywhere, so every read prices every character) without
		// touching a single character of content.
		messages = messages.map((message) =>
			message.role === "assistant" ? ({ ...message, stopReason: "error" } as AgentMessage) : message,
		);
		report.noAnchor = true;
	}
	// One fresh-identity copy of the transcript per cold round: the memo is keyed on the
	// message object, so a cold round needs objects it has not priced. Shallow copies
	// share every content block, which is what keeps this affordable.
	const variants: AgentMessage[][] = Array.from({ length: iters }, () =>
		messages.map((message) => ({ ...message }) as AgentMessage),
	);
	const chars = messages.reduce((total, message) => total + estimateTokensByContent(message) * 4, 0);
	const coldTotal = estimateContextTokens(variants[0]);
	const warmTotal = estimateContextTokens(messages);
	if (coldTotal.tokens !== warmTotal.tokens) {
		console.error(`[fatal] cold=${coldTotal.tokens} warm=${warmTotal.tokens}: the arms disagree`);
		stopLoad();
		process.exit(2);
	}
	report.source = fixture || "synthetic";
	report.messages = messages.length;
	report.pricedCharsApprox = chars;
	report.tokens = warmTotal.tokens;
	report.lastUsageIndex = warmTotal.lastUsageIndex;
	report.variants = variants.length;
	console.log(
		`# bench=compaction-price-memo source=${fixture || "synthetic"} messages=${messages.length} chars~=${chars} tokens=${warmTotal.tokens} anchor=${warmTotal.lastUsageIndex} arm=${report.armLabel} loaded=${loaded} iters=${iters}`,
	);
	if (coldTotal.lastUsageIndex !== null) {
		console.error("[fatal] the fixture has a usage anchor, so neither arm walks the transcript");
		stopLoad();
		process.exit(2);
	}

	const sliceTokens = (source: AgentMessage[]): number =>
		source.reduce((total, message) => total + estimateTokensByContent(message), 0);

	const samples: Record<string, number[]> = {
		coldRead: [],
		coldRead2: [],
		warmRead: [],
		warmRead2: [],
		coldTurn: [],
		warmTurn: [],
		coldSlice: [],
		warmSlice: [],
		ctrl: [],
	};
	const pairs: Array<{ read: number; turn: number; slice: number; noiseCold: number; noiseWarm: number }> = [];
	const clone = (): AgentMessage[] => messages.map((message) => ({ ...message }) as AgentMessage);

	// Untimed warm-up: the first rounds of a fresh process are JIT warm-up, and a ratio
	// between an arm that ran first and one that ran second would be a reading of the
	// compiler rather than of the fix.
	for (let round = 0; round < Math.min(3, iters); round++) {
		estimateContextTokens(clone());
		estimateContextTokens(messages);
		sliceTokens(messages);
		if (entries.length > 0) buildSessionContext(entries);
	}

	for (let round = 0; round < iters; round++) {
		// Every cold measurement gets its own fresh objects, built outside the timed
		// region: the memo is keyed on the message object, so reusing one set would
		// quietly turn the second cold arm into a warm one (this bench measured
		// warm/warm until each cold read got its own copy).
		const coldOne = clone();
		const coldTwo = clone();
		const coldFive = [clone(), clone(), clone(), clone(), clone()];
		const coldForSlice = clone();
		const taken: Record<string, number> = {};
		const time = (arm: string, run: () => unknown): void => {
			tryGc();
			const started = performance.now();
			run();
			taken[arm] = performance.now() - started;
			samples[arm].push(taken[arm]);
		};
		time("coldRead", () => estimateContextTokens(coldOne));
		time("warmRead", () => estimateContextTokens(messages));
		time("coldRead2", () => estimateContextTokens(coldTwo));
		time("warmRead2", () => estimateContextTokens(messages));
		time("coldTurn", () => {
			for (const set of coldFive) estimateContextTokens(set);
		});
		time("warmTurn", () => {
			for (let read = 0; read < 5; read++) estimateContextTokens(messages);
		});
		time("coldSlice", () => sliceTokens(coldForSlice));
		time("warmSlice", () => sliceTokens(messages));
		time("ctrl", () => {
			if (entries.length > 0) buildSessionContext(entries);
			else syntheticTranscript(64, 64);
		});
		pairs.push({
			read: taken.warmRead / Math.max(taken.coldRead, 1e-9),
			turn: taken.warmTurn / Math.max(taken.coldTurn, 1e-9),
			slice: taken.warmSlice / Math.max(taken.coldSlice, 1e-9),
			noiseCold: taken.coldRead2 / Math.max(taken.coldRead, 1e-9),
			noiseWarm: taken.warmRead2 / Math.max(taken.warmRead, 1e-9),
		});
	}

	const stats = Object.fromEntries(Object.entries(samples).map(([arm, runs]) => [arm, statsOf(runs)]));
	report.stats = stats;
	report.pairedMedian = {
		warmOverColdRead: Number(median(pairs.map((p) => p.read)).toFixed(4)),
		warmOverColdTurn: Number(median(pairs.map((p) => p.turn)).toFixed(4)),
		warmOverColdSlice: Number(median(pairs.map((p) => p.slice)).toFixed(4)),
		noiseFloorCold: Number(median(pairs.map((p) => p.noiseCold)).toFixed(4)),
		noiseFloorWarm: Number(median(pairs.map((p) => p.noiseWarm)).toFixed(4)),
	};
	for (const arm of Object.keys(stats)) {
		console.log(`     ${fmt(arm, stats[arm] as Stats)}`);
	}
	const paired = report.pairedMedian as Record<string, number>;
	console.log(
		`     paired median warm/cold: read=${paired.warmOverColdRead} turn(5 reads)=${paired.warmOverColdTurn} slice=${paired.warmOverColdSlice}`,
	);
	console.log(
		`     noise floor: coldRead2/coldRead=${paired.noiseFloorCold} warmRead2/warmRead=${paired.noiseFloorWarm}; ctrl p50=${(stats.ctrl as Stats).p50.toFixed(2)}ms (untouched code)`,
	);

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
