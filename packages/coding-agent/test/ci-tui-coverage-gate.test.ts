import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * QW-R1: the tui CI job runs `node --test`, not vitest, so it wrote no JSON report and no
 * coverage gate ever saw what it ran ("tui job 无 vitest 报告、不在覆盖闸内"). This test
 * pins the wiring that closed that hole: the job hands a junit XML report to
 * scripts/check-node-test-coverage.mjs with its own floors, and the gate is proven red on
 * planted reports on every CI run.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A GitHub Actions matrix expression, escaped so the linter does not read the `{{ }}` block
 * as a template placeholder.
 */
const matrixExpression = (field: string): string => `\${{ matrix.${field} }}`;
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const gatePath = join(repoRoot, "scripts", "check-node-test-coverage.mjs");

type MatrixRow = Record<string, unknown>;
type Step = { name?: string; run?: string; if?: string };

function workflow(): { jobs: Record<string, { steps?: Step[]; strategy?: { matrix?: { include?: MatrixRow[] } } }> } {
	return parse(readFileSync(workflowPath, "utf8")) as ReturnType<typeof workflow>;
}

const testJob = () => workflow().jobs.test;
const tuiRow = (): MatrixRow | undefined => testJob()?.strategy?.matrix?.include?.find((row) => row.name === "tui");

function steps(name: string): Step[] {
	return testJob()?.steps?.filter((step) => step.name === name) ?? [];
}

describe("the tui CI job is inside the coverage gate (QW-R1)", () => {
	it("hands a junit report to the node --test gate instead of running ungated", () => {
		const row = tuiRow();
		expect(row).toBeDefined();
		// The vitest `report` stays empty (the tui suite is `node --test`, not vitest); the
		// junit report is what carries this job into a gate.
		expect(row?.node_test_report).toMatch(/\.xml$/);
		expect(row?.report ?? "").toBe("");
	});

	it("pins the floors and the deliberate-skip budget for its own environment", () => {
		const row = tuiRow();
		expect(row?.min_tests).toBeTypeOf("number");
		expect(row?.min_tests as number).toBeGreaterThan(0);
		expect(row?.min_ran_tests).toBeTypeOf("number");
		expect((row?.min_ran_tests as number) ?? 0).toBeLessThanOrEqual((row?.min_tests as number) ?? 0);
		expect(row?.max_nothing_suites).toBeTypeOf("number");
	});

	it("runs its tests with the junit reporter writing that report", () => {
		// The reporters live in the matrix command itself: node parses `--test-reporter` only
		// before the file list, so a step that appended them to `npm test --` would write no
		// report at all while looking wired up.
		const row = tuiRow();
		expect(row?.command).toContain("--test-reporter=junit");
		expect(row?.command).toContain(`--test-reporter-destination=${row?.node_test_report}`);
		const [testStep] = steps("Test (node --test with a junit report)");
		expect(testStep).toBeDefined();
		expect(testStep?.if).toContain("matrix.node_test_report != ''");
		expect(testStep?.run).toContain(matrixExpression("command"));
	});

	it("gates that report with check-node-test-coverage.mjs and the pinned floors", () => {
		const [gateStep] = steps("node --test coverage gate");
		expect(gateStep).toBeDefined();
		expect(gateStep?.if).toContain("matrix.node_test_report != ''");
		expect(gateStep?.run).toContain("check-node-test-coverage.mjs");
		expect(gateStep?.run).toContain(matrixExpression("node_test_report"));
		expect(gateStep?.run).toContain(matrixExpression("min_tests"));
		expect(gateStep?.run).toContain(matrixExpression("min_ran_tests"));
		expect(gateStep?.run).toContain(matrixExpression("max_nothing_suites"));
		// The plain `Test` step must not double-run the tui suite once it has its own step.
		const plain = testJob()?.steps?.find((step) => step.name === "Test");
		expect(plain?.if).toContain("matrix.node_test_report == ''");
	});

	it("proves the gate red on planted reports on every CI run", () => {
		const hygieneSteps = workflow().jobs["test-hygiene"]?.steps ?? [];
		const selfTest = hygieneSteps.find((step) =>
			(step.run ?? "").includes("check-node-test-coverage.mjs --self-test"),
		);
		expect(selfTest).toBeDefined();
		expect(selfTest?.name).toContain("planted");
	});

	it("the gate's own self-test exits 0 (planted red controls all caught)", () => {
		expect(existsSync(gatePath)).toBe(true);
		const result = spawnSync(process.execPath, [gatePath, "--self-test"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("0 mismatch(es)");
	});
});
