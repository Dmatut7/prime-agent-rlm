#!/usr/bin/env node
// Table-driven check for the pre-push secret scan (scripts/pre-push-secret-scan.mjs, run
// as stage 3 of .husky/pre-push), wired into `npm run check` as check:secret-scan.
//
// Every case builds a scratch repository under os.tmpdir(), commits fixture content into
// it and drives the real .husky/pre-push hook with canned pre-push stdin
// ("<local ref> <local oid> <remote ref> <remote oid>"), asserting on the exit code and
// on what a refusal says - including what it must NOT say (findings are masked; the raw
// secret never reaches stderr). The push URL is a non-GitHub host so the stage-2 mirror
// guard passes everything through and only the scan under test can refuse.
//
// Poison fixtures carry a `secret-scan: allow` marker comment because this file is itself
// tracked content: a future push re-adding these lines would trip the scan. The commits
// built at runtime contain the bare values, so detection is exercised regardless.
//
// The last case is the drift guard: the literal-shape table in the scanner must match
// SHARE_SECRET_PATTERNS in packages/coding-agent/src/core/share-secret-detectors.ts entry
// for entry (label, regex source, flags, valueGroup). One calibration, two consumers; a
// share-table edit that forgets the push gate turns this check red.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(root, ".husky", "pre-push");
const scanner = join(root, "scripts", "pre-push-secret-scan.mjs");
const shareDetectors = join(root, "packages", "coding-agent", "src", "core", "share-secret-detectors.ts");
const zero = "0".repeat(40);
// A non-GitHub host: the stage-2 mirror guard only polices real GitHub remotes, so this
// URL leaves the stage-3 scan as the only thing that can refuse.
const url = "https://code.example.test/o/r.git";
const github = "https://github.com/PrimeIntellect-ai/prime-agent.git";

const POISON_EMAIL = "wave40-scan-qa@gmail.com"; // secret-scan: allow
const POISON_ANTHROPIC = "sk-ant-api03-W4vE40ScanPoisonKey0123456789abcd"; // secret-scan: allow
// AKIA + exactly 16: the AKIA pattern is anchored (\b at both ends), so a fake must keep
// the real shape's length or it teaches nothing.
const POISON_AWS = "AKIAWAVE40SCANPOISON"; // secret-scan: allow
const POISON_UUID = "123e4567-e89b-12d3-a456-426614174000";

function baseEnv(extra = {}) {
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		PRIME_AGENT_ALLOW_SECRET_PUSH: "",
		PRIME_AGENT_ALLOW_MIRROR_PUSH: "",
		PRIME_AGENT_ALLOW_VTAG: "",
		...extra,
	};
	// Never let a caller's checkout (or a leaked agent-session variable) steer git.
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "RLM_DEPTH", "RLM_SESSION_DIR"]) {
		delete env[name];
	}
	return env;
}

function git(repo, ...args) {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: baseEnv(), timeout: 15000 });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

const repos = [];
function mkrepo() {
	const repo = mkdtempSync(join(tmpdir(), "prime-agent-secret-scan-"));
	repos.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Scan Test");
	git(repo, "config", "commit.gpgsign", "false");
	commitFile(repo, "README.md", "base\n", "base commit");
	return repo;
}

function commitFile(repo, path, content, message) {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
	git(repo, "add", path);
	git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

function runHook(repo, stdin, { env = {}, pushUrl = url } = {}) {
	return spawnSync("sh", [hook, "origin", pushUrl], {
		cwd: repo,
		input: stdin,
		encoding: "utf8",
		timeout: 30000,
		env: baseEnv(env),
	});
}

const create = (sha) => `refs/heads/main ${sha} refs/heads/main ${zero}`;
const update = (from, to) => `refs/heads/main ${to} refs/heads/main ${from}`;

// Each case returns [spawnResult, expectedExit, stderrMustInclude?, stderrMustExclude?].
const cases = [
	["clean commits pass silently", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 1;\n", "feat: add app");
		return [runHook(repo, create(sha)), 0];
	}],
	["an account email in a commit message is refused (update range)", () => {
		const repo = mkrepo();
		const base = git(repo, "rev-parse", "HEAD");
		const sha = commitFile(repo, "src/app.ts", "export const x = 2;\n", `fix: probe auth\n\naccount: ${POISON_EMAIL}\n`);
		return [runHook(repo, update(base, sha)), 1, ["Email address"], [POISON_EMAIL]];
	}],
	["the fd1dd4e4c shape (orgId JSON in a message) is refused", () => {
		const repo = mkrepo();
		const message = `feat: honest badges\n\nthe badge follows a real {\n  "loggedIn": true,\n  "orgId": "${POISON_UUID}",\n  "subscriptionType": "team"\n} probe\n`;
		const sha = commitFile(repo, "src/app.ts", "export const x = 3;\n", message);
		return [runHook(repo, create(sha)), 1, ["Org/account UUID"], [POISON_UUID]];
	}],
	["a bare UUID cited in a message passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 4;\n", `fix: retry window\n\nsession ${POISON_UUID}, 2026-09-12T20:59Z..2026-09-13T03:34Z\n`);
		return [runHook(repo, create(sha)), 0];
	}],
	["a Co-Authored-By trailer email in a message passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 5;\n", `feat: thing\n\nCo-Authored-By: Dev Name <${POISON_EMAIL}>\n`);
		return [runHook(repo, create(sha)), 0];
	}],
	["an sk-ant key in an added diff line is refused with file:line", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/keys.ts", `// a\n// b\nexport const k = "${POISON_ANTHROPIC}";\n`, "add keys");
		return [runHook(repo, create(sha)), 1, ["API key (sk-)", "src/keys.ts:3"], [POISON_ANTHROPIC]];
	}],
	["an AWS access key id in an added diff line is refused", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "notes.txt", `aws id ${POISON_AWS}\n`, "add notes");
		return [runHook(repo, create(sha)), 1, ["AWS access key (AKIA)"], [POISON_AWS]];
	}],
	["the docs-style sk-ant-... placeholder passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "docs/providers.md", "export ANTHROPIC_API_KEY=sk-ant-...\n", "docs");
		return [runHook(repo, create(sha)), 0];
	}],
	["an example.com fixture email in a diff passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "test/x.test.ts", `const from = "user@example.com";\n`, "add test");
		return [runHook(repo, create(sha)), 0];
	}],
	["an scp-style git URL in a diff passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "test/git.test.ts", `const remote = "git@github.com:o/r.git";\n`, "add test");
		return [runHook(repo, create(sha)), 0];
	}],
	["a URL userinfo in a diff passes", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "test/git.test.ts", `const remote = "https://token@github.com/o/r.git";\n`, "add test");
		return [runHook(repo, create(sha)), 0];
	}],
	["an account email in an added diff line is refused", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/contact.ts", `export const admin = "${POISON_EMAIL}";\n`, "add contact");
		return [runHook(repo, create(sha)), 1, ["Email address", "src/contact.ts:1"], [POISON_EMAIL]];
	}],
	["the secret-scan: allow marker suppresses a diff finding", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "docs/shapes.md", `example: ${POISON_ANTHROPIC}  <!-- secret-scan: allow -->\n`, "docs");
		return [runHook(repo, create(sha)), 0];
	}],
	["a poisoned merge-commit message is refused (merge diffs carry no patch)", () => {
		const repo = mkrepo();
		git(repo, "checkout", "-q", "-b", "side");
		commitFile(repo, "side.ts", "export const side = 1;\n", "side work");
		git(repo, "checkout", "-q", "main");
		commitFile(repo, "main2.ts", "export const main2 = 1;\n", "main work");
		git(repo, "merge", "--no-ff", "-m", `merge side\n\naccount: ${POISON_EMAIL}\n`, "side");
		const sha = git(repo, "rev-parse", "HEAD");
		return [runHook(repo, create(sha)), 1, ["Email address"], [POISON_EMAIL]];
	}],
	["a push where local equals remote scans nothing", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 6;\n", `fix: x\n\naccount: ${POISON_EMAIL}\n`);
		return [runHook(repo, `refs/heads/main ${sha} refs/heads/main ${sha}`), 0];
	}],
	["removing a line that held a key passes (only added lines are scanned)", () => {
		const repo = mkrepo();
		commitFile(repo, "leak.txt", `old id ${POISON_AWS}\n`, "add notes");
		const base = git(repo, "rev-parse", "HEAD");
		git(repo, "rm", "-q", "leak.txt");
		git(repo, "commit", "-q", "-m", "remove notes");
		const tip = git(repo, "rev-parse", "HEAD");
		return [runHook(repo, update(base, tip)), 0];
	}],
	["one poisoned branch among two refs is refused", () => {
		const repo = mkrepo();
		const clean = commitFile(repo, "a.ts", "export const a = 1;\n", "clean work");
		git(repo, "checkout", "-q", "-b", "poison");
		const bad = commitFile(repo, "b.ts", `id ${POISON_AWS}\n`, "add notes");
		git(repo, "checkout", "-q", "main");
		const stdin = `refs/heads/main ${clean} refs/heads/main ${zero}\nrefs/heads/poison ${bad} refs/heads/poison ${zero}\n`;
		return [runHook(repo, stdin), 1, ["AWS access key (AKIA)", "b.ts"], [POISON_AWS]];
	}],
	["the scan also refuses on a real GitHub URL (mirror guard passes it through)", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 7;\n", `fix: y\n\naccount: ${POISON_EMAIL}\n`);
		return [runHook(repo, create(sha), { pushUrl: github }), 1, ["Email address"], [POISON_EMAIL]];
	}],
	["the escape hatch lifts a refusal and warns", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 8;\n", `fix: z\n\naccount: ${POISON_EMAIL}\n`);
		return [
			runHook(repo, create(sha), { env: { PRIME_AGENT_ALLOW_SECRET_PUSH: "1" } }),
			0,
			["warning", "PRIME_AGENT_ALLOW_SECRET_PUSH"],
		];
	}],
	["an escape value of true does not bypass", () => {
		const repo = mkrepo();
		const sha = commitFile(repo, "src/app.ts", "export const x = 9;\n", `fix: w\n\naccount: ${POISON_EMAIL}\n`);
		return [runHook(repo, create(sha), { env: { PRIME_AGENT_ALLOW_SECRET_PUSH: "true" } }), 1, ["Email address"]];
	}],
	["an empty up-to-date push passes", () => {
		const repo = mkrepo();
		return [runHook(repo, ""), 0];
	}],
	["a branch deletion line is skipped", () => {
		const repo = mkrepo();
		const base = git(repo, "rev-parse", "HEAD");
		return [runHook(repo, `(delete) ${zero} refs/heads/old ${base}`), 0];
	}],
	["an unresolvable local sha is skipped with a note", () => {
		const repo = mkrepo();
		return [runHook(repo, `refs/heads/main ${"f".repeat(40)} refs/heads/main ${zero}`), 0, ["skipping"]];
	}],
	["malformed stdin fails closed", () => {
		const repo = mkrepo();
		return [runHook(repo, "refs/heads/main refs/heads/main"), 1, ["malformed"]];
	}],
	["the scanner --self-test passes", () => {
		const result = spawnSync(process.execPath, [scanner, "--self-test"], { encoding: "utf8", timeout: 30000, env: baseEnv() });
		return [result, 0];
	}],
	["the literal-shape table matches SHARE_SECRET_PATTERNS (drift guard)", () => {
		// Entries are single-line `{ type: "<label>", pattern: /…/flags[, valueGroup: n] },`
		// in both files; the class-aware regex keeps `/` inside `[...]` from ending a pattern.
		const entry = /\{\s*type:\s*"([^"]+)",\s*pattern:\s*(\/(?:\\.|[^\\/]|\[(?:\\.|[^\]\\])*\])+\/[a-z]*)(?:,\s*valueGroup:\s*(\d+))?\s*\},/g;
		const extract = (file) => {
			const map = new Map();
			for (const match of readFileSync(file, "utf8").matchAll(entry)) {
				map.set(match[1], `${match[2]}|${match[3] ?? ""}`);
			}
			return map;
		};
		const share = extract(shareDetectors);
		const gate = extract(scanner);
		const missing = [...share.keys()].filter((label) => !gate.has(label));
		const diverged = [...share.keys()].filter((label) => gate.has(label) && gate.get(label) !== share.get(label));
		const stderr = [
			missing.length > 0 ? `missing from the push gate: ${missing.join(", ")}` : "",
			diverged.length > 0 ? `diverged from the share table: ${diverged.join(", ")}` : "",
			share.size === 0 ? "drift guard extracted zero share-table entries (extraction broken)" : "",
		]
			.filter(Boolean)
			.join("; ");
		return [{ status: missing.length + diverged.length === 0 && share.size > 0 ? 0 : 1, stderr }, 0];
	}],
];

let failures = 0;
for (const [name, run] of cases) {
	let failed = "";
	try {
		const [result, code, includes = [], excludes = []] = run();
		const stderr = result.stderr ?? "";
		if (result.status !== code) {
			failed = `exit=${result.status} expected=${code}`;
		} else {
			for (const needle of includes) {
				if (!stderr.includes(needle)) failed = `stderr does not mention: ${needle}`;
			}
			for (const needle of excludes) {
				if (failed === "" && stderr.includes(needle)) failed = `stderr leaks the raw secret: ${needle.slice(0, 12)}…`;
			}
		}
		if (failed !== "") console.error(stderr);
	} catch (error) {
		failed = String(error);
	}
	if (failed !== "") {
		failures += 1;
		console.error(`FAIL ${name}: ${failed}`);
	}
}
for (const repo of repos) rmSync(repo, { recursive: true, force: true });
if (failures > 0) {
	console.error(`pre-push secret scan check: ${failures} failing case(s)`);
	process.exit(1);
}
console.log(`pre-push secret scan check: ${cases.length} cases passed.`);
