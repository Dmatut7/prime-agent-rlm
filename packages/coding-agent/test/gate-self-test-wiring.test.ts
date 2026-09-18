import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A `--self-test` that nothing runs is decoration, and this repository has already paid for that
 * twice in one batch: the process-smoke floor module grew a six-control self-test that no aggregate
 * entry invoked (`grep -rn "ci-process-smoke.mjs --self-test"` found nothing but its own usage
 * line), and the coverage gate's self-test - the only exercise of the recompute controls - was in
 * the hygiene job while nothing said so.
 *
 * This pin makes the wiring visible: every gate script in `scripts/` that can prove itself must be
 * invoked by an aggregate (a workflow step, `check:ci-honesty`, or the pre-push gate), and the
 * aggregate that runs it is asserted by name. Deleting the invocation is how an instrument rots,
 * and that is exactly what this test refuses.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	scripts: Record<string, string>;
};
const hygieneJob = workflow.slice(workflow.indexOf("test-hygiene:"), workflow.indexOf("build-check-test:"));
const ciHonesty = rootPackage.scripts["check:ci-honesty"] ?? "";
const preflight = readFileSync(join(repoRoot, "scripts", "preflight-push.sh"), "utf8");

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
		command: "node scripts/lib/ci-process-smoke.mjs --self-test",
		why: "the process-smoke floors and tag-skip ledger have one source, and this keeps it honest",
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
});
