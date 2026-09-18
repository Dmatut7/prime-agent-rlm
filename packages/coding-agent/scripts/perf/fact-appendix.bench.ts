// fact-appendix.bench.ts — extractFactsFromText: this tree against a baseline tree.
//
// What is measured, and against what:
//   new = this worktree's extractFactsFromText (shared line decomposition + linear
//         full-SHA run scan, the perfC H1 fix 1 lane);
//   old = the same function imported from a baseline checkout given as --base-tree
//         (e.g. /tmp/fixShrink-base). Without --base-tree the old arm is skipped and
//         only the new arm runs; the script must never crash for a missing tree.
//   Both arms must return byte-identical JSON on the equivalence pre-check corpus
//   (both prose modes), or the bench exits 2 instead of reporting a faster wrong
//   answer.
//
// Why interleaved: old and new run in the same process, back-to-back, with the order
// alternating every round, so JIT state, GC state and machine load are shared. An
// external load spike lands on both arms of a pair, which is why the paired-ratio
// median (new/old per round) is the robust statistic. Absolute ms are only
// comparable within the same run, paired; never across runs or machines.
//
// Negative controls (a "win" that shows up in any of these is machine noise, not a
// fix) - all three are named in every output:
//   (a) old-vs-old: the old arm timed twice under two labels, the noise floor;
//   (b) no-separator corpus: the same shapes with every line separator removed, a
//       corpus the shared-line change cannot touch; ratio should be ~1.00;
//   (c) extractPaths: a pass the fix did not change, module-private in both arms,
//       so the control runs a verbatim baseline copy of it, timed under two labels;
//       ratio should be ~1.00.
//
// Shapes measured: one big blob (a giant tool result), a chunked batch (the
// per-message shape compaction actually calls), and the no-separator control.
//
// Flags: --iters <n> --json <path> --fixture <path.jsonl> --base-tree <path>
//        --loaded --seed <n> --timeout-ms <n> --arm-label <name> --git-sha <sha>
// Run as: npx tsx --expose-gc scripts/perf/fact-appendix.bench.ts [--base-tree ...]
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractFactsFromText as newExtract, factSources } from "../../src/core/compaction/fact-appendix.js";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.js";

const TIMEOUT_MS = optNum("--timeout-ms", 60_000);
const hardExit = setTimeout(() => {
	console.error("[fatal] bench timeout");
	stopLoad();
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

const LOAD_SECONDS = 240;
let busy: ChildProcess[] = [];

function startLoad(count = 12): number {
	const script = `const until = Date.now() + ${LOAD_SECONDS * 1000}; let x = 1; while (Date.now() < until) { x = Math.sqrt(x * 1.0000001) + 1; }`;
	for (let i = 0; i < count; i++) {
		// Not detached, and the child kills itself when the spin deadline passes: a
		// stranded load generator keeps the machine busy for whoever measures next.
		busy.push(spawn(process.execPath, ["-e", script], { stdio: "ignore" }));
	}
	return busy.length;
}
function stopLoad(): void {
	for (const child of busy) if (!child.killed) child.kill("SIGKILL");
	busy = [];
}

/** Collect between timed calls when the host was started with --expose-gc; a no-op (and reported as such) otherwise. */
function tryGc(): void {
	const collect = (globalThis as { gc?: () => void }).gc;
	if (typeof collect === "function") collect();
}

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
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
	return `${label.padEnd(24)} n=${String(stats.n).padStart(3)} min=${stats.min.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`;
}
function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}
function pairedMedian(pairs: number[]): number {
	return Number(median(pairs).toFixed(4));
}

/* -------------------------------------------------------------------------- */
/* Control (c): verbatim baseline copy of extractPaths                          */
/* -------------------------------------------------------------------------- */

/** Supporting declarations so the verbatim copy below stays untouched. */
interface RawFact {
	kind: string;
	value: string;
	key: string;
}
const MAX_VALUE_CHARS = { path: 200 };

const PATH_TRAILING_JUNK = /[.,;:!?)\]}'"`>*]+$/;
const RELATIVE_WITH_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const PATH_NOISE_SEGMENT = /(?:^|\/)(?:node_modules|\.git|\.venv|__pycache__)(?:\/|$)/;

/** Whether a character can appear in a filesystem path. */
function isPathChar(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) || // 0-9
		(code >= 0x41 && code <= 0x5a) || // A-Z
		(code >= 0x61 && code <= 0x7a) || // a-z
		code === 0x2f || // /
		code === 0x2e || // .
		code === 0x5f || // _
		code === 0x2b || // +
		code === 0x2d || // -
		code === 0x7e // ~
	);
}

/**
 * Extract path candidates with one linear scan over maximal runs of path characters.
 *
 * A regex shaped `segment(?:/segment)+` backtracks quadratically on a long run that
 * contains no slash, and an 800k-character tool result of repeated "x" is exactly
 * that - it hung a compaction for minutes. Scanning runs instead is O(text length)
 * on every input.
 */
function extractPaths(text: string, out: RawFact[]): void {
	let index = 0;
	while (index < text.length) {
		if (!isPathChar(text.charCodeAt(index))) {
			index++;
			continue;
		}
		const runStart = index;
		let slashes = 0;
		while (index < text.length && isPathChar(text.charCodeAt(index))) {
			if (text.charCodeAt(index) === 0x2f) slashes++;
			index++;
		}
		if (slashes === 0) continue;
		let value = text.slice(runStart, index).replace(PATH_TRAILING_JUNK, "");
		while (value.endsWith("/")) value = value.slice(0, -1);
		if (value.length < 4 || value.length > MAX_VALUE_CHARS.path) continue;
		// A URL is a run with "://" in it, and a doubled slash is not a filesystem path.
		if (value.includes("//")) continue;
		if (PATH_NOISE_SEGMENT.test(value)) continue;
		const segments = value.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length < 2) continue;
		const absolute = value.startsWith("/") || value.startsWith("~/");
		const last = segments[segments.length - 1];
		if (!absolute && segments.length < 3 && !RELATIVE_WITH_EXTENSION.test(last)) continue;
		out.push({ kind: "path", value, key: value });
	}
}

/* -------------------------------------------------------------------------- */
/* Corpus                                                                      */
/* -------------------------------------------------------------------------- */

const HEX = "0123456789abcdef";

function sha40(seed: number): string {
	return `${(seed % 16).toString(16)}${HEX.repeat(3).slice(0, 39)}`;
}

/**
 * Deterministic, seed-driven line mix covering the shapes the extractor pays for:
 * git logs with 40-hex SHAs, error reports, JSON settings blobs, paths, unit
 * numbers, issue refs, code-shaped lines, CJK, fences, and escaped two-character
 * "\n" separators alternating with real ones (the tool-call JSON shape).
 */
function buildBlock(seed: number, rnd: () => number): string {
	const lines: string[] = [];
	for (let i = 0; i < 200; i++) {
		const n = seed * 200 + i;
		const shape = Math.floor(rnd() * 20);
		switch (shape) {
			case 0:
				lines.push(`worker ${n} exited 0 after ${n % 900}s using ${n % 500}MB at /var/log/app/${n % 97}/shard-${n}.log`);
				break;
			case 1:
				lines.push(`commit ${sha40(n)} refs/heads/feat-${n % 40} exit code ${n % 3}`);
				break;
			case 2:
				lines.push(`[2026-09-18] Error: shard ${n % 7} failed to flush after ${n % 90}s`);
				break;
			case 3:
				lines.push(`git diff ${sha40(n)}..HEAD --stat`);
				break;
			case 4:
				lines.push(`{"reserveTokens": ${16384 + n}, "keepRecentTokens": ${20000 + n}, "timeout": ${30 + n % 60}}`);
				break;
			case 5:
				lines.push("ENOENT: no such file or directory, open '/etc/hosts'");
				break;
			case 6:
				lines.push(`Traceback (most recent call last): line ${n % 900}, in main`);
				break;
			case 7:
				lines.push(`fixes #${4000 + n % 900} and issues/${5000 + n % 900} with limit: ${n % 50}`);
				break;
			case 8:
				lines.push(`failed to resolve host shard-${n % 97}.internal after ${n % 12}ms`);
				break;
			case 9:
				lines.push("const x = 1; expect(a).toBe(b); +  added line");
				break;
			case 10:
				lines.push("压缩失败了：Error: 无法解析 JSON 配置文件 路径 /Users/老板/文件.md");
				break;
			case 11:
				lines.push(`cd /repo-${n % 17} && cat packages/coding-agent/src/core/compaction/compaction.ts | head -${n % 99}`);
				break;
			case 12:
				lines.push("```ts");
				lines.push(`const value${n % 31} = computeShard(${n % 13}); // threshold ${n % 40}`);
				lines.push("```");
				break;
			case 13:
				lines.push(`max_attempts=${3 + n % 5} idleMinutes: ${n % 90} timeout=${3000 + n}`);
				break;
			case 14:
				lines.push("panic: runtime error: invalid memory address or nil pointer dereference");
				break;
			case 15:
				lines.push(`roll back to ${sha40(n).slice(0, 8)} if /tmp/dir${n % 30}/file${n % 30}.md breaks`);
				break;
			case 16:
				lines.push(`bailian/qwen3.8-max-0902 UUID 01a07767-0a8e-719d-9367-${(n % 999).toString().padStart(4, "0")}`);
				break;
			case 17:
				lines.push(`https://github.com/PrimeIntellect-ai/prime-agent/issues/${4600 + n % 90}`);
				break;
			case 18:
				lines.push("Warning: deprecated API used, will be removed in version 2");
				break;
			default:
				lines.push(`shard-${n % 97} wrote /tmp/dir${n % 30}/file${n}.md with exit code ${n % 3} in ${n % 40}ms`);
				break;
		}
	}
	return lines.map((line, i) => `${line}${i % 3 === 2 ? "\\n" : "\n"}`).join("");
}

interface Corpus {
	blob: string;
	chunked: string[];
	controlNoSep: string;
}

function syntheticCorpus(seed: number): Corpus {
	const rnd = lcg(seed);
	const parts: string[] = [];
	for (let i = 0; i < 190; i++) parts.push(buildBlock(i, rnd));
	const blob = parts.join("\n");
	const chunked = parts.flatMap((block, i) => {
		const half = Math.ceil(block.length / 2);
		return [block.slice(0, half), block.slice(half), `header note ${i} for the message`];
	});
	const controlNoSep = blob.replace(/\n/g, " ").replace(/\\n/g, " ").slice(0, Math.floor(blob.length * 0.6));
	return { blob, chunked, controlNoSep };
}

/**
 * A real transcript's fact-bearing texts: open the .jsonl in memory, build the
 * session context, and take every text factSources would hand the extractor.
 * factSources itself is byte-identical in the baseline (pinned by the equivalence
 * test), so both arms see the same corpus.
 */
async function fixtureCorpus(path: string): Promise<Corpus> {
	const manager = await SessionManager.openInMemoryAsync(path);
	const messages = buildSessionContext(manager.getBranch()).messages;
	const texts = messages.flatMap((message) => factSources(message).map((source) => source.text));
	if (texts.length === 0) throw new Error(`fixture ${path} produced no fact-bearing texts`);
	const blob = texts.join("\n");
	const controlNoSep = blob.replace(/\n/g, " ").replace(/\\n/g, " ").slice(0, Math.floor(blob.length * 0.6));
	return { blob, chunked: texts, controlNoSep };
}

type ExtractFn = (text: string, options?: { prose?: boolean }) => RawFact[];

async function main(): Promise<void> {
	const loaded = has("--loaded");
	const iters = Math.max(2, optNum("--iters", 30));
	const seed = optNum("--seed", 20260918);
	const fixture = opt("--fixture", "");
	const baseTree = opt("--base-tree", "");
	const report: Record<string, unknown> = {
		bench: "fact-appendix",
		armLabel: opt("--arm-label", loaded ? "loaded" : "idle"),
		loaded,
		node: process.version,
		loadavg: loadavg().map((value) => Number(value.toFixed(2))),
		iters,
		seed,
		gitSha: opt("--git-sha", "") || gitShaOf(),
		gcExposed: typeof (globalThis as { gc?: () => void }).gc === "function",
		startedAt: new Date().toISOString(),
	};

	if (loaded) {
		const spawned = startLoad();
		console.log(`[load] started ${spawned} busy processes (${LOAD_SECONDS}s self-kill)`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	const corpus = fixture ? await fixtureCorpus(fixture) : syntheticCorpus(seed);
	const corpusBytes = {
		blob: corpus.blob.length,
		chunked: corpus.chunked.reduce((total, text) => total + text.length, 0),
		chunkedTexts: corpus.chunked.length,
		controlNoSep: corpus.controlNoSep.length,
	};
	report.source = fixture || "synthetic";
	report.corpusBytes = corpusBytes;

	// The old arm is a runtime parameter (which baseline tree to compare against),
	// so it cannot be a static import; the bench imports it only when given.
	let oldExtract: ExtractFn | undefined;
	if (baseTree) {
		const oldUrl = pathToFileURL(
			resolve(baseTree, "packages/coding-agent/src/core/compaction/fact-appendix.js"),
		).href;
		const module = (await import(oldUrl)) as { extractFactsFromText: ExtractFn };
		oldExtract = module.extractFactsFromText;
	}
	report.oldArm = oldExtract ? baseTree : "skipped (no --base-tree)";

	if (oldExtract) {
		const boundary = [
			buildBlock(9001, lcg(seed)),
			"commit abc1234 failed to build /tmp/out/a.json with exit code 2 and issues/99",
			"Error: failed to sync repo\\nError: retry limit exceeded\\ndone",
			"",
		];
		const precheck = [boundary[0], boundary[0].slice(0, 4000), ...boundary.slice(1), corpus.blob];
		for (const [index, text] of precheck.entries()) {
			for (const prose of [false, true]) {
				const oldJson = JSON.stringify(oldExtract(text, { prose }));
				const newJson = JSON.stringify(newExtract(text, { prose }));
				if (oldJson !== newJson) {
					console.error(`[fatal] equivalence pre-check failed: corpus[${index}] prose=${prose}`);
					stopLoad();
					process.exit(2);
				}
			}
		}
		report.equivalencePrecheck = "passed (byte-identical JSON, both prose modes)";
	} else {
		report.equivalencePrecheck = "not run (old arm skipped)";
	}

	console.log(
		`# bench=fact-appendix source=${report.source} seed=${seed} blob=${(corpusBytes.blob / 1e6).toFixed(2)}MB chunked=${corpusBytes.chunkedTexts} texts ${(corpusBytes.chunked / 1e6).toFixed(2)}MB controlNoSep=${(corpusBytes.controlNoSep / 1e6).toFixed(2)}MB oldArm=${report.oldArm} arm=${report.armLabel} loaded=${loaded} iters=${iters} gcExposed=${report.gcExposed}`,
	);

	const samples: Record<string, number[]> = {
		blobOld: [],
		blobNew: [],
		chunkedOld: [],
		chunkedNew: [],
		controlNoSepOld: [],
		controlNoSepNew: [],
		noiseFloorOldA: [],
		noiseFloorOldB: [],
		ctrlExtractPathsA: [],
		ctrlExtractPathsB: [],
	};
	const pairs: Record<string, number[]> = {
		blob: [],
		chunked: [],
		controlNoSep: [],
		noiseFloorOld: [],
		ctrlExtractPaths: [],
	};

	// Untimed warm-up: the first rounds of a fresh process are JIT warm-up, and a
	// ratio between an arm that ran first and one that ran second would be a
	// reading of the compiler rather than of the fix.
	const warmBlock = buildBlock(9100 + (seed % 97), lcg(seed + 1));
	for (let round = 0; round < 3; round++) {
		newExtract(warmBlock, { prose: false });
		oldExtract?.(warmBlock, { prose: false });
		newExtract(corpus.blob.slice(0, 400_000), { prose: false });
		oldExtract?.(corpus.blob.slice(0, 400_000), { prose: false });
		const ctrlOut: RawFact[] = [];
		extractPaths(corpus.blob.slice(0, 400_000), ctrlOut);
	}

	const time = (arm: string, run: () => unknown): number => {
		tryGc();
		const started = performance.now();
		run();
		const elapsed = performance.now() - started;
		samples[arm].push(elapsed);
		return elapsed;
	};

	const runChunked = (fn: ExtractFn): void => {
		for (const text of corpus.chunked) fn(text, { prose: false });
	};
	const runBlob = (fn: ExtractFn): void => {
		fn(corpus.blob, { prose: false });
	};
	const runControl = (fn: ExtractFn): void => {
		fn(corpus.controlNoSep, { prose: false });
	};
	const runCtrlPaths = (): void => {
		const out: RawFact[] = [];
		extractPaths(corpus.blob, out);
	};

	for (let round = 0; round < iters; round++) {
		if (oldExtract) {
			// Alternating order per round so a first-mover advantage cannot become a
			// systematic bias; each pair shares the round's machine state.
			const oldFirst = round % 2 === 0;
			const both = (armOld: string, armNew: string, run: (fn: ExtractFn) => void): void => {
				if (oldFirst) {
					time(armOld, () => run(oldExtract as ExtractFn));
					time(armNew, () => run(newExtract));
				} else {
					time(armNew, () => run(newExtract));
					time(armOld, () => run(oldExtract as ExtractFn));
				}
				pairs[armOld === "blobOld" ? "blob" : armOld === "chunkedOld" ? "chunked" : "controlNoSep"].push(
					samples[armNew][samples[armNew].length - 1] / Math.max(samples[armOld][samples[armOld].length - 1], 1e-9),
				);
			};
			both("blobOld", "blobNew", runBlob);
			both("chunkedOld", "chunkedNew", runChunked);
			both("controlNoSepOld", "controlNoSepNew", runControl);
			// Control (a): the old arm twice under two labels - the noise floor.
			time("noiseFloorOldA", () => runBlob(oldExtract));
			time("noiseFloorOldB", () => runBlob(oldExtract));
			pairs.noiseFloorOld.push(
				samples.noiseFloorOldB[samples.noiseFloorOldB.length - 1] /
					Math.max(samples.noiseFloorOldA[samples.noiseFloorOldA.length - 1], 1e-9),
			);
		} else {
			time("blobNew", () => runBlob(newExtract));
			time("chunkedNew", () => runChunked(newExtract));
			time("controlNoSepNew", () => runControl(newExtract));
		}
		// Control (c): the unchanged pass, verbatim copy, timed under two labels.
		time("ctrlExtractPathsA", runCtrlPaths);
		time("ctrlExtractPathsB", runCtrlPaths);
		pairs.ctrlExtractPaths.push(
			samples.ctrlExtractPathsB[samples.ctrlExtractPathsB.length - 1] /
				Math.max(samples.ctrlExtractPathsA[samples.ctrlExtractPathsA.length - 1], 1e-9),
		);
	}

	const stats = Object.fromEntries(Object.entries(samples).map(([arm, runs]) => [arm, statsOf(runs)]));
	report.stats = stats;
	report.pairedMedian = {
		blobNewOverOld: pairedMedian(pairs.blob),
		chunkedNewOverOld: pairedMedian(pairs.chunked),
		controlNoSepNewOverOld: pairedMedian(pairs.controlNoSep),
		noiseFloorOldOverOld: pairedMedian(pairs.noiseFloorOld),
		ctrlExtractPathsSelf: pairedMedian(pairs.ctrlExtractPaths),
	};
	for (const arm of Object.keys(stats)) {
		if ((stats[arm] as Stats).n > 0) console.log(`     ${fmt(arm, stats[arm] as Stats)}`);
	}
	const paired = report.pairedMedian as Record<string, number>;
	if (oldExtract) {
		console.log(
			`     paired median new/old: blob=${paired.blobNewOverOld} chunked=${paired.chunkedNewOverOld} controlNoSep=${paired.controlNoSepNewOverOld}`,
		);
		console.log(
			`     negative controls: (a) old-vs-old noise floor=${paired.noiseFloorOldOverOld} (b) no-separator corpus=${paired.controlNoSepNewOverOld} (c) extractPaths self=${paired.ctrlExtractPathsSelf}`,
		);
	} else {
		console.log(
			`     negative controls: (a) old-vs-old not run (old arm skipped) (b) no-separator corpus single-arm (no ratio) (c) extractPaths self=${paired.ctrlExtractPathsSelf}`,
		);
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

function gitShaOf(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "unknown";
	}
}

void main().catch((error) => {
	console.error(error);
	stopLoad();
	process.exit(1);
});
