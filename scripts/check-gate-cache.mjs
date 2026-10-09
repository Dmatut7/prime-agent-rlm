#!/usr/bin/env node
/**
 * check-gate-cache.mjs - content-fingerprint cache for the self-test style check gates
 * (`npm run check:installer`, `check:push-guard`, `check:secret-scan`, `check:browser-smoke`,
 * `check:ci-honesty`), which the pre-commit hook (`npm run check`) runs on every commit.
 *
 * Why: those gates re-run their full self-test suites on every commit although almost every
 * commit touches none of the scripts, manifests or workflow files they read. biome and tsgo
 * stay uncached on purpose - they judge the working tree itself and are fast.
 *
 * The rule this file enforces (fail-closed, "宁可慢不可漏"):
 *   a gate may be skipped ONLY when a cache entry says its input fingerprint last ran GREEN
 *   and every byte of that fingerprint still matches. Anything else - no cache file, a corrupt
 *   cache, a missing/changed/added input file, a different node platform, a manifest edit here,
 *   a gate that was red, interrupted or could not run - runs the gate in full.
 *
 * The fingerprint hashes, for each declared input pattern (globs allowed):
 *   - the pattern list itself (so editing GATES below reddens every gate),
 *   - scripts/check-gate-cache.mjs and package.json (the pipeline definition) for every gate,
 *   - node's version and process.platform (a gate's verdict is a property of its runtime too),
 *   - each matched file's path and full content; a declared literal file that is absent hashes
 *     as a MISSING marker, so it appearing later changes the fingerprint.
 *
 * State lives in `.gates-cache.json` at the repo root (gitignored; a fresh checkout or CI has
 * none, so every gate runs). Writes are atomic (tmp file + rename). A red or interrupted run is
 * recorded as non-green and therefore never skipped.
 *
 * Usage:
 *   node scripts/check-gate-cache.mjs --gate <name> -- <command...>   run or skip one gate
 *   node scripts/check-gate-cache.mjs --no-cache --gate <name> -- ... force the run, still
 *                                                                     refresh the cache on green
 *   node scripts/check-gate-cache.mjs --self-test                      fault-injection self-test
 *
 * Recovery (the brake and how to lift it):
 *   - PRIME_AGENT_GATE_CACHE=0 disables skipping for one invocation (same as --no-cache);
 *   - deleting .gates-cache.json makes every gate run once and rebuild it;
 *   - a red gate un-skips itself until it runs green again.
 * The command tail after `--` is joined with spaces and run by /bin/sh.
 * Exit codes: the wrapped gate's own exit code, or 2 for a usage error / unknown gate.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE = join(repoRoot, ".gates-cache.json");
const BYPASS_ENV = "PRIME_AGENT_GATE_CACHE";

/**
 * Gate -> input patterns. A literal path is one file; `*` matches within one segment, `**`
 * across segments. Directories walked for glob patterns skip build output and vendored trees
 * (node_modules, dist, coverage, .venv, __pycache__). A gate that reads build output anyway
 * (browser-smoke bundles packages/ai/dist) declares that directory as a LITERAL input: a
 * literal directory hashes its whole tree, dist included.
 */
const GATES = {
	installer: ["scripts/check-installer.mjs", "install.sh"],
	"push-guard": ["scripts/check-push-guard.mjs", "scripts/pre-push-guard.sh", ".husky/pre-push"],
	"secret-scan": [
		"scripts/check-secret-scan.mjs",
		"scripts/pre-push-secret-scan.mjs",
		"packages/coding-agent/src/core/share-secret-detectors.ts",
		".husky/pre-push",
	],
	"browser-smoke": [
		"scripts/check-browser-smoke.mjs",
		"scripts/browser-smoke-entry.ts",
		"packages/ai/src/**",
		"packages/ai/dist",
		"tsconfig.json",
		"package-lock.json",
	],
	"ci-honesty": [
		"scripts/**",
		".husky/**",
		".github/workflows/*.yml",
		"install.sh",
		"package-lock.json",
		"packages/**/package.json",
		"packages/*/test/**",
		"prime-agent-runtime/test/**",
		"packages/ai/src/**",
		"tsconfig.json",
	],
};

/** In every gate's fingerprint: this file (the manifest lives here) and the pipeline definition. */
const IMPLICIT_INPUTS = ["scripts/check-gate-cache.mjs", "package.json"];

const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "dist-chrome", "dist-firefox", "coverage", ".venv", "__pycache__"]);

function globToRegExp(pattern) {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += "[^/]*";
			}
		} else {
			source += char.replace(/[\\^$.+?()[\]{}|]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

function hasWildcard(pattern) {
	return pattern.includes("*");
}

/** The literal directory prefix a glob pattern is anchored at (a "packages" + any-segment + "test" pattern -> "packages"). */
function literalPrefix(pattern) {
	const segments = pattern.split("/");
	const literal = [];
	for (const segment of segments) {
		if (segment.includes("*")) break;
		literal.push(segment);
	}
	return literal.join("/");
}

/** Walk a directory (skipping SKIPPED_DIR_NAMES) and push every file's repo-relative path. */
function walkFiles(root, dirRel, out) {
	const abs = dirRel ? join(root, dirRel) : root;
	let entries;
	try {
		entries = readdirSync(abs, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
			walkFiles(root, rel, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
}

/** Walk a directory WITHOUT the build-output skip: a literal directory input names the
 * tree it reads (dist included), so nothing under it is filtered. */
function walkAllFiles(root, dirRel, out) {
	const abs = dirRel ? join(root, dirRel) : root;
	let entries;
	try {
		entries = readdirSync(abs, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			walkAllFiles(root, rel, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
}

/** Expand every pattern to the sorted set of matched working-tree files. Literals stay in the
 * list even when missing (hashed as MISSING) so their later appearance changes the fingerprint. */
function expandInputs(root, patterns) {
	const files = [];
	for (const pattern of patterns) {
		if (!hasWildcard(pattern)) {
			files.push(pattern);
			continue;
		}
		const prefix = literalPrefix(pattern);
		if (!prefix) {
			// A pattern starting with "*" matches nothing anchored; treat as never-matching.
			continue;
		}
		const walked = [];
		walkFiles(root, prefix, walked);
		const regex = globToRegExp(pattern);
		for (const file of walked) {
			if (regex.test(file)) files.push(file);
		}
	}
	return [...new Set(files)].sort();
}

/** The fingerprint: one sha256 over the runtime prelude plus every input's path and bytes. */
function fingerprintInputs(root, patterns) {
	const hash = createHash("sha256");
	hash.update(`gate-cache v1\nnode ${process.version}\nplatform ${process.platform}\n`);
	hash.update(`patterns ${JSON.stringify([...patterns].sort())}\n`);
	for (const rel of expandInputs(root, patterns)) {
		hash.update(`file ${rel}\0`);
		try {
			const stats = statSync(join(root, rel));
			if (stats.isFile()) {
				hash.update(readFileSync(join(root, rel)));
			} else if (stats.isDirectory()) {
				// A literal directory input hashes its whole tree as one entry: the gate
				// named the tree it reads (a build output), so nothing inside is filtered.
				const tree = [];
				walkAllFiles(root, rel, tree);
				hash.update(`dir ${rel} (${tree.length} files)\0`);
				for (const file of tree) {
					hash.update(`file ${file}\0`);
					try {
						hash.update(readFileSync(join(root, file)));
					} catch {
						hash.update(`MISSING\n`);
					}
				}
			} else {
				hash.update(`not-a-file\n`);
			}
		} catch {
			hash.update(`MISSING\n`);
		}
	}
	return hash.digest("hex");
}

function readCache(cacheFile) {
	try {
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
		return parsed && typeof parsed === "object" && parsed.gates && typeof parsed.gates === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function writeCacheAtomic(cacheFile, data) {
	const temp = `${cacheFile}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(temp, cacheFile);
}

function recordEntry(cacheFile, gate, entry) {
	// Re-read right before the update: another gate in the same pipeline (or another lane's
	// process) may have written since this run started; last writer wins per gate, and a lost
	// update can only cost a re-run, never a wrong skip.
	const cache = readCache(cacheFile) ?? { gates: {} };
	cache.gates[gate] = entry;
	writeCacheAtomic(cacheFile, cache);
}

function envBypassed(env) {
	return env[BYPASS_ENV] === "0";
}

/**
 * Run (or skip) one gate. Returns { skipped, status } where status is the gate's exit code, or
 * null when the gate died to a signal. Prints the skip line through `log` (default console.log).
 */
function runGate({ gate, patterns, command, root = repoRoot, cacheFile = CACHE_FILE, force = false, log = console.log }) {
	const allPatterns = [...new Set([...patterns, ...IMPLICIT_INPUTS])];
	const digest = fingerprintInputs(root, allPatterns);

	if (!force && !envBypassed(process.env)) {
		const entry = readCache(cacheFile)?.gates?.[gate];
		if (entry && typeof entry === "object" && entry.fingerprint === digest && entry.status === "green") {
			log(`check-gate-cache: skipping ${gate} (inputs unchanged since last green at ${entry.at})`);
			return { skipped: true, status: 0 };
		}
	}

	const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit", cwd: root });
	const at = new Date().toISOString();
	if (result.error) {
		recordEntry(cacheFile, gate, { fingerprint: digest, status: `spawn-error:${result.error.code ?? "unknown"}`, at });
		console.error(`check-gate-cache: could not run ${gate}: ${result.error.message}`);
		return { skipped: false, status: 2 };
	}
	if (result.status === 0) {
		recordEntry(cacheFile, gate, { fingerprint: digest, status: "green", at });
	} else if (result.status === null) {
		recordEntry(cacheFile, gate, { fingerprint: digest, status: `signal:${result.signal ?? "unknown"}`, at });
	} else {
		recordEntry(cacheFile, gate, { fingerprint: digest, status: `red:${result.status}`, at });
	}
	return { skipped: false, status: result.status };
}

// ---------------------------------------------------------------------------
// self-test: fault injection - every way the cache could wrongly skip must go red
// ---------------------------------------------------------------------------

function selfTest() {
	const failures = [];
	const ok = (name) => console.log(`  ok   ${name}`);
	const fail = (name, detail) => {
		failures.push(name);
		console.error(`  FAIL ${name}: ${detail}`);
	};
	const expect = (name, condition, detail = "") => (condition ? ok(name) : fail(name, detail));

	const dir = mkdtempSync(join(tmpdir(), "prime-agent-gate-cache-selftest."));
	const cacheFile = join(dir, ".gates-cache.json");
	const counter = join(dir, "counter");
	const gateLog = [];
	const gate = (name) => runGate({
		gate: "demo",
		patterns: ["gate.sh", "notes.txt", "data/*.txt", "later.txt"],
		command: `printf run >> ${counter}; exit \${FAKE_EXIT:-0}`,
		root: dir,
		cacheFile,
		log: (line) => gateLog.push(line),
	});
	const runs = () => {
		try {
			return (readFileSync(counter, "utf8").match(/run/g) ?? []).length;
		} catch {
			return 0;
		}
	};
	writeFileSync(join(dir, "gate.sh"), "exit ${FAKE_EXIT:-0}\n", "utf8");
	writeFileSync(join(dir, "notes.txt"), "one\n", "utf8");
	mkdirSync(join(dir, "data"));
	writeFileSync(join(dir, "data/a.txt"), "alpha\n", "utf8");

	// (a) baseline: first run executes and records green.
	let outcome = gate("first");
	expect("a fresh gate runs and exits 0", outcome.status === 0 && !outcome.skipped && runs() === 1, `status=${outcome.status} runs=${runs()}`);
	expect("the green run is recorded", readCache(cacheFile)?.gates?.demo?.status === "green");

	// (d) unchanged inputs skip, and the skip line says which gate.
	gateLog.length = 0;
	outcome = gate("second");
	expect("d: unchanged inputs are skipped", outcome.skipped && outcome.status === 0 && runs() === 1, `skipped=${outcome.skipped} runs=${runs()}`);
	expect("d: the skip output names the gate", gateLog.some((line) => line.includes("skipping demo")), `log=${JSON.stringify(gateLog)}`);

	// (a) one byte of a declared input changes -> the gate must re-run.
	writeFileSync(join(dir, "notes.txt"), "one!\n", "utf8");
	outcome = gate("changed-input");
	expect("a: a one-byte input change forces a re-run", !outcome.skipped && runs() === 2, `skipped=${outcome.skipped} runs=${runs()}`);

	// (b) cache file deleted -> full run.
	rmSync(cacheFile);
	outcome = gate("deleted-cache");
	expect("b: a deleted cache file forces a full run", !outcome.skipped && runs() === 3, `runs=${runs()}`);

	// (a) a new file matching a glob input -> re-run.
	writeFileSync(join(dir, "data/b.txt"), "beta\n", "utf8");
	outcome = gate("glob-added");
	expect("a: a file newly matching a glob input forces a re-run", !outcome.skipped && runs() === 4, `runs=${runs()}`);

	// (a) a declared literal input that was missing appears -> re-run.
	writeFileSync(join(dir, "later.txt"), "now I exist\n", "utf8");
	outcome = gate("literal-appeared");
	expect("a: a missing input appearing later forces a re-run", !outcome.skipped && runs() === 5, `runs=${runs()}`);

	// (c) a red gate is never skipped afterwards: run it red (fresh cache so it executes),
	// then prove the unchanged next run does NOT skip.
	rmSync(cacheFile);
	process.env.FAKE_EXIT = "1";
	outcome = gate("red");
	delete process.env.FAKE_EXIT;
	expect("c: a red gate propagates its exit code", outcome.status === 1 && runs() === 6, `status=${outcome.status} runs=${runs()}`);
	expect("c: the red run is not recorded green", readCache(cacheFile)?.gates?.demo?.status !== "green");
	outcome = gate("after-red");
	expect("c: the gate after a red run is not skipped", !outcome.skipped && runs() === 7, `skipped=${outcome.skipped} runs=${runs()}`);

	// exit-code propagation for an arbitrary code.
	rmSync(cacheFile);
	process.env.FAKE_EXIT = "7";
	outcome = gate("exit7");
	delete process.env.FAKE_EXIT;
	expect("an arbitrary gate exit code propagates", outcome.status === 7 && runs() === 8, `status=${outcome.status} runs=${runs()}`);

	// a gate dying to a signal must not look green.
	rmSync(cacheFile);
	outcome = runGate({
		gate: "demo",
		patterns: ["gate.sh", "notes.txt", "data/*.txt", "later.txt"],
		command: "kill -TERM $$",
		root: dir,
		cacheFile,
		log: () => {},
	});
	expect("a signal death is not recorded green", readCache(cacheFile)?.gates?.demo?.status !== "green", `status=${readCache(cacheFile)?.gates?.demo?.status}`);
	outcome = gate("after-signal");
	expect("the gate after a signal death is not skipped", !outcome.skipped && runs() === 9, `runs=${runs()}`);

	// green after red restores skipping.
	gateLog.length = 0;
	outcome = gate("skip-restored");
	expect("the run after the restored green is skipped", outcome.skipped && runs() === 9 && gateLog.some((line) => line.includes("skipping demo")), `skipped=${outcome.skipped} runs=${runs()}`);

	// (b) a corrupt cache file -> full run.
	writeFileSync(cacheFile, "{not json", "utf8");
	outcome = gate("corrupt");
	expect("b: a corrupt cache file forces a full run", !outcome.skipped && runs() === 10, `runs=${runs()}`);

	// recovery: the bypass env var forces a run even on a fresh green hit.
	outcome = gate("fresh-green");
	expect("setup: the fresh cache is green again", outcome.skipped && runs() === 10, `skipped=${outcome.skipped}`);
	process.env[BYPASS_ENV] = "0";
	outcome = gate("bypassed");
	delete process.env[BYPASS_ENV];
	expect("recovery: the bypass env var forces the run", !outcome.skipped && runs() === 11, `runs=${runs()}`);
	outcome = gate("after-bypass");
	expect("after a bypassed run the cache still skips", outcome.skipped && runs() === 11, `runs=${runs()}`);

	// a red gate must not clobber a sibling gate's green entry.
	runGate({
		gate: "sibling",
		patterns: ["gate.sh"],
		command: "true",
		root: dir,
		cacheFile,
		log: () => {},
	});
	process.env.FAKE_EXIT = "1";
	gate("sibling-red");
	delete process.env.FAKE_EXIT;
	const sibling = readCache(cacheFile)?.gates?.sibling;
	expect("a red gate does not clobber a sibling's green entry", sibling?.status === "green", `sibling=${JSON.stringify(sibling)}`);

	// literal-directory inputs: the tree a gate explicitly names is hashed whole (dist
	// class), so a byte inside it, a new file under it, and its later appearance each
	// re-run the gate - while an unchanged tree still skips.
	const dirCounter = join(dir, "dir-counter");
	const dirRuns = () => {
		try {
			return (readFileSync(dirCounter, "utf8").match(/run/g) ?? []).length;
		} catch {
			return 0;
		}
	};
	const dirGate = () =>
		runGate({
			gate: "dir-demo",
			patterns: ["gate.sh", "out"],
			command: `printf run >> ${dirCounter}; exit 0`,
			root: dir,
			cacheFile,
			log: () => {},
		});
	mkdirSync(join(dir, "out"));
	writeFileSync(join(dir, "out/x.js"), "one\n", "utf8");
	let dirOutcome = dirGate();
	expect("a-dir: a fresh literal-dir gate runs and records green", dirOutcome.status === 0 && !dirOutcome.skipped && dirRuns() === 1, `status=${dirOutcome.status} runs=${dirRuns()}`);
	dirOutcome = dirGate();
	expect("d-dir: an unchanged literal-dir tree is skipped", dirOutcome.skipped && dirRuns() === 1, `skipped=${dirOutcome.skipped} runs=${dirRuns()}`);
	writeFileSync(join(dir, "out/x.js"), "two\n", "utf8");
	dirOutcome = dirGate();
	expect("a-dir: a byte inside the literal dir forces a re-run", !dirOutcome.skipped && dirRuns() === 2, `skipped=${dirOutcome.skipped} runs=${dirRuns()}`);
	writeFileSync(join(dir, "out/y.js"), "new\n", "utf8");
	dirOutcome = dirGate();
	expect("a-dir: a new file inside the literal dir forces a re-run", !dirOutcome.skipped && dirRuns() === 3, `skipped=${dirOutcome.skipped} runs=${dirRuns()}`);
	const absentGate = () =>
		runGate({
			gate: "absent-dir-demo",
			patterns: ["gate.sh", "notyet"],
			command: `printf run >> ${dirCounter}; exit 0`,
			root: dir,
			cacheFile,
			log: () => {},
		});
	absentGate();
	dirOutcome = absentGate();
	expect("d-dir: a still-missing literal dir skips (the MISSING marker is stable)", dirOutcome.skipped, `skipped=${dirOutcome.skipped}`);
	mkdirSync(join(dir, "notyet"));
	writeFileSync(join(dir, "notyet/z.txt"), "appeared\n", "utf8");
	dirOutcome = absentGate();
	expect("a-dir: a missing literal dir appearing later forces a re-run", !dirOutcome.skipped, `skipped=${dirOutcome.skipped}`);

	// the cache file stays parseable JSON after all those writes.
	let parseable = true;
	try {
		JSON.parse(readFileSync(cacheFile, "utf8"));
	} catch {
		parseable = false;
	}
	expect("the cache file is valid JSON after every write", parseable);

	rmSync(dir, { recursive: true, force: true });
	console.log(
		failures.length === 0
			? "check-gate-cache self-test: OK (every skip had to prove its evidence: change, absence, red, signal, corruption, bypass)"
			: `check-gate-cache self-test: RED (${failures.length} failing case(s): ${failures.join(", ")})`,
	);
	return failures.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	console.error("usage: node scripts/check-gate-cache.mjs [--no-cache] --gate <name> -- <command...>");
	console.error(`       node scripts/check-gate-cache.mjs --self-test`);
	console.error(`gates: ${Object.keys(GATES).join(", ")}`);
	console.error(`bypass skipping with ${BYPASS_ENV}=0 (or --no-cache)`);
}

function main(argv) {
	let gateName = "";
	let force = false;
	let wantSelfTest = false;
	let commandStart = -1;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (commandStart !== -1) break;
		if (arg === "--self-test") wantSelfTest = true;
		else if (arg === "--no-cache") force = true;
		else if (arg === "--gate") {
			if (i + 1 >= argv.length) {
				console.error("check-gate-cache: --gate needs a gate name");
				usage();
				return 2;
			}
			gateName = argv[i + 1];
			i++;
		} else if (arg === "--") {
			commandStart = i + 1;
		} else if (arg === "-h" || arg === "--help") {
			usage();
			return 0;
		} else {
			console.error(`check-gate-cache: unknown argument ${arg}`);
			usage();
			return 2;
		}
	}

	if (wantSelfTest) return selfTest();
	if (!gateName || !(gateName in GATES)) {
		console.error(`check-gate-cache: ${gateName ? `unknown gate "${gateName}"` : "no gate given"}; refusing to answer green without one`);
		usage();
		return 2;
	}
	const command = argv.slice(commandStart === -1 ? argv.length : commandStart).join(" ");
	if (!command) {
		console.error("check-gate-cache: no command after --");
		usage();
		return 2;
	}
	const outcome = runGate({ gate: gateName, patterns: GATES[gateName], command, force });
	return outcome.status ?? 2;
}

process.exit(main(process.argv.slice(2)));
