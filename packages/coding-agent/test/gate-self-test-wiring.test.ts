import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A `--self-test` that nothing runs is decoration, and this repository has already paid for that
 * twice in one batch: the process-smoke floor module grew a six-control self-test that no aggregate
 * entry invoked (`grep -rn "ci-process-smoke.mjs --self-test"` found nothing but its own usage
 * line; that module is gone now - the row it mirrored lives in ci.yml and the mirror's self-test
 * carries the same controls), and the coverage gate's self-test - the only exercise of the
 * recompute controls - was in the hygiene job while nothing said so.
 *
 * This pin makes the wiring visible: every gate script in `scripts/` that can prove itself must be
 * invoked by an aggregate (a workflow step, `check:ci-honesty`, or the pre-push gate), and the
 * aggregate that runs it is asserted by name. Deleting the invocation is how an instrument rots,
 * and that is exactly what this test refuses.
 *
 * The second half refuses the quieter rot: an instrument that runs but cannot prove anything, and
 * does not say so. The `test-hygiene` job runs `node scripts/check-browser-smoke.mjs --self-test`
 * and never runs `npm ci`, so that step died on `Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 * 'esbuild'` with exit 1 - a red that reads like "a planted drift was not caught" while meaning
 * "this runner had no node_modules", and the bundle reds were never planted there at all.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	scripts: Record<string, string>;
};
const hygieneJob = workflow.slice(workflow.indexOf("test-hygiene:"), workflow.indexOf("build-check-test:"));
const ciHonesty = rootPackage.scripts["check:ci-honesty"] ?? "";
const preflight = readFileSync(join(repoRoot, "scripts", "preflight-push.sh"), "utf8");

/**
 * The shell text of every `run:` step in the hygiene job, inline or block form. Comments are left
 * out on purpose: prose above a step is allowed to name a file that is gone (the step that ran
 * `scripts/lib/ci-process-smoke.mjs` carries a comment saying so), a command is not.
 */
function hygieneRunBlocks(): string[] {
	const blocks: string[] = [];
	const lines = hygieneJob.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
		if (!match) continue;
		const indent = match[1].length;
		const inline = match[2].trim();
		if (inline !== "" && !/^[|>]/.test(inline)) {
			blocks.push(inline);
			continue;
		}
		const body: string[] = [];
		for (let k = i + 1; k < lines.length; k++) {
			const line = lines[k];
			if (line.trim() !== "" && line.search(/\S/) <= indent) break;
			body.push(line);
		}
		blocks.push(body.join("\n"));
	}
	return blocks;
}

/** Where a self-test is reachable from, or "nowhere". */
function wiringFor(command: string): string {
	if (hygieneJob.includes(command)) return "test-hygiene job";
	if (ciHonesty.includes(command))
		return "check:ci-honesty (npm run check, husky pre-commit and the CI build-check job)";
	if (preflight.includes(command)) return "scripts/preflight-push.sh";
	return "nowhere";
}

const INSTRUMENTS: { command: string; why: string }[] = [
	{
		command: "node scripts/check-test-private-probes.mjs --self-test",
		why: "planted private-member probes are the only proof its matcher still matches",
	},
	{
		command: "node scripts/check-vitest-coverage.mjs --self-test",
		why: "planted all-skipped reports and the recompute controls",
	},
	{
		command: "node scripts/check-node-test-coverage.mjs --self-test",
		why: "the tui job has no vitest report, so this is its only gate",
	},
	{
		command: "node scripts/check-npm-release-cooldown.mjs --self-test",
		why: "planted npm 10.9.4 has to go red without network access",
	},
	{
		// The process-smoke row's floors and tag-skip ledger are read out of `.github/workflows/ci.yml`
		// by `scripts/lib/ci-matrix-row.mjs`; the mirror's self-test is the only run that plants drift
		// in the row, the ledger and the coverage recompute at once. It used to be spelled
		// `node scripts/lib/ci-process-smoke.mjs --self-test`, and when that module was deleted with the
		// row-as-source change this list kept naming the file until the "instruments exist" case below
		// went red - which is why the command here is the mirror's, not a module's.
		command: "bash scripts/check-process-smoke.sh --self-test",
		why: "the process-smoke row is read out of ci.yml, and this keeps the reader and the floors honest",
	},
	{
		command: "bash scripts/check-tag-skip-ledger.sh --self-test",
		why: "a declaration that no longer skips must be red, not remembered",
	},
	{
		command: "bash scripts/check-platform-coverage.sh --self-test",
		why: "the platform registry has to prove it can still detect an incomplete one",
	},
	{
		command: "bash scripts/latest-ci-run.sh --self-test",
		why: "the CI verdict plumbing: green, red, the pinned repository and the empty answer",
	},
	{
		command: "node scripts/sync-versions.js --self-test",
		why: "the lockstep set and the lockfile agreement",
	},
	{
		command: "npm run check:process-smoke",
		why: "the process smoke face test:ci excludes (raises both instruments above, on a real report)",
	},
	{
		command: "node scripts/check-installer.mjs --self-test",
		why: "planted install.sh drift, and install.sh is the only entry an outside user has",
	},
	{
		command: "node scripts/check-browser-smoke.mjs --self-test",
		why: "planted bundle-smoke drift (the gate whose only failure face used to be an esbuild throw)",
	},
];

describe("every self-test this repository relies on is reachable from an aggregate", () => {
	for (const instrument of INSTRUMENTS) {
		it(`${instrument.command} (${instrument.why})`, () => {
			expect(wiringFor(instrument.command)).not.toBe("nowhere");
		});
	}

	it("names the aggregate in the failure, so a missing wiring is actionable", () => {
		const missing = INSTRUMENTS.filter((instrument) => wiringFor(instrument.command) === "nowhere");
		expect(missing.map((instrument) => instrument.command)).toEqual([]);
	});

	it("the instruments it lists actually exist as files", () => {
		for (const instrument of INSTRUMENTS) {
			const script = instrument.command
				.split(" ")
				.slice(1)
				.find((part) => part.startsWith("scripts/"));
			if (script === undefined) continue;
			const probe = spawnSync("test", ["-e", join(repoRoot, script)]);
			expect(probe.status, `${script} is listed as an instrument but does not exist`).toBe(0);
		}
	});

	it("the mirror's self-test runs in the job that installs nothing", () => {
		// Asserted by name rather than by "wired somewhere": the step exists in this job because
		// the mirror's self-test installs nothing, and the one that used to sit here pointed at
		// `scripts/lib/ci-process-smoke.mjs` - a file 9afed3ba6 deleted, so the job died on
		// ERR_MODULE_NOT_FOUND while `npm run check:ci-honesty` kept the same command reachable
		// from a job that does install. Reachability alone would have called that wired.
		expect(wiringFor("bash scripts/check-process-smoke.sh --self-test")).toBe("test-hygiene job");
	});

	it("no script a hygiene step names is missing from the checkout", () => {
		// The shape that shipped in this batch, one level wider than the list above: the list only
		// covers the commands *this file* names, so a step pointing at some other deleted file rots
		// unnoticed. Only the `run:` bodies are read - a comment naming the file that is gone is
		// documentation, not a command.
		const referenced = new Set<string>();
		for (const block of hygieneRunBlocks()) {
			for (const match of block.matchAll(/(?:scripts|packages|\.husky)\/[\w./-]+/g)) {
				referenced.add(match[0]);
			}
		}
		expect(referenced.size).toBeGreaterThan(0);
		const missing = [...referenced].filter((path) => !existsSync(join(repoRoot, path))).sort();
		expect(missing, "every script a hygiene step runs must exist").toEqual([]);
	});
});

const browserSmokeScript = join(repoRoot, "scripts", "check-browser-smoke.mjs");

/** Node's own answer for a bare specifier resolved from `cwd`, which is how `-e` code resolves one. */
function importProbe(cwd: string, specifier: string): { status: number | null; output: string } {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`],
		{
			cwd,
			encoding: "utf8",
		},
	);
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * A copy of the bundle gate sitting in a directory whose nearest `node_modules` holds an `esbuild`
 * whose main file does not exist: the resolution failure a job that never ran `npm ci` gets, made
 * deterministic (a nearer `node_modules` always wins over the repository's own), and without
 * touching the checkout's install.
 */
function withoutBundleDependency(): { root: string; script: string } {
	const root = mkdtempSync(join(tmpdir(), "browser-smoke-without-deps-"));
	mkdirSync(join(root, "node_modules", "esbuild"), { recursive: true });
	writeFileSync(
		join(root, "node_modules", "esbuild", "package.json"),
		JSON.stringify({ name: "esbuild", version: "0.0.0", type: "module", main: "missing.js" }),
	);
	const script = join(root, "scripts", "check-browser-smoke.mjs");
	mkdirSync(dirname(script), { recursive: true });
	copyFileSync(browserSmokeScript, script);
	return { root, script };
}

function runBrowserSmoke(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("a self-test whose aggregate installs nothing says so instead of dying", () => {
	it("the fixture really makes the dependency unresolvable, and this repository really has it", () => {
		const fixture = withoutBundleDependency();
		try {
			const inFixture = importProbe(fixture.root, "esbuild");
			expect(inFixture.status, `the fixture must break esbuild resolution:\n${inFixture.output}`).not.toBe(0);
			const inRepo = importProbe(repoRoot, "esbuild");
			expect(inRepo.status, `the repository's install must still resolve esbuild:\n${inRepo.output}`).toBe(0);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("skips the legs that need a bundle, loudly and counted, and still runs the ones that do not", () => {
		const fixture = withoutBundleDependency();
		try {
			const run = runBrowserSmoke(fixture.script, ["--self-test"]);
			expect(run.status, `expected a skip, not a failure:\n${run.stdout}\n${run.stderr}`).toBe(0);
			expect(run.stderr, "the missing dependency must not reach the operator as a node crash").toBe("");
			// Loud: one SKIP line per bundle leg, each naming the package and the resolution failure.
			const skips = run.stdout.match(/^SKIP /gm) ?? [];
			expect(skips.length, "exactly the six bundle-planting legs need the dependency").toBe(6);
			expect(run.stdout).toContain('the bundle dependency "esbuild" is not installed');
			// Counted: the tally separates what ran from what could not, and nothing else is red.
			expect(run.stdout).toContain("6 skipped");
			expect(run.stdout).not.toMatch(/^FAIL /m);
			expect(run.stdout).toContain("0 mismatch(es)");
			// The legs that need no bundle still ran and still judged something.
			expect(run.stdout).toContain("ok   the dependency notice names the package");
			expect(run.stdout).toContain("ok   an unresolvable bundle dependency is reported as a value");
			// And the verdict says how much of itself it managed to prove.
			expect(run.stdout).toContain("check-browser-smoke self-test: OK (6 of 9 legs skipped");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("the gate itself never answers green when it cannot look at a bundle at all", () => {
		const fixture = withoutBundleDependency();
		try {
			const run = runBrowserSmoke(fixture.script, []);
			expect(run.status, `expected the refusal exit code, not a crash:\n${run.stdout}\n${run.stderr}`).toBe(2);
			expect(run.stderr).toContain(
				'Browser smoke check cannot run: the bundle dependency "esbuild" is not installed',
			);
			expect(run.stderr).toContain("npm ci");
			// "cannot run" must not be dressed up as the gate's own red, or as a green silence.
			expect(run.stderr).not.toContain("Browser smoke check failed");
			expect(run.stdout).toBe("");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
