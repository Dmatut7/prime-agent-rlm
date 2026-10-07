#!/usr/bin/env node
/**
 * Display-truth reconciliation (显示层对账): recompute the change numbers a session's
 * turn-strip and footnote showed, from the session file itself, then check them against
 * what git and the filesystem actually say.
 *
 * Why this exists
 * ---------------
 * Wave-21 rule (FORK_NOTES.md, 2026-10-03): every number shown on screen gets
 * cross-checked against an external truth (`git diff --stat` / `wc -l` / `git status`)
 * at delivery time — "tested" is not "right on screen". The rule fired after the +23442
 * incident: a tracked file whose pre-edit content was never captured got displayed as
 * newly created, so the strip claimed +23442 added lines where the truth was +169/−14.
 * Until now the rule lived in the ledger only; this gate makes it runnable.
 *
 * What it reconciles
 * ------------------
 * The numbers come from the session file's toolResult records — the same records the
 * display layer reads (components/feed-data.ts → turn-strip.ts, timeline-rows.ts
 * countsMeta/changeTotals, turn-footnote.ts):
 *
 *   - ipython tool results: `details.fileChanges` (the kernel's own change records;
 *     the primary channel on the repl-kernel line),
 *   - edit tool results: `details.diff` (a numbered diff; counted exactly as
 *     parseNumberedDiff + countDiffRows count it in components/diff-rows.ts),
 *   - legacy edit-skill results: `details.diffs` old/new pairs (counted with an LCS
 *     line diff — the same length the `diff` package's Myers emits when it is minimal;
 *     huge inputs fall back to the multiset difference, the same fallback the Python
 *     kernel uses, and are marked approximate so their failures read as warnings).
 *
 * Aggregation mirrors aggregateChanges()/mergeKind() (one entry per path, counts summed
 * across edits, `created` survives a later modify, any later `deleted` wins) and the
 * strip's totals mirror changeTotals() (symlinks and omitted-with-zero-counts entries
 * carry no numbers). Per result, a present `fileChanges` array suppresses `diffs`, the
 * same precedence mergeStepResult/aggregateChanges use.
 *
 * Three classes are checked, per file and as headline totals:
 *
 *   1. 改了 N 个文件 — every claimed project file must leave a trace git can see
 *      (a numstat entry, the untracked listing, or absence for a delete); git changes
 *      the session never claimed are reported (warnings: the file may be hand-edited).
 *   2. +N/−N — the strip sums every edit's diff (cumulative) while git shows the net
 *      diff, so the sound order is `git ≤ displayed` per side; a git figure larger than
 *      the displayed one means the screen under-reported (hard fail). A file the strip
 *      called 新建 that already existed at --base is the +23442 shape (phantom-create).
 *   3. 文件行数 — a created file's current line count L (wc -l semantics under git's
 *      line definition: an unterminated last line still counts, matching the kernel's
 *      _line_total) must sit inside [A−R, A]; a deleted file's line count at --base
 *      must not exceed the displayed −R.
 *
 * Preconditions (the reconciliation is only sound when they hold)
 * ---------------------------------------------------------------
 *   - --base names the git state when the session started (default HEAD), and
 *   - since then nobody but this session wrote the claimed paths, and
 *   - the session did not move git state (commit/merge/rebase/reset/checkout/stash).
 *     The gate scans the session's shell/python commands for these and prints a hint
 *     to re-run with `--base <会话开始前的提交>`.
 *
 * Verdicts
 * --------
 * Hard failures (exit 1): phantom-create, ghost-create, ghost-delete, under-report,
 * line-count-interval, delete-count, totals-under-report. Warnings (exit 0, exit 1
 * under --strict): net-zero (change reverted or phantom), unclaimed-change (git shows
 * a change the session never recorded), untracked-modified (session said "modified",
 * git sees an untracked file — cumulative bounds do not apply), suspicious-whole-file-counts
 * (a single omitted-baseline record whose +N equals the file's whole length — the
 * pre-wave-21-fix shape), rename/symlink count skips, oversized/binary/unreadable files,
 * records whose counts the kernel itself could not know (diffOmitted), approximate
 * legacy counts.
 *
 * Deliberate non-goals
 * --------------------
 *   - Per-turn attribution: git holds one snapshot, so the gate reconciles the whole
 *     session (the sum of every turn's strip) against the current worktree.
 *   - Rename line counts (existence of the old/new paths only) and symlink targets.
 *   - Byte-level diff review: this gate checks the numbers, not the text.
 *   - npm run check / pre-push wiring: the gate needs a live session ↔ worktree pair,
 *     which a commit or push boundary does not provide; wiring it there would
 *     false-alarm every lane. It runs on demand, and its --self-test is CI-ready
 *     (node + git only, works in a throwaway directory, never touches the real repo
 *     or the real sessions directory).
 *
 * Usage
 * -----
 *   node scripts/check-display-reconciliation.mjs --latest [--cwd <dir>] [--base <ref>]
 *   node scripts/check-display-reconciliation.mjs --session <file.jsonl> [--cwd <dir>] [--base <ref>]
 *   node scripts/check-display-reconciliation.mjs --self-test
 *   flags: --strict (warnings fail) · --json · --sessions-dir <dir> · --help
 *
 * Exit codes: 0 = 对平 (warnings allowed), 1 = 对不上 (hard mismatch, or warnings under
 * --strict), 2 = usage error / cannot reconcile (not a git repo, bad base, no session).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = basename(fileURLToPath(import.meta.url));

/** Read caps: a file past this is reported, not line-counted. */
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** A NUL in the first bytes means binary (the kernel's _count_lines uses the same sniff). */
const BINARY_SNIFF_BYTES = 8192;
/** LCS diff inputs past this many combined lines use the multiset fallback instead. */
const LCS_LINE_CAP = 20_000;

const FILE_KINDS = new Set(["created", "modified", "deleted", "renamed"]);
const FILE_SCOPES = new Set(["project", "scratch", "memory"]);
const DIFF_OMITTED = new Set(["too_large", "no_baseline", "budget", "sensitive"]);
/** Shell/python commands that move git state and so invalidate the default --base. */
const GIT_STATE_COMMAND = /\bgit\s+(?:commit|merge|rebase|reset|checkout|stash)\b/;

class UsageError extends Error {}
/** Exit-2 failures: the gate itself cannot run (no repo, bad base, no session). */
class ReconcileError extends Error {}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- line counting (kernel _line_total parity) ----------

/**
 * Lines of a buffer the way the kernel counts them (prime-agent-runtime
 * effects.py `_line_total`): the number of newlines, plus one when the last
 * line is unterminated. This is also git's line definition for numstat, and
 * `wc -l` whenever the file ends with a newline.
 */
function lineTotal(data) {
	if (data.length === 0) return 0;
	let lines = 0;
	for (let index = 0; index < data.length; index += 1) {
		if (data[index] === 10) lines += 1;
	}
	return data[data.length - 1] === 10 ? lines : lines + 1;
}

// ---------- diff counting (display parity) ----------

/** The edit tool's numbered diff as add/del counts — parseNumberedDiff's matcher. */
const NUMBERED_LINE = /^([+\- ])\s*(\d+) (.*)$/;

function countNumberedDiff(diff) {
	let added = 0;
	let removed = 0;
	for (const raw of diff.split("\n")) {
		const match = NUMBERED_LINE.exec(raw);
		if (!match) continue;
		if (match[1] === "+") added += 1;
		else if (match[1] === "-") removed += 1;
	}
	return { added, removed };
}

/** Lines the way the `diff` package's diffLines splits them (trailing newline belongs to its line). */
function splitDiffLines(text) {
	if (text === "") return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** Shortest edit script length (insert+delete only) between two line arrays — Myers O(ND). */
function shortestEditLength(a, b) {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (max === 0) return 0;
	const offset = max;
	const v = new Int32Array(2 * max + 1);
	for (let d = 0; d <= max; d += 1) {
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset];
			else x = v[k - 1 + offset] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[k + offset] = x;
			if (x >= n && y >= m) return d;
		}
	}
	return max;
}

/** Order-free counts (the Python kernel's own fallback for oversized diffs). */
function multisetCounts(a, b) {
	const left = new Map();
	for (const line of a) left.set(line, (left.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of b) {
		const rest = left.get(line) ?? 0;
		if (rest > 0) left.set(line, rest - 1);
		else added += 1;
	}
	let removed = 0;
	for (const rest of left.values()) removed += rest;
	return { added, removed };
}

/**
 * Add/del counts of a legacy old/new edit-skill pair, as the display's
 * generateDiffString (a Myers line diff) would emit them. Exact when the LCS
 * fits the cap; the multiset fallback is marked approximate.
 */
function legacyCounts(oldStr, newStr, cap = LCS_LINE_CAP) {
	const a = splitDiffLines(oldStr);
	const b = splitDiffLines(newStr);
	if (a.length + b.length > cap) {
		return { ...multisetCounts(a, b), approximate: true };
	}
	const distance = shortestEditLength(a, b);
	const common = (a.length + b.length - distance) / 2;
	return { added: b.length - common, removed: a.length - common, approximate: false };
}

// ---------- session parsing ----------

/**
 * The session file as the gate needs it: the header cwd, every assistant
 * toolCall by id (the edit tool's path lives in the call, not the result),
 * every toolResult, plus honesty counters.
 */
function parseSessionText(text) {
	const calls = new Map();
	const results = [];
	let cwd;
	let malformed = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		if (!isRecord(entry)) {
			malformed += 1;
			continue;
		}
		if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
				calls.set(block.id, { name: block.name, arguments: isRecord(block.arguments) ? block.arguments : {} });
			}
		} else if (message.role === "toolResult") {
			results.push({
				toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
				toolName: typeof message.toolName === "string" ? message.toolName : "",
				isError: message.isError === true,
				details: isRecord(message.details) ? message.details : {},
			});
		}
	}
	return { cwd, calls, results, malformed };
}

function readKernelChange(value) {
	if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0) return undefined;
	if (!FILE_KINDS.has(value.kind)) return undefined;
	const change = {
		channel: "kernel",
		path: value.path,
		...(typeof value.relPath === "string" && value.relPath ? { relPath: value.relPath } : {}),
		kind: value.kind,
		scope: FILE_SCOPES.has(value.scope) ? value.scope : "project",
		added: Number.isInteger(value.added) && value.added > 0 ? value.added : 0,
		removed: Number.isInteger(value.removed) && value.removed > 0 ? value.removed : 0,
		symlink: value.symlink === true,
		binary: value.binary === true,
		...(typeof value.oldPath === "string" && value.oldPath ? { oldPath: value.oldPath } : {}),
	};
	// The kernel attributes workspace changes made by another window/process to
	// `ambient`: the strip renders them on their own line and never folds them
	// into the session's own counts.
	if (value.origin === "ambient") change.ambient = true;
	if (DIFF_OMITTED.has(value.diffOmitted)) change.omitted = value.diffOmitted;
	// The kernel says the counts were not knowable (no baseline, out of budget): 0/0 with a reason.
	if (change.omitted && change.added === 0 && change.removed === 0) change.countsUnknown = true;
	return change;
}

/**
 * Every change record a session's tool results carry, in order, with the
 * display layer's precedence: a present `fileChanges` array (even an empty
 * one) suppresses the same result's legacy `diffs`.
 */
function extractChanges(parsed) {
	const records = [];
	let trackingIncomplete = false;
	let gitStateSeen = false;
	const coverage = { toolResults: 0, kernel: 0, edit: 0, legacy: 0, malformedRecords: 0 };
	for (const call of parsed.calls.values()) {
		const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
		const code = typeof call.arguments.code === "string" ? call.arguments.code : "";
		if (GIT_STATE_COMMAND.test(command) || GIT_STATE_COMMAND.test(code)) gitStateSeen = true;
	}
	for (const result of parsed.results) {
		coverage.toolResults += 1;
		const details = result.details;
		if (typeof details.changeTrackingIncomplete === "string" && details.changeTrackingIncomplete.trim()) {
			trackingIncomplete = true;
		}
		if (Array.isArray(details.fileChanges)) {
			for (const raw of details.fileChanges) {
				const change = readKernelChange(raw);
				if (change) {
					records.push(change);
					coverage.kernel += 1;
				} else {
					coverage.malformedRecords += 1;
				}
			}
			continue;
		}
		if (Array.isArray(details.diffs)) {
			for (const raw of details.diffs) {
				if (!isRecord(raw) || typeof raw.path !== "string" || !raw.path) {
					coverage.malformedRecords += 1;
					continue;
				}
				if (raw.omitted === "sensitive") {
					records.push({
						channel: "legacy",
						path: raw.path,
						kind: "modified",
						scope: "project",
						added: 0,
						removed: 0,
						symlink: false,
						binary: false,
						omitted: "sensitive",
						countsUnknown: true,
					});
					coverage.legacy += 1;
					continue;
				}
				if (typeof raw.oldStr !== "string" || typeof raw.newStr !== "string") {
					coverage.malformedRecords += 1;
					continue;
				}
				const counts = legacyCounts(raw.oldStr, raw.newStr);
				records.push({
					channel: "legacy",
					path: raw.path,
					kind: "modified",
					scope: "project",
					added: counts.added,
					removed: counts.removed,
					symlink: false,
					binary: false,
					...(counts.approximate ? { approximate: true } : {}),
				});
				coverage.legacy += 1;
			}
		}
		if (result.toolName === "edit" && !result.isError && typeof details.diff === "string") {
			const call = parsed.calls.get(result.toolCallId);
			const path = call?.arguments.path ?? call?.arguments.file_path;
			if (typeof path === "string" && path) {
				const counts = countNumberedDiff(details.diff);
				records.push({
					channel: "edit",
					path,
					kind: "modified",
					scope: "project",
					added: counts.added,
					removed: counts.removed,
					symlink: false,
					binary: false,
				});
				coverage.edit += 1;
			}
		}
	}
	return { records, trackingIncomplete, gitStateSeen, coverage };
}

// ---------- aggregation (aggregateChanges / mergeKind parity) ----------

/** feed-data.ts mergeKind: any later delete wins; created survives a later modify. */
function mergeKind(first, next) {
	if (next === "deleted") return "deleted";
	if (first === "created") return "created";
	return next;
}

/** Best-effort realpath: the file itself, else its parent, else lexical. */
function realish(path) {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

function isInside(child, parent) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * One entry per path, counts summed across the session's edits — what every
 * turn's strip added up to. Legacy/edit records carry no scope: paths inside
 * the session cwd are project, the rest scratch (displayPath's rule).
 */
function aggregateRecords(records, sessionCwd) {
	const entries = new Map();
	const coverage = { scratch: 0, ambient: 0 };
	for (const record of records) {
		const abs = realish(resolve(sessionCwd, record.relPath ?? record.path));
		const scope = record.channel === "kernel" ? record.scope : isInside(abs, sessionCwd) ? "project" : "scratch";
		if (scope === "scratch") {
			coverage.scratch += 1;
			continue;
		}
		// Ambient changes (another window's edits, reported through this
		// session's kernel) are not part of the session's own displayed counts —
		// the strip renders them on a separate line. Skip them like scratch so
		// the "displayed" side mirrors the screen and cannot mask the session's
		// own under-reporting.
		if (record.ambient === true) {
			coverage.ambient += 1;
			continue;
		}
		const existing = entries.get(abs);
		if (!existing) {
			entries.set(abs, {
				absPath: abs,
				displayPath: isInside(abs, sessionCwd) ? relative(sessionCwd, abs) : abs,
				kind: record.kind,
				scope,
				added: record.added,
				removed: record.removed,
				symlink: record.symlink,
				binary: record.binary,
				...(record.omitted ? { omitted: record.omitted } : {}),
				...(record.oldPath ? { oldPath: record.oldPath } : {}),
				sawDeleted: record.kind === "deleted",
				countsUnknown: record.countsUnknown === true,
				approximate: record.approximate === true,
				recordCount: 1,
			});
			continue;
		}
		existing.added += record.added;
		existing.removed += record.removed;
		existing.kind = mergeKind(existing.kind, record.kind);
		existing.symlink ||= record.symlink;
		existing.binary ||= record.binary;
		existing.omitted ??= record.omitted;
		existing.oldPath ??= record.oldPath;
		existing.sawDeleted ||= record.kind === "deleted";
		existing.countsUnknown ||= record.countsUnknown === true;
		existing.approximate ||= record.approximate === true;
		existing.recordCount += 1;
	}
	return { entries: [...entries.values()], coverage };
}

/** The strip's totals (changeTotals): symlinks and omitted-with-zero-counts say nothing. */
function displayedTotals(entries) {
	const known = entries.filter((entry) => !entry.symlink && !(entry.omitted && entry.added === 0 && entry.removed === 0));
	if (known.length === 0) return undefined;
	return {
		added: known.reduce((sum, entry) => sum + entry.added, 0),
		removed: known.reduce((sum, entry) => sum + entry.removed, 0),
	};
}

/** The strip's headline, built with counts()'s rule (no `+0`, U+2212 minus). */
function headlineText(files, totals) {
	let text = `改了 ${files} 个文件`;
	if (totals) {
		if (totals.added > 0) text += ` +${totals.added}`;
		if (totals.removed > 0) text += ` −${totals.removed}`;
	}
	return text;
}

// ---------- git truth ----------

function git(args, cwd) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw new ReconcileError(`git 跑不起来：${result.error.message}`);
	if (result.status !== 0) {
		throw new ReconcileError(`git ${args.join(" ")} 失败：${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
	}
	return result.stdout;
}

/** Boolean git probe (existence questions): true when git exits 0. */
function gitOk(args, cwd) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0;
}

/** `git diff --numstat --no-renames -z <base> --` records: `A\tR\tpath\0`, `-\t-\t` for binary. */
function parseNumstat(text) {
	const map = new Map();
	let malformed = 0;
	for (const record of text.split("\0")) {
		if (!record) continue;
		const tab1 = record.indexOf("\t");
		const tab2 = record.indexOf("\t", tab1 + 1);
		if (tab1 <= 0 || tab2 <= tab1) {
			malformed += 1;
			continue;
		}
		const added = record.slice(0, tab1);
		const removed = record.slice(tab1 + 1, tab2);
		const path = record.slice(tab2 + 1);
		map.set(path, added === "-" || removed === "-" ? "binary" : { a: Number(added), b: Number(removed) });
	}
	return { map, malformed };
}

/**
 * The external truth: the repo root, the net per-file diff base→worktree
 * (staged + unstaged, renames split into delete+add), and the untracked set
 * (the `git status` half numstat cannot see, ignore rules applied).
 */
function gitTruth(cwd, base) {
	const repoRoot = realish(
		git(["rev-parse", "--show-toplevel"], cwd).trim(),
	);
	if (!gitOk(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repoRoot)) {
		throw new ReconcileError(`基准 "${base}" 不是这个仓库的提交——会话里提交过的话，--base 传会话开始前的提交`);
	}
	const numstat = parseNumstat(git(["diff", "--numstat", "--no-renames", "-z", base, "--"], repoRoot));
	const untracked = new Set(git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot).split("\0").filter(Boolean));
	return { repoRoot, numstat: numstat.map, numstatMalformed: numstat.malformed, untracked };
}

function worktreeLines(abs) {
	try {
		const stat = statSync(abs);
		if (!stat.isFile()) return undefined;
		if (stat.size > MAX_READ_BYTES) return undefined;
		const data = readFileSync(abs);
		if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
		return lineTotal(data);
	} catch {
		return undefined;
	}
}

function baseLines(repoRoot, base, rel) {
	try {
		const size = Number(git(["cat-file", "-s", `${base}:${rel}`], repoRoot).trim());
		if (!Number.isInteger(size) || size > MAX_READ_BYTES) return undefined;
		const data = execFileSync("git", ["show", `${base}:${rel}`], { cwd: repoRoot, maxBuffer: MAX_READ_BYTES + 1024 });
		if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
		return lineTotal(data);
	} catch {
		return undefined;
	}
}

/**
 * One claimed path's truth. `num` is the net diff (or "binary"); absent means
 * git sees no tracked change. atBase answers the phantom-create question.
 */
function collectEntryTruth(entry, truth, base) {
	const rel = relative(truth.repoRoot, entry.absPath);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { rel, outsideRepo: true };
	let existsWorktree = false;
	let isSymlinkNow = false;
	let isDirNow = false;
	try {
		const stat = lstatSync(entry.absPath);
		existsWorktree = true;
		isSymlinkNow = stat.isSymbolicLink();
		isDirNow = stat.isDirectory();
	} catch {
		// absent
	}
	const result = {
		rel,
		outsideRepo: false,
		existsWorktree,
		isSymlinkNow,
		isDirNow,
		num: truth.numstat.get(rel),
		untracked: truth.untracked.has(rel),
		atBase: gitOk(["cat-file", "-e", `${base}:${rel}`], truth.repoRoot),
	};
	if (existsWorktree && !isSymlinkNow && !isDirNow && (entry.kind === "created" || truth.untracked.has(rel) || (entry.kind === "modified" && entry.omitted))) {
		result.worktreeLines = worktreeLines(entry.absPath);
	}
	if (entry.kind === "deleted" && result.atBase) {
		result.baseLines = baseLines(truth.repoRoot, base, rel);
	}
	return result;
}

// ---------- verdicts ----------

/**
 * Judge one claimed entry against its truth. Pure. Hard codes say the screen
 * lied; warnings say the number could not be confirmed or has an innocent
 * reading. Count-derived checks degrade to warnings when some of the entry's
 * counts were unknowable (diffOmitted) or approximate (legacy fallback).
 */
function judgeEntry(entry, truth) {
	const verdicts = [];
	const fail = (code, message) => verdicts.push({ level: "fail", code, message });
	const warn = (code, message) => verdicts.push({ level: "warn", code, message });
	const info = (code, message) => verdicts.push({ level: "info", code, message });
	const countLevel = entry.countsUnknown || entry.approximate ? warn : fail;
	const shown = `显示 +${entry.added} −${entry.removed}`;

	if (truth.outsideRepo) {
		info("outside-repo", "在仓库外，git 管不着，只能信显示");
		return verdicts;
	}
	if (entry.kind === "renamed") {
		if (!truth.existsWorktree) warn("rename-new-missing", "改名后的文件现在不在工作区");
		info("rename-counts-skipped", "改名的行数这版不对（只核新旧路径的存在性）");
		return verdicts;
	}
	if (entry.symlink) {
		if (entry.kind === "deleted" ? truth.existsWorktree : !truth.existsWorktree) {
			warn("symlink-ghost", entry.kind === "deleted" ? "显示「删掉链接」，链接还在" : "显示改了链接，链接现在不在");
		}
		return verdicts;
	}

	// The display shows counts for this entry (changeTotals/countsMeta's rule).
	const countsDisplayed = !entry.binary && !(entry.omitted && entry.added === 0 && entry.removed === 0);

	let a = 0;
	let b = 0;
	let countsTruthKnown = true;
	if (truth.num === "binary") {
		countsTruthKnown = false;
		info("git-binary", "git 眼里是二进制文件，行数跳过");
	} else if (truth.num) {
		a = truth.num.a;
		b = truth.num.b;
	} else if (truth.untracked) {
		if (truth.worktreeLines === undefined) {
			countsTruthKnown = false;
			warn("unreadable-new", "新文件读不了、太大或像二进制，行数没核到");
		} else {
			a = truth.worktreeLines;
		}
	}
	const net = { a, b, known: countsTruthKnown };

	if (entry.kind === "created") {
		if (truth.atBase && !entry.sawDeleted) {
			fail(
				"phantom-create",
				`显示「新建」，但基准提交里这个文件已经在了——正是 wave-21 那个 +23442 的形状（存量行被报成新增）`,
			);
		}
		if (!truth.existsWorktree && !truth.num && !truth.untracked) {
			fail("ghost-create", "显示「新建」，但文件现在哪都找不到（工作区、暂存区都没有）");
		}
		if (countsDisplayed && net.known && (net.a > entry.added || net.b > entry.removed)) {
			countLevel("under-report", `git 实测 +${net.a} −${net.b}，${shown}——显示比真值小`);
		}
		if (countsDisplayed && truth.existsWorktree && truth.worktreeLines !== undefined) {
			const lines = truth.worktreeLines;
			if (!(entry.added - entry.removed <= lines && lines <= entry.added)) {
				countLevel(
					"line-count-interval",
					`新建文件现有 ${lines} 行（wc -l 口径），${shown}——行数不在 [${entry.added - entry.removed}, ${entry.added}] 区间`,
				);
			}
		}
		return verdicts;
	}

	if (entry.kind === "deleted") {
		if (truth.existsWorktree) {
			fail("ghost-delete", "显示「删除」，文件还在工作区");
		} else if (truth.atBase) {
			if (countsDisplayed && truth.baseLines !== undefined && entry.removed < truth.baseLines) {
				countLevel("delete-count", `显示 −${entry.removed}，但基准提交里这个文件有 ${truth.baseLines} 行`);
			}
		} else {
			info("created-and-deleted", "会话内建了删，git 无痕可核");
		}
		return verdicts;
	}

	// modified
	if (!truth.atBase && truth.untracked) {
		warn("untracked-modified", "显示「修改」，git 眼里是个新文件（可能是更早的会话建的）——累计边界不适用，只核了存在性");
		return verdicts;
	}
	if (entry.recordCount === 1 && entry.omitted && entry.removed === 0 && truth.worktreeLines !== undefined && entry.added >= truth.worktreeLines && entry.added > 0) {
		warn(
			"suspicious-whole-file-counts",
			`显示 +${entry.added}，和文件全长（现有 ${truth.worktreeLines} 行）一样多——wave-21 前「拿不到旧内容」的虚报形状，这条 +N 不可信`,
		);
	}
	if (!truth.num && !truth.untracked) {
		if (truth.existsWorktree) {
			warn("net-zero", "显示改了，git 看不到净差（改动被改回去了，或虚报）");
		} else {
			warn("modified-vanished", "显示「修改」，文件现在不在了，git 也没有它的记录");
		}
		return verdicts;
	}
	if (countsDisplayed && net.known && (net.a > entry.added || net.b > entry.removed)) {
		countLevel("under-report", `git 实测 +${net.a} −${net.b}，${shown}——显示比真值小`);
	}
	return verdicts;
}

// ---------- reconciliation ----------

/**
 * The whole reconciliation. Impure (reads the session file, runs git, reads
 * claimed files); returns the report object --json prints.
 */
function reconcileSession(options) {
	const text = readFileSync(options.sessionPath, "utf8");
	const parsed = parseSessionText(text);
	const sessionCwd = realish(options.cwd ?? parsed.cwd ?? "");
	if (!sessionCwd) throw new ReconcileError("会话头里没有 cwd，用 --cwd 指定项目目录");
	if (!existsSync(sessionCwd)) throw new ReconcileError(`项目目录不存在：${sessionCwd}`);
	const extracted = extractChanges(parsed);
	const aggregated = aggregateRecords(extracted.records, sessionCwd);
	const truth = gitTruth(sessionCwd, options.base);

	const entries = [];
	const failures = [];
	const warnings = [];
	const notes = [];
	const claimedRels = new Set();
	const gitTotals = { files: 0, added: 0, removed: 0 };
	const checkable = { gitAdded: 0, gitRemoved: 0, dispAdded: 0, dispRemoved: 0 };

	for (const entry of aggregated.entries) {
		const entryTruth = collectEntryTruth(entry, truth, options.base);
		if (!entryTruth.outsideRepo) claimedRels.add(entryTruth.rel);
		const verdicts = judgeEntry(entry, entryTruth);
		for (const verdict of verdicts) {
			const line = { path: entry.displayPath, ...verdict };
			if (verdict.level === "fail") failures.push(line);
			else if (verdict.level === "warn") warnings.push(line);
		}
		const net = entryTruth.num && entryTruth.num !== "binary" ? entryTruth.num : undefined;
		const gitA = net ? net.a : entryTruth.untracked && entryTruth.worktreeLines !== undefined ? entryTruth.worktreeLines : undefined;
		const gitB = net ? net.b : entryTruth.untracked ? 0 : undefined;
		if (gitA !== undefined && (gitA > 0 || (gitB ?? 0) > 0)) gitTotals.files += 1;
		if (gitA !== undefined) gitTotals.added += gitA;
		if (gitB !== undefined) gitTotals.removed += gitB;
		const countsDisplayed = !entry.binary && !(entry.omitted && entry.added === 0 && entry.removed === 0);
		if (countsDisplayed && !entry.countsUnknown && !entry.approximate && gitA !== undefined && gitB !== undefined) {
			checkable.gitAdded += gitA;
			checkable.gitRemoved += gitB;
			checkable.dispAdded += entry.added;
			checkable.dispRemoved += entry.removed;
		}
		entries.push({
			path: entry.displayPath,
			rel: entryTruth.rel,
			kind: entry.kind,
			claimed: { added: entry.added, removed: entry.removed },
			...(entry.countsUnknown || entry.approximate ? { countsDegraded: true } : {}),
			truth: {
				...(gitA !== undefined ? { added: gitA, removed: gitB } : {}),
				atBase: entryTruth.atBase === true,
				existsWorktree: entryTruth.existsWorktree === true,
				untracked: entryTruth.untracked === true,
			},
			verdicts,
		});
	}

	// The headline +N/−N over the fully checkable entries must cover git's net.
	if (checkable.gitAdded > checkable.dispAdded || checkable.gitRemoved > checkable.dispRemoved) {
		failures.push({
			path: "(totals)",
			level: "fail",
			code: "totals-under-report",
			message:
				`可全核的条目合计：git 实测 +${checkable.gitAdded} −${checkable.gitRemoved}，` +
				`显示 +${checkable.dispAdded} −${checkable.dispRemoved}——屏幕上的总数比真值小`,
		});
	}

	// The reverse direction of 改了 N 个文件: git changes the session never claimed.
	const prefix = relative(truth.repoRoot, sessionCwd);
	let unclaimedOutside = 0;
	for (const rel of [...truth.numstat.keys(), ...truth.untracked]) {
		if (claimedRels.has(rel)) continue;
		if (prefix && !rel.startsWith(prefix + sep)) {
			unclaimedOutside += 1;
			continue;
		}
		const num = truth.numstat.get(rel);
		const netFigure = num && num !== "binary" ? ` +${num.a} −${num.b}` : truth.untracked.has(rel) ? "（新文件）" : "";
		warnings.push({
			path: rel,
			level: "warn",
			code: "unclaimed-change",
			global: true,
			message: `git 显示这个文件有改动${netFigure}，会话没记——手工改的、别的会话改的，或内核漏记`,
		});
	}

	if (truth.numstatMalformed > 0) {
		warnings.push({
			path: "(git)",
			level: "warn",
			code: "numstat-malformed",
			global: true,
			message: `git numstat 有 ${truth.numstatMalformed} 条记录没解析出来——真值可能少算了`,
		});
	}
	if (parsed.malformed > 0) {
		warnings.push({
			path: "(session)",
			level: "warn",
			code: "session-malformed-lines",
			global: true,
			message: `会话文件有 ${parsed.malformed} 行没解析出来——显示侧可能少算了`,
		});
	}
	if (extracted.coverage.malformedRecords > 0) {
		warnings.push({
			path: "(session)",
			level: "warn",
			code: "session-malformed-records",
			global: true,
			message: `${extracted.coverage.malformedRecords} 条改动记录形状不对，被跳过——显示侧可能少算了`,
		});
	}
	if (extracted.trackingIncomplete) {
		notes.push("内核自己标了「有些改动没记全」（changeTrackingIncomplete）：git 比显示多出的改动未必是漏记 bug");
	}
	if (extracted.gitStateSeen) {
		notes.push("会话里出现过 git commit/merge/rebase/reset/checkout/stash：HEAD 可能已移动，对不上时用 --base <会话开始前的提交> 再对");
	}
	if (aggregated.entries.length === 0) {
		notes.push("会话没有任何项目改动记录（改了 0 个文件）——无可对账");
	}
	if (unclaimedOutside > 0) {
		notes.push(`另有 ${unclaimedOutside} 个 git 改动在会话目录之外，不算未对账`);
	}

	const totals = displayedTotals(aggregated.entries);
	const headline = headlineText(aggregated.entries.length, totals);
	const ok = failures.length === 0 && (!options.strict || warnings.length === 0);
	return {
		ok,
		session: options.sessionPath,
		cwd: sessionCwd,
		base: options.base,
		repoRoot: truth.repoRoot,
		strict: options.strict === true,
		displayed: { files: aggregated.entries.length, ...(totals ?? { added: 0, removed: 0 }), headline },
		git: gitTotals,
		checkable,
		entries,
		failures,
		warnings,
		notes,
		coverage: { ...extracted.coverage, ...aggregated.coverage, malformedLines: parsed.malformed },
	};
}

// ---------- rendering ----------

function figure(added, removed) {
	const parts = [];
	if (added > 0) parts.push(`+${added}`);
	if (removed > 0) parts.push(`−${removed}`);
	return parts.length > 0 ? parts.join(" ") : "±0";
}

function renderText(report) {
	const lines = [];
	lines.push(`对账 ${report.session}`);
	lines.push(`基准 ${report.base} · 项目 ${report.cwd}`);
	lines.push(`显示：${report.displayed.headline}`);
	lines.push(
		`git 实测（会话声称的文件中）：${report.git.files} 个仍有净差 ${figure(report.git.added, report.git.removed)}` +
			` · 可全核合计 git ${figure(report.checkable.gitAdded, report.checkable.gitRemoved)} vs 显示 ${figure(report.checkable.dispAdded, report.checkable.dispRemoved)}`,
	);
	lines.push(
		`覆盖：kernel ${report.coverage.kernel} 条 · edit ${report.coverage.edit} 条 · legacy ${report.coverage.legacy} 条` +
			` · scratch ${report.coverage.scratch} 条（不进显示数） · ambient ${report.coverage.ambient} 条（别的窗口的改动，不进显示数） · 坏行 ${report.coverage.malformedLines}`,
	);
	for (const entry of report.entries) {
		const marks = { fail: "✗", warn: "!", info: "·" };
		if (entry.verdicts.length === 0) {
			const truth = entry.truth.added !== undefined ? `git ${figure(entry.truth.added, entry.truth.removed)}` : "git 无净差";
			lines.push(`  ✓ ${entry.path}  显示 ${figure(entry.claimed.added, entry.claimed.removed)} · ${truth}`);
			continue;
		}
		// Fail verdicts are listed in the 不符 section below, not duplicated here.
		for (const verdict of entry.verdicts.filter((item) => item.level !== "fail")) {
			lines.push(`  ${marks[verdict.level]} ${entry.path} [${verdict.code}] ${verdict.message}`);
		}
		if (entry.verdicts.some((item) => item.level === "fail")) {
			lines.push(`  ✗ ${entry.path}（见下方不符）`);
		}
	}
	const globalWarnings = report.warnings.filter((item) => item.global === true);
	if (globalWarnings.length > 0) {
		lines.push("警告：");
		for (const warning of globalWarnings) {
			lines.push(`  ! ${warning.path} [${warning.code}] ${warning.message}`);
		}
	}
	for (const note of report.notes) lines.push(`提示：${note}`);
	if (report.failures.length > 0) {
		lines.push(`不符 ${report.failures.length} 处：`);
		for (const failure of report.failures) lines.push(`  ✗ ${failure.path} [${failure.code}] ${failure.message}`);
	}
	const warningCount = report.warnings.length;
	lines.push(
		report.ok
			? `结论：对平（${warningCount} 个警告）`
			: `结论：对不上——${report.failures.length} 处不符、${warningCount} 个警告${report.strict ? "（--strict 下警告也算不符）" : ""}`,
	);
	return lines.join("\n");
}

// ---------- CLI ----------

function defaultSessionsDir() {
	const env = process.env;
	const override = env.PRIME_AGENT_SESSION_DIR ?? env.PRIME_AGENT_CODING_AGENT_SESSION_DIR;
	if (override) return override;
	const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime/agent");
	return join(agentDir, "sessions");
}

/** The newest session file whose header cwd is this project directory. */
function findLatestSession(cwd, sessionsDir) {
	if (!existsSync(sessionsDir)) {
		throw new ReconcileError(`会话目录不存在：${sessionsDir}（--sessions-dir 可以指定别处）`);
	}
	const wanted = realish(cwd);
	let best;
	for (const file of readdirSync(sessionsDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(sessionsDir, file);
		let header;
		try {
			header = JSON.parse(readHead(path));
		} catch {
			continue;
		}
		if (header?.type !== "session" || typeof header.cwd !== "string") continue;
		if (realish(header.cwd) !== wanted) continue;
		const mtime = statSync(path).mtimeMs;
		if (!best || mtime > best.mtime) best = { path, mtime };
	}
	if (!best) throw new ReconcileError(`找不到 cwd 为 ${wanted} 的会话文件（在 ${sessionsDir} 里）`);
	return best.path;
}

/** The first line of a (possibly huge) session file, read through a bounded buffer. */
function readHead(path) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(8192);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, read).split("\n", 1)[0];
	} finally {
		closeSync(fd);
	}
}

function parseArgs(argv) {
	const options = { base: "HEAD", strict: false, json: false, selfTest: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--self-test") options.selfTest = true;
		else if (arg === "--strict") options.strict = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--latest") options.latest = true;
		else if (arg === "--session") options.session = argv[++index];
		else if (arg === "--cwd") options.cwd = argv[++index];
		else if (arg === "--base") options.base = argv[++index];
		else if (arg === "--sessions-dir") options.sessionsDir = argv[++index];
		else throw new UsageError(`不认识的参数：${arg}`);
	}
	return options;
}

const USAGE = `用法：
  node scripts/${SCRIPT} --latest [--cwd <目录>] [--base <引用>]   对该项目最新一场会话对账
  node scripts/${SCRIPT} --session <会话.jsonl> [--cwd <目录>] [--base <引用>]
  node scripts/${SCRIPT} --self-test                               自控（种红必须红）
  其他：--strict 警告也算不符 · --json 机器可读报告 · --sessions-dir <目录>
退出码：0 对平 · 1 对不上 · 2 没法对（用法错/不是 git 仓库/基准不存在/找不到会话）
完整说明见文件头注释。`;

function main(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	if (options.selfTest) return runSelfTest();
	if (options.latest && options.session) throw new UsageError("--latest 和 --session 只能选一个");
	const cwd = options.cwd ? resolve(options.cwd) : undefined;
	let sessionPath = options.session ? resolve(options.session) : undefined;
	if (!sessionPath) {
		const scanCwd = cwd ?? process.cwd();
		sessionPath = findLatestSession(scanCwd, options.sessionsDir ?? defaultSessionsDir());
	}
	if (!existsSync(sessionPath)) throw new ReconcileError(`会话文件不存在：${sessionPath}`);
	const report = reconcileSession({ sessionPath, cwd, base: options.base ?? "HEAD", strict: options.strict });
	if (options.json) console.log(JSON.stringify(report, null, 2));
	else console.log(renderText(report));
	return report.ok ? 0 : 1;
}

// ---------- self-test ----------
// Stage A: pure controls (counting, parsing, aggregation, judging). Stage B:
// end-to-end in a throwaway git repository — planted green and red sessions.
// The point is anti-false-green: a parser that silently stops matching, or a
// verdict that stops firing, must turn this self-test red.

function selfTestFail(failures, name, detail) {
	failures.push(`self-test "${name}": ${detail}`);
}

function expectEqual(failures, name, actual, expected) {
	if (actual !== expected) selfTestFail(failures, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectTrue(failures, name, condition, detail) {
	if (!condition) selfTestFail(failures, name, detail ?? "expected true");
}

/** Minimal session file text: a header plus the given message payloads. */
function sessionText(cwd, messages) {
	return [
		JSON.stringify({ type: "session", version: 3, id: "self-test", timestamp: "2026-10-03T00:00:00.000Z", cwd }),
		...messages.map((message) => JSON.stringify({ type: "message", timestamp: "2026-10-03T00:00:01.000Z", message })),
		"",
	].join("\n");
}

function kernelResult(fileChanges, extraDetails = {}) {
	return { role: "toolResult", toolCallId: "k1", toolName: "ipython", content: [], details: { status: "ok", ...extraDetails, fileChanges } };
}

function editCallAndResult(id, path, diff) {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }] },
		{ role: "toolResult", toolCallId: id, toolName: "edit", content: [], isError: false, details: { diff } },
	];
}

function stageA(failures) {
	// lineTotal: kernel _line_total parity, including the unterminated last line.
	expectEqual(failures, "lineTotal empty", lineTotal(Buffer.from("")), 0);
	expectEqual(failures, "lineTotal terminated", lineTotal(Buffer.from("a\n")), 1);
	expectEqual(failures, "lineTotal unterminated", lineTotal(Buffer.from("a\nb")), 2);
	expectEqual(failures, "lineTotal single", lineTotal(Buffer.from("a")), 1);

	// countNumberedDiff: the display's matcher, gap/context lines ignored.
	const numbered = "+ 1 added line\n- 2 removed line\n  3 context\n   ...\nno-line-number +x\n";
	expectEqual(failures, "numberedDiff added", countNumberedDiff(numbered).added, 1);
	expectEqual(failures, "numberedDiff removed", countNumberedDiff(numbered).removed, 1);

	// legacyCounts: LCS exactness on small inputs, multiset fallback past the cap.
	expectEqual(failures, "legacy replace", legacyCounts("a\nb\nc\n", "a\nx\nc\n").added, 1);
	expectEqual(failures, "legacy replace removed", legacyCounts("a\nb\nc\n", "a\nx\nc\n").removed, 1);
	expectEqual(failures, "legacy from empty", legacyCounts("", "a\nb\n").added, 2);
	expectEqual(failures, "legacy identical", legacyCounts("a\n", "a\n").added, 0);
	const huge = legacyCounts(Array.from({ length: 30 }, (_, i) => `o${i}`).join("\n"), Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n"), 10);
	expectTrue(failures, "legacy fallback marked approximate", huge.approximate === true);
	expectEqual(failures, "legacy fallback counts", huge.added, 30);

	// parseSessionText: header cwd, toolCall join table, malformed lines counted.
	const parsed = parseSessionText(
		`${sessionText("/p", [...editCallAndResult("e1", "a.ts", "+ 1 x\n")])}not json\n`,
	);
	expectEqual(failures, "parse cwd", parsed.cwd, "/p");
	expectEqual(failures, "parse malformed", parsed.malformed, 1);
	expectEqual(failures, "parse call join", parsed.calls.get("e1")?.arguments.path, "a.ts");

	// extractChanges precedence: a present fileChanges array suppresses the same
	// result's legacy diffs (feed-data/aggregateChanges parity), empty included.
	const suppressed = extractChanges(
		parseSessionText(
			sessionText("/p", [
				{ role: "toolResult", toolCallId: "s1", toolName: "ipython", content: [], details: { fileChanges: [], diffs: [{ path: "a.ts", oldStr: "x", newStr: "y" }] } },
			]),
		),
	);
	expectEqual(failures, "fileChanges suppresses diffs", suppressed.records.length, 0);
	const kernelFirst = extractChanges(
		parseSessionText(
			sessionText("/p", [
				{
					role: "toolResult",
					toolCallId: "s2",
					toolName: "ipython",
					content: [],
					details: {
						fileChanges: [{ path: "/p/a.ts", kind: "modified", scope: "project", added: 3, removed: 1, source: "edit", at: 1 }],
						diffs: [{ path: "b.ts", oldStr: "x", newStr: "y" }],
					},
				},
			]),
		),
	);
	expectEqual(failures, "kernel records win", kernelFirst.records.length, 1);
	expectEqual(failures, "kernel records win path", kernelFirst.records[0]?.path, "/p/a.ts");

	// trackingIncomplete + git-state command detection.
	const flags = extractChanges(
		parseSessionText(
			sessionText("/p", [
				{ role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "git commit -m wip" } }] },
				kernelResult([], { changeTrackingIncomplete: "扫描预算用完了" }),
			]),
		),
	);
	expectTrue(failures, "trackingIncomplete seen", flags.trackingIncomplete === true);
	expectTrue(failures, "git commit seen", flags.gitStateSeen === true);

	// readKernelChange validation: bad kind dropped, omitted-0/0 marked unknown.
	const malformed = extractChanges(
		parseSessionText(
			sessionText("/p", [
				kernelResult([
					{ path: "/p/a.ts", kind: "nonsense", scope: "project", added: 1, removed: 0 },
					{ path: "/p/b.ts", kind: "modified", scope: "project", added: 0, removed: 0, diffOmitted: "no_baseline" },
				]),
			]),
		),
	);
	expectEqual(failures, "malformed record counted", malformed.coverage.malformedRecords, 1);
	expectEqual(failures, "omitted-0/0 unknown", malformed.records[0]?.countsUnknown, true);

	// Aggregation: counts sum, mergeKind, scratch excluded from the headline,
	// totals skip symlink and omitted-0/0 (changeTotals parity).
	const aggregated = aggregateRecords(
		[
			{ channel: "kernel", path: "/p/a.ts", kind: "created", scope: "project", added: 5, removed: 0, symlink: false, binary: false },
			{ channel: "kernel", path: "/p/a.ts", kind: "modified", scope: "project", added: 2, removed: 1, symlink: false, binary: false },
			{ channel: "kernel", path: "/p/b.ts", kind: "modified", scope: "project", added: 1, removed: 1, symlink: false, binary: false },
			{ channel: "kernel", path: "/p/b.ts", kind: "deleted", scope: "project", added: 0, removed: 4, symlink: false, binary: false },
			{ channel: "kernel", path: "/tmp/x", kind: "created", scope: "scratch", added: 9, removed: 0, symlink: false, binary: false },
			{ channel: "kernel", path: "/p/l", kind: "created", scope: "project", added: 0, removed: 0, symlink: true, binary: false },
		],
		"/p",
	);
	const byAbs = new Map(aggregated.entries.map((entry) => [entry.absPath, entry]));
	expectEqual(failures, "aggregate sums", byAbs.get("/p/a.ts")?.added, 7);
	expectEqual(failures, "created survives modify", byAbs.get("/p/a.ts")?.kind, "created");
	expectEqual(failures, "later delete wins", byAbs.get("/p/b.ts")?.kind, "deleted");
	expectTrue(failures, "scratch excluded", byAbs.get(realish("/tmp/x")) === undefined);
	expectEqual(failures, "scratch counted", aggregated.coverage.scratch, 1);
	const totals = displayedTotals(aggregated.entries);
	expectEqual(failures, "totals skip symlink", totals?.added, 8);
	expectEqual(failures, "totals skip symlink removed", totals?.removed, 6);
	expectEqual(failures, "headline", headlineText(aggregated.entries.length, totals), "改了 3 个文件 +8 −6");
	expectEqual(failures, "headline no +0", headlineText(1, { added: 0, removed: 2 }), "改了 1 个文件 −2");

	// Ambient records stay out of the session's own counts, exactly like the
	// strip renders them (own counts on one line, ambient on its own).
	const ambientRead = extractChanges(
		parseSessionText(
			sessionText("/p", [
				kernelResult([
					{ path: "/p/own.ts", kind: "modified", scope: "project", added: 5, removed: 2 },
					{ path: "/p/other-window.ts", kind: "modified", scope: "project", added: 500, removed: 400, origin: "ambient" },
				]),
			]),
		),
	);
	const ambientAggregated = aggregateRecords(ambientRead.records, "/p");
	expectEqual(failures, "ambient excluded from entries", ambientAggregated.entries.length, 1);
	expectEqual(failures, "ambient counted", ambientAggregated.coverage.ambient, 1);
	const ambientTotals = displayedTotals(ambientAggregated.entries);
	expectEqual(failures, "ambient stays out of totals", ambientTotals?.added, 5);
	expectEqual(failures, "ambient stays out of totals removed", ambientTotals?.removed, 2);

	// judgeEntry: one control per verdict code, fabricated truth, no git needed.
	const judgeCases = [
		["phantom-create fires", { kind: "created", added: 100, removed: 0 }, { atBase: true, existsWorktree: true, num: { a: 3, b: 1 } }, "fail", "phantom-create"],
		["phantom-create spared after delete", { kind: "created", added: 100, removed: 0, sawDeleted: true }, { atBase: true, existsWorktree: true, num: { a: 3, b: 1 } }, null, "phantom-create"],
		["ghost-create fires", { kind: "created", added: 5, removed: 0 }, { atBase: false, existsWorktree: false, untracked: false }, "fail", "ghost-create"],
		["under-report fires", { kind: "modified", added: 1, removed: 0 }, { atBase: true, existsWorktree: true, num: { a: 5, b: 0 } }, "fail", "under-report"],
		["under-report degrades when unknown", { kind: "modified", added: 1, removed: 0, countsUnknown: true }, { atBase: true, existsWorktree: true, num: { a: 5, b: 0 } }, "warn", "under-report"],
		["cumulative over net is fine", { kind: "modified", added: 10, removed: 8 }, { atBase: true, existsWorktree: true, num: { a: 3, b: 1 } }, null, "under-report"],
		["interval fires", { kind: "created", added: 7, removed: 0 }, { atBase: false, existsWorktree: true, untracked: true, worktreeLines: 5 }, "fail", "line-count-interval"],
		["interval holds", { kind: "created", added: 7, removed: 2 }, { atBase: false, existsWorktree: true, untracked: true, worktreeLines: 5 }, null, "line-count-interval"],
		["delete-count fires", { kind: "deleted", added: 0, removed: 1 }, { atBase: true, existsWorktree: false, num: { a: 0, b: 3 }, baseLines: 3 }, "fail", "delete-count"],
		["ghost-delete fires", { kind: "deleted", added: 0, removed: 3 }, { atBase: true, existsWorktree: true }, "fail", "ghost-delete"],
		["created+deleted is informational", { kind: "deleted", added: 4, removed: 4 }, { atBase: false, existsWorktree: false }, "info", "created-and-deleted"],
		["net-zero warns", { kind: "modified", added: 2, removed: 2 }, { atBase: true, existsWorktree: true }, "warn", "net-zero"],
		["untracked-modified warns", { kind: "modified", added: 2, removed: 1 }, { atBase: false, existsWorktree: true, untracked: true, worktreeLines: 40 }, "warn", "untracked-modified"],
		["whole-file counts warn", { kind: "modified", added: 23442, removed: 0, omitted: "too_large", recordCount: 1 }, { atBase: true, existsWorktree: true, num: { a: 169, b: 14 }, worktreeLines: 23440 }, "warn", "suspicious-whole-file-counts"],
		["whole-file counts spared on partial", { kind: "modified", added: 100, removed: 0, omitted: "too_large", recordCount: 1 }, { atBase: true, existsWorktree: true, num: { a: 60, b: 3 }, worktreeLines: 23440 }, null, "suspicious-whole-file-counts"],
		["renamed skips counts", { kind: "renamed", added: 9, removed: 9 }, { existsWorktree: true }, "info", "rename-counts-skipped"],
		["symlink ghost warns", { kind: "deleted", symlink: true, added: 0, removed: 0 }, { existsWorktree: true }, "warn", "symlink-ghost"],
		["outside repo is informational", { kind: "modified", added: 1, removed: 1 }, { outsideRepo: true }, "info", "outside-repo"],
	];
	for (const [name, entryPatch, truthPatch, level, code] of judgeCases) {
		const entry = {
			absPath: "/p/x.ts",
			displayPath: "x.ts",
			kind: "modified",
			added: 0,
			removed: 0,
			symlink: false,
			binary: false,
			sawDeleted: false,
			countsUnknown: false,
			approximate: false,
			...entryPatch,
		};
		const truth = { rel: "x.ts", atBase: false, existsWorktree: false, untracked: false, ...truthPatch };
		const hits = judgeEntry(entry, truth).filter((verdict) => verdict.code === code);
		if (level === null) {
			expectEqual(failures, name, hits.length, 0);
		} else {
			expectEqual(failures, name, hits[0]?.level, level);
		}
	}
}

/** A throwaway git repository plus a session file, ready for reconcileSession. */
function makeFixture(failures, name, build) {
	const root = mkdtempSync(join(tmpdir(), `display-reconcile-${name}-`));
	try {
		const gitq = (args) => {
			const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
			return result.stdout;
		};
		gitq(["init", "-q", "-b", "main"]);
		gitq(["config", "user.email", "self-test@example.com"]);
		gitq(["config", "user.name", "display-reconcile-self-test"]);
		return build({ root, gitq });
	} catch (error) {
		selfTestFail(failures, name, `fixture build failed: ${error.message}`);
		return undefined;
	}
}

function stageB(failures) {
	// The standard fixture: base commit holds tracked.txt (4 lines) and doomed.txt
	// (3 lines); the "session" then edits tracked.txt (+2/−1 net), creates new.txt
	// (5 lines), deletes doomed.txt, and leaves one unclaimed change behind.
	const standard = (mutate) =>
		makeFixture(failures, "std", ({ root, gitq }) => {
			writeFileSync(join(root, "tracked.txt"), "one\ntwo\nthree\nfour\n");
			writeFileSync(join(root, "doomed.txt"), "x\ny\nz\n");
			gitq(["add", "-A"]);
			gitq(["commit", "-qm", "base"]);
			writeFileSync(join(root, "tracked.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
			writeFileSync(join(root, "new.txt"), "n1\nn2\nn3\nn4\nn5\n");
			rmSync(join(root, "doomed.txt"));
			writeFileSync(join(root, "hand-edited.txt"), "not the session\n");
			const claims = mutate?.(root) ?? [
				{ path: join(root, "tracked.txt"), kind: "modified", scope: "project", added: 3, removed: 1, source: "edit", at: 1 },
				{ path: join(root, "new.txt"), kind: "created", scope: "project", added: 5, removed: 0, source: "python", at: 2 },
				{ path: join(root, "doomed.txt"), kind: "deleted", scope: "project", added: 0, removed: 3, source: "shell", at: 3 },
				{ path: "/tmp/scratch-note.md", kind: "created", scope: "scratch", added: 2, removed: 0, source: "python", at: 4 },
			];
			const session = join(root, "session.jsonl");
			writeFileSync(session, sessionText(root, [kernelResult(claims)]));
			return { root, session };
		});

	const run = (fixture, extra = {}) =>
		reconcileSession({ sessionPath: fixture.session, cwd: fixture.root, base: "HEAD", ...extra });

	// Green: honest claims reconcile; the unclaimed hand edit is a warning, not a failure.
	const green = standard();
	if (green) {
		const report = run(green);
		expectTrue(failures, "e2e green ok", report.ok === true, JSON.stringify(report.failures));
		expectEqual(failures, "e2e green headline", report.displayed.headline, "改了 3 个文件 +8 −4");
		expectEqual(failures, "e2e green failures", report.failures.length, 0);
		expectTrue(
			failures,
			"e2e green unclaimed warning",
			report.warnings.some((warning) => warning.code === "unclaimed-change" && warning.path === "hand-edited.txt"),
			JSON.stringify(report.warnings),
		);
		expectEqual(failures, "e2e green git totals", report.git.added, 8);
		expectEqual(failures, "e2e green git removed", report.git.removed, 4);
		expectEqual(failures, "e2e green scratch", report.coverage.scratch, 1);
		const doomed = report.entries.find((entry) => entry.path === "doomed.txt");
		expectEqual(failures, "e2e deleted base lines", doomed?.truth.removed, 3);
		rmSync(green.root, { recursive: true, force: true });
	}

	// Strict: the same fixture fails on the unclaimed warning.
	const strict = standard();
	if (strict) {
		const report = run(strict, { strict: true });
		expectTrue(failures, "e2e strict fails on warnings", report.ok === false);
		rmSync(strict.root, { recursive: true, force: true });
	}

	// Red: the +23442 shape — a tracked file claimed as created.
	const phantom = standard((root) => [
		{ path: join(root, "tracked.txt"), kind: "created", scope: "project", added: 6, removed: 0, source: "python", at: 1 },
	]);
	if (phantom) {
		const report = run(phantom);
		expectTrue(
			failures,
			"e2e phantom-create red",
			report.failures.some((failure) => failure.code === "phantom-create"),
			JSON.stringify(report.failures),
		);
		expectTrue(failures, "e2e phantom-create not ok", report.ok === false);
		rmSync(phantom.root, { recursive: true, force: true });
	}

	// Red: the screen said less than the truth.
	const under = standard((root) => [
		{ path: join(root, "tracked.txt"), kind: "modified", scope: "project", added: 1, removed: 0, source: "edit", at: 1 },
	]);
	if (under) {
		const report = run(under);
		expectTrue(
			failures,
			"e2e under-report red",
			report.failures.some((failure) => failure.code === "under-report" && failure.path === "tracked.txt"),
			JSON.stringify(report.failures),
		);
		rmSync(under.root, { recursive: true, force: true });
	}

	// Red: a created file whose displayed counts cannot contain its real length.
	const interval = standard((root) => [
		{ path: join(root, "new.txt"), kind: "created", scope: "project", added: 7, removed: 0, source: "python", at: 1 },
	]);
	if (interval) {
		const report = run(interval);
		expectTrue(
			failures,
			"e2e line-count-interval red",
			report.failures.some((failure) => failure.code === "line-count-interval"),
			JSON.stringify(report.failures),
		);
		rmSync(interval.root, { recursive: true, force: true });
	}

	// Red: a creation that left no trace anywhere.
	const ghost = standard((root) => [
		{ path: join(root, "nothere.txt"), kind: "created", scope: "project", added: 3, removed: 0, source: "python", at: 1 },
	]);
	if (ghost) {
		const report = run(ghost);
		expectTrue(
			failures,
			"e2e ghost-create red",
			report.failures.some((failure) => failure.code === "ghost-create"),
			JSON.stringify(report.failures),
		);
		rmSync(ghost.root, { recursive: true, force: true });
	}

	// Red: a delete the worktree disproves.
	const undead = standard((root) => [
		{ path: join(root, "tracked.txt"), kind: "deleted", scope: "project", added: 0, removed: 6, source: "shell", at: 1 },
	]);
	if (undead) {
		const report = run(undead);
		expectTrue(
			failures,
			"e2e ghost-delete red",
			report.failures.some((failure) => failure.code === "ghost-delete"),
			JSON.stringify(report.failures),
		);
		rmSync(undead.root, { recursive: true, force: true });
	}

	// Red: a delete that undercounts the file the base commit held.
	const shortDelete = makeFixture(failures, "del", ({ root, gitq }) => {
		writeFileSync(join(root, "doomed.txt"), "x\ny\nz\nq\nw\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		rmSync(join(root, "doomed.txt"));
		const session = join(root, "session.jsonl");
		writeFileSync(
			session,
			sessionText(root, [kernelResult([{ path: join(root, "doomed.txt"), kind: "deleted", scope: "project", added: 0, removed: 2, source: "shell", at: 1 }])]),
		);
		return { root, session };
	});
	if (shortDelete) {
		const report = run(shortDelete);
		expectTrue(
			failures,
			"e2e delete-count red",
			report.failures.some((failure) => failure.code === "delete-count"),
			JSON.stringify(report.failures),
		);
		rmSync(shortDelete.root, { recursive: true, force: true });
	}

	// Warning only: a change reverted back to the base content reconciles green.
	const reverted = makeFixture(failures, "revert", ({ root, gitq }) => {
		writeFileSync(join(root, "same.txt"), "a\nb\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		const session = join(root, "session.jsonl");
		writeFileSync(
			session,
			sessionText(root, [kernelResult([{ path: join(root, "same.txt"), kind: "modified", scope: "project", added: 1, removed: 1, source: "edit", at: 1 }])]),
		);
		return { root, session };
	});
	if (reverted) {
		const report = run(reverted);
		expectTrue(failures, "e2e net-zero stays green", report.ok === true, JSON.stringify(report.failures));
		expectTrue(
			failures,
			"e2e net-zero warns",
			report.warnings.some((warning) => warning.code === "net-zero" && warning.path === "same.txt"),
			JSON.stringify(report.warnings),
		);
		rmSync(reverted.root, { recursive: true, force: true });
	}

	// The edit tool's numbered diff joins through the assistant toolCall and
	// reconciles like a kernel record.
	const viaEdit = makeFixture(failures, "edit", ({ root, gitq }) => {
		writeFileSync(join(root, "a.ts"), "l1\nl2\nl3\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		writeFileSync(join(root, "a.ts"), "l1\nCHANGED\nl3\nl4\n");
		const session = join(root, "session.jsonl");
		writeFileSync(session, sessionText(root, [...editCallAndResult("e1", "a.ts", "-  2 l2\n+  2 CHANGED\n+  4 l4\n")]));
		return { root, session };
	});
	if (viaEdit) {
		const report = run(viaEdit);
		expectTrue(failures, "e2e edit-tool green", report.ok === true, JSON.stringify(report.failures));
		expectEqual(failures, "e2e edit-tool headline", report.displayed.headline, "改了 1 个文件 +2 −1");
		expectEqual(failures, "e2e edit-tool coverage", report.coverage.edit, 1);
		rmSync(viaEdit.root, { recursive: true, force: true });
	}

	// The commit hint fires when the session moved HEAD.
	const committed = makeFixture(failures, "commit", ({ root, gitq }) => {
		writeFileSync(join(root, "a.txt"), "a\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		writeFileSync(join(root, "a.txt"), "a\nb\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "session commit"]);
		const session = join(root, "session.jsonl");
		writeFileSync(
			session,
			sessionText(root, [
				{ role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "git add -A && git commit -m 'session commit'" } }] },
				kernelResult([{ path: join(root, "a.txt"), kind: "modified", scope: "project", added: 1, removed: 0, source: "edit", at: 1 }]),
			]),
		);
		return { root, session };
	});
	if (committed) {
		const report = run(committed);
		expectTrue(
			failures,
			"e2e commit hint",
			report.notes.some((note) => note.includes("--base")),
			JSON.stringify(report.notes),
		);
		rmSync(committed.root, { recursive: true, force: true });
	}

	// Session cwd one level below the repo root: claimed paths reconcile there, and
	// git changes elsewhere in the repo count as outside, not as unclaimed warnings.
	const subdir = makeFixture(failures, "subdir", ({ root, gitq }) => {
		mkdirSync(join(root, "pkg"));
		writeFileSync(join(root, "pkg", "in.txt"), "a\n");
		writeFileSync(join(root, "elsewhere.txt"), "e\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		writeFileSync(join(root, "pkg", "in.txt"), "a\nb\nc\n");
		writeFileSync(join(root, "elsewhere.txt"), "e\nf\n");
		const cwd = join(root, "pkg");
		const session = join(root, "session.jsonl");
		writeFileSync(
			session,
			sessionText(cwd, [kernelResult([{ path: join(cwd, "in.txt"), relPath: "in.txt", kind: "modified", scope: "project", added: 2, removed: 0, source: "edit", at: 1 }])]),
		);
		return { root, session, cwd };
	});
	if (subdir) {
		const report = reconcileSession({ sessionPath: subdir.session, cwd: subdir.cwd, base: "HEAD" });
		expectTrue(failures, "e2e subdir green", report.ok === true, JSON.stringify(report.failures));
		expectTrue(
			failures,
			"e2e subdir outside not unclaimed",
			report.warnings.every((warning) => warning.code !== "unclaimed-change") &&
				report.notes.some((note) => /\d+ 个 git 改动在会话目录之外/.test(note)),
			JSON.stringify([report.warnings, report.notes]),
		);
		rmSync(subdir.root, { recursive: true, force: true });
	}

	// Cannot reconcile: a base that does not exist is an exit-2 class error.
	const badBase = standard();
	if (badBase) {
		let threw = false;
		try {
			run(badBase, { base: "no-such-ref" });
		} catch (error) {
			threw = error instanceof ReconcileError;
		}
		expectTrue(failures, "e2e bad base is a usage-class error", threw);
		rmSync(badBase.root, { recursive: true, force: true });
	}
}

function stageC(failures) {
	// CLI control: the self-test above drives reconcileSession in-process; this one
	// spawns the real entry point so arg parsing, exit codes and --json stay wired.
	const script = fileURLToPath(import.meta.url);
	const fixture = makeFixture(failures, "cli", ({ root, gitq }) => {
		writeFileSync(join(root, "a.txt"), "a\nb\n");
		gitq(["add", "-A"]);
		gitq(["commit", "-qm", "base"]);
		writeFileSync(join(root, "a.txt"), "a\nB\nc\n");
		const session = join(root, "session.jsonl");
		writeFileSync(
			session,
			sessionText(root, [kernelResult([{ path: join(root, "a.txt"), kind: "modified", scope: "project", added: 2, removed: 1, source: "edit", at: 1 }])]),
		);
		return { root, session };
	});
	if (!fixture) return;
	try {
		const green = spawnSync(process.execPath, [script, "--session", fixture.session, "--cwd", fixture.root, "--json"], { encoding: "utf8" });
		expectEqual(failures, "cli green exit", green.status, 0);
		try {
			expectEqual(failures, "cli green json ok", JSON.parse(green.stdout).ok, true);
		} catch {
			selfTestFail(failures, "cli green json", `stdout did not parse: ${green.stdout.slice(0, 200)}`);
		}
		writeFileSync(
			fixture.session,
			sessionText(fixture.root, [kernelResult([{ path: join(fixture.root, "a.txt"), kind: "created", scope: "project", added: 3, removed: 0, source: "python", at: 1 }])]),
		);
		const red = spawnSync(process.execPath, [script, "--session", fixture.session, "--cwd", fixture.root], { encoding: "utf8" });
		expectEqual(failures, "cli red exit", red.status, 1);
		expectTrue(failures, "cli red names the lie", red.stdout.includes("phantom-create"), red.stdout.slice(0, 300));
		const usage = spawnSync(process.execPath, [script, "--bogus-flag"], { encoding: "utf8" });
		expectEqual(failures, "cli usage exit", usage.status, 2);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}

function runSelfTest() {
	const failures = [];
	if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
		console.error(`${SCRIPT} self-test: git is not available`);
		return 1;
	}
	stageA(failures);
	stageB(failures);
	stageC(failures);
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		console.error(`${SCRIPT} self-test: ${failures.length} 处失败`);
		return 1;
	}
	console.log(`${SCRIPT} self-test: OK（计数/解析/聚合/判例 + 端到端种红全过）`);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathOrSelf(process.argv[1])) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`${SCRIPT}: ${error.message}\n\n${USAGE}`);
			process.exit(2);
		}
		if (error instanceof ReconcileError) {
			console.error(`${SCRIPT}: ${error.message}`);
			process.exit(2);
		}
		throw error;
	}
}

function realpathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
