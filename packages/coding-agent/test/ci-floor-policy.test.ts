import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The floors in `.github/workflows/ci.yml` are a policy, and the policy is one sentence: a floor
 * is ceil(0.9 * what the job really produced in the CI run recorded in
 * `scripts/ci-floor-readings.json`. The sentence used to be written down with no reading behind
 * it, and the numbers drifted to 64%-87% of what the jobs produced - drift in the direction that
 * hides a lost face (an `ai` job that stopped running a third of its tests stayed green).
 *
 * This test is the thing that makes the sentence and the numbers the same object:
 *
 *   - every matrix row whose floors live in ci.yml must carry exactly floorFor(reading), the
 *     reading being the recorded run's collected/ran counts, not a local run and not a guess;
 *   - the process smoke row must be strictly equal to `scripts/lib/ci-process-smoke.mjs`, the
 *     single source the local mirror `scripts/check-process-smoke.sh` reads (so the mirror cannot
 *     gate at floors CI stopped using);
 *   - a row whose floors live in another file must be written down as an exception with that
 *     file's real numbers, so "the floors are 90% of the reading" has no silent hole in it;
 *   - every matrix row must appear either in `rows` (with a reading) or in `ungated_rows` (with a
 *     reason), so a new row cannot be added without deciding what gates it.
 *
 * The planted-mutation controls at the bottom run the same comparison functions against mutated
 * copies: a pin that cannot go red is decoration, and these prove this one can.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const readingsPath = join(repoRoot, "scripts", "ci-floor-readings.json");
const smokeModulePath = join(repoRoot, "scripts", "lib", "ci-process-smoke.mjs");
const CI_OWNER = ".github/workflows/ci.yml";

type MatrixRow = Record<string, unknown>;

type ReadingRow = {
	name: string;
	report: string;
	unit: string;
	collected: number;
	ran: number;
	files: number;
	nothing_files: number;
	max_nothing_budget: number;
	floors_owner: string;
	note?: string;
};

type ExceptionEntry = {
	name: string;
	owner_file: string;
	owner_script: string;
	owner_flags: { min_tests: number; min_ran_tests: number };
	policy_share: string;
	reason: string;
};

type Readings = {
	floor_ratio: number;
	source: { run_id: number; run_url: string; head_sha: string };
	rows: ReadingRow[];
	ungated_rows: { name: string; reason: string }[];
	exceptions: ExceptionEntry[];
};

/**
 * `ceil(value * ratio)` without binary-float surprises: `Math.ceil(10 * 0.9)` is 10, not 9,
 * because 10 * 0.9 is 9.000000000000002. Scaling the ratio to integer per-mille keeps the
 * multiplication exact, and IEEE division is exact whenever the true quotient is an integer.
 */
function floorFor(value: number, ratio: number): number {
	return Math.ceil((value * Math.round(ratio * 1000)) / 1000);
}

function workflowRows(): MatrixRow[] {
	const workflow = parse(readFileSync(workflowPath, "utf8")) as {
		jobs?: { test?: { strategy?: { matrix?: { include?: MatrixRow[] } } } };
	};
	return workflow.jobs?.test?.strategy?.matrix?.include ?? [];
}

function readings(): Readings {
	return JSON.parse(readFileSync(readingsPath, "utf8")) as Readings;
}

function rowNamed(rows: MatrixRow[], name: string): MatrixRow | undefined {
	return rows.find((row) => row.name === name);
}

/** What the recorded reading asks of a row, in the two floors the gate takes. */
function policyFloors(recorded: ReadingRow, ratio: number): { minTests: number; minRanTests: number } {
	return { minTests: floorFor(recorded.collected, ratio), minRanTests: floorFor(recorded.ran, ratio) };
}

/**
 * Every way a ci.yml row can disagree with the recorded reading. Empty means the workflow and the
 * policy are the same object; one entry per disagreement, naming both sides.
 */
function floorMismatches(rows: MatrixRow[], reading: Readings): string[] {
	const out: string[] = [];
	const byName = new Map(reading.rows.map((entry) => [entry.name, entry]));
	const ungated = new Set(reading.ungated_rows.map((entry) => entry.name));
	for (const row of rows) {
		const name = String(row.name);
		// An ungated row produces no report to gate, so it has no floor to derive.
		if (ungated.has(name)) continue;
		const recorded = byName.get(name);
		if (recorded === undefined) {
			out.push(`${name}: the workflow row has no reading in scripts/ci-floor-readings.json`);
			continue;
		}
		// Rows whose floors live in another file are checked by the exception test below.
		if (!recorded.floors_owner.includes(CI_OWNER)) continue;
		const want = policyFloors(recorded, reading.floor_ratio);
		const policyTests = recorded.collected * reading.floor_ratio;
		const policyRan = recorded.ran * reading.floor_ratio;
		if (row.min_tests !== want.minTests) {
			out.push(
				`${name}: ci.yml min_tests=${String(row.min_tests)}, but ceil(${reading.floor_ratio} * ${recorded.collected}) = ${want.minTests}`,
			);
		}
		if (row.min_ran_tests !== want.minRanTests) {
			out.push(
				`${name}: ci.yml min_ran_tests=${String(row.min_ran_tests)}, but ceil(${reading.floor_ratio} * ${recorded.ran}) = ${want.minRanTests}`,
			);
		}
		if (typeof row.min_tests === "number" && row.min_tests < policyTests) {
			out.push(
				`${name}: min_tests=${row.min_tests} is ${((100 * row.min_tests) / recorded.collected).toFixed(1)}% of the ` +
					`recorded ${recorded.collected} collected tests, below the policy share - ${policyTests - row.min_tests} test(s) could vanish unnoticed`,
			);
		}
		if (typeof row.min_ran_tests === "number" && row.min_ran_tests < policyRan) {
			out.push(
				`${name}: min_ran_tests=${row.min_ran_tests} is ${((100 * row.min_ran_tests) / recorded.ran).toFixed(1)}% of the ` +
					`recorded ${recorded.ran} running tests, below the policy share`,
			);
		}
	}
	for (const recorded of reading.rows) {
		if (rowNamed(rows, recorded.name) === undefined) {
			out.push(`${recorded.name}: recorded in scripts/ci-floor-readings.json but no longer a ci.yml matrix row`);
		}
	}
	return out;
}

/** Every way the process smoke row can disagree with the module both it and the local mirror read. */
function smokeMismatches(
	rows: MatrixRow[],
	config: { floors: Record<string, number>; tag_skip_ledger: string; tag_skip_entries: { count: number }[] },
	recorded: ReadingRow | undefined,
): string[] {
	const out: string[] = [];
	const row = rowNamed(rows, "coding-agent process smoke");
	if (row === undefined) return ['the ci.yml matrix has no "coding-agent process smoke" row'];
	for (const [key, value] of Object.entries(config.floors)) {
		if (row[key] !== value) {
			out.push(
				`ci.yml ${key}=${String(row[key])}, but scripts/lib/ci-process-smoke.mjs exports ${key}=${String(value)}`,
			);
		}
	}
	if (row.tag_skip_ledger !== config.tag_skip_ledger) {
		out.push("the ci.yml tag_skip_ledger string is not the one scripts/lib/ci-process-smoke.mjs exports");
	}
	if (recorded !== undefined) {
		const declared = config.tag_skip_entries.reduce((sum, entry) => sum + entry.count, 0);
		const gap = recorded.collected - recorded.ran;
		if (declared !== gap) {
			out.push(
				`the module declares ${declared} skip(s), but the recorded reading for this row is collected=${recorded.collected} ` +
					`ran=${recorded.ran}, a gap of ${gap}`,
			);
		}
	}
	return out;
}

/** Every way a row whose floors live elsewhere can be recorded dishonestly. */
function exceptionMismatches(reading: Readings): string[] {
	const out: string[] = [];
	const byName = new Map(reading.rows.map((entry) => [entry.name, entry]));
	for (const exception of reading.exceptions) {
		const recorded = byName.get(exception.name);
		if (recorded === undefined) {
			out.push(`${exception.name}: an exception for a row that has no reading`);
			continue;
		}
		if (!existsSync(join(repoRoot, exception.owner_file))) {
			out.push(`${exception.name}: the exception names ${exception.owner_file}, which does not exist`);
			continue;
		}
		if (exception.owner_file !== recorded.floors_owner.split(" ")[0]) {
			out.push(
				`${exception.name}: the reading says the floors live in "${recorded.floors_owner}" but the exception names "${exception.owner_file}"`,
			);
		}
		const owner = JSON.parse(readFileSync(join(repoRoot, exception.owner_file), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const command = owner.scripts?.[exception.owner_script] ?? "";
		const real = {
			min_tests: Number.parseInt(/--min-tests (\d+)/.exec(command)?.[1] ?? "NaN", 10),
			min_ran_tests: Number.parseInt(/--min-ran-tests (\d+)/.exec(command)?.[1] ?? "NaN", 10),
		};
		if (
			real.min_tests !== exception.owner_flags.min_tests ||
			real.min_ran_tests !== exception.owner_flags.min_ran_tests
		) {
			out.push(
				`${exception.name}: scripts/ci-floor-readings.json records --min-tests ${exception.owner_flags.min_tests} ` +
					`--min-ran-tests ${exception.owner_flags.min_ran_tests}, but ${exception.owner_file}'s ${exception.owner_script} ` +
					`carries --min-tests ${real.min_tests} --min-ran-tests ${real.min_ran_tests} - update the recorded exception ` +
					`(the policy floors for this row are --min-tests ${floorFor(recorded.collected, reading.floor_ratio)} ` +
					`--min-ran-tests ${floorFor(recorded.ran, reading.floor_ratio)})`,
			);
		}
		const wantShare =
			`${((100 * real.min_tests) / recorded.collected).toFixed(1)}%/` +
			`${((100 * real.min_ran_tests) / recorded.ran).toFixed(1)}%`;
		if (exception.policy_share !== wantShare) {
			out.push(
				`${exception.name}: the recorded share ${exception.policy_share} is not what the numbers are (${wantShare})`,
			);
		}
	}
	return out;
}

/** The module's own values, read through the CLI the shell mirror uses rather than by import. */
function smokeConfig(): {
	floors: Record<string, number>;
	tag_skip_ledger: string;
	tag_skip_entries: { count: number }[];
} {
	const result = spawnSync(process.execPath, [smokeModulePath, "--json"], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`node scripts/lib/ci-process-smoke.mjs --json exited ${result.status}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as ReturnType<typeof smokeConfig>;
}

const asMutable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the ci.yml floors are derived from the recorded CI reading, not from memory", () => {
	it("records which run the floors came from, and a sha this repository has", () => {
		const reading = readings();
		expect(reading.floor_ratio).toBe(0.9);
		expect(reading.source.run_id).toBe(35341768020);
		expect(reading.source.run_url).toContain(String(reading.source.run_id));
		// The reading and the tree it gates must be the same tree: the sha is the base of this work.
		const known = spawnSync("git", ["cat-file", "-e", `${reading.source.head_sha}^{commit}`], { cwd: repoRoot });
		expect(known.status, `${reading.source.head_sha} is not a commit in this repository`).toBe(0);
	});

	it("carries exactly ceil(0.9 * reading) in every row whose floors live in ci.yml", () => {
		const mismatches = floorMismatches(workflowRows(), readings());
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});

	it("keeps every gated row at or above the policy share, row by row", () => {
		const reading = readings();
		const rows = workflowRows();
		const below: string[] = [];
		for (const recorded of reading.rows) {
			if (!recorded.floors_owner.includes(CI_OWNER)) continue;
			const row = rowNamed(rows, recorded.name);
			const testsShare = (100 * Number(row?.min_tests)) / recorded.collected;
			const ranShare = (100 * Number(row?.min_ran_tests)) / recorded.ran;
			if (!(testsShare >= 100 * reading.floor_ratio) || !(ranShare >= 100 * reading.floor_ratio)) {
				below.push(`${recorded.name}: min_tests ${testsShare.toFixed(1)}% / min_ran_tests ${ranShare.toFixed(1)}%`);
			}
		}
		expect(below, below.join("\n")).toEqual([]);
	});

	it("decides what gates every matrix row: a reading, or a written reason for none", () => {
		const reading = readings();
		const rows = workflowRows();
		const undecided: string[] = [];
		const gated = new Set([...reading.rows.map((row) => row.name), ...reading.ungated_rows.map((row) => row.name)]);
		for (const row of rows) {
			const name = String(row.name);
			if (!gated.has(name)) undecided.push(`${name}: neither a reading nor an ungated_rows reason`);
			const recorded = reading.rows.find((entry) => entry.name === name);
			const carriesReport = Boolean(row.report) || Boolean(row.node_test_report);
			if (recorded !== undefined && !carriesReport && recorded.floors_owner.includes(CI_OWNER)) {
				undecided.push(`${name}: ci.yml owns its floors but the row produces no report to gate`);
			}
			if (
				recorded?.floors_owner.startsWith(CI_OWNER) &&
				!recorded.note &&
				recorded.nothing_files > recorded.max_nothing_budget
			) {
				undecided.push(
					`${name}: ${recorded.nothing_files} nothing-file(s) over a budget of ${recorded.max_nothing_budget}, unexplained`,
				);
			}
		}
		expect(undecided, undecided.join("\n")).toEqual([]);
	});

	it("pins the process smoke row to the module the local mirror also reads, field for field", () => {
		const config = smokeConfig();
		const reading = readings();
		const mismatches = smokeMismatches(
			workflowRows(),
			config,
			reading.rows.find((row) => row.name === "coding-agent process smoke"),
		);
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});

	it("agrees with the module through the --shell surface the mirror parses, not just --json", () => {
		const lines = spawnSync(process.execPath, [smokeModulePath, "--shell"], { encoding: "utf8" });
		expect(lines.status).toBe(0);
		const values = new Map(
			lines.stdout
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const at = line.indexOf("=");
					return [line.slice(0, at), line.slice(at + 1)] as const;
				}),
		);
		const config = smokeConfig();
		expect(Number(values.get("MIN_TESTS"))).toBe(config.floors.min_tests);
		expect(Number(values.get("MIN_RAN_TESTS"))).toBe(config.floors.min_ran_tests);
		expect(Number(values.get("MAX_NOTHING_FILES"))).toBe(config.floors.max_nothing_files);
		expect(values.get("LEDGER")).toBe(config.tag_skip_ledger);
		const row = rowNamed(workflowRows(), "coding-agent process smoke");
		expect(row?.min_tests).toBe(config.floors.min_tests);
		expect(row?.tag_skip_ledger).toBe(config.tag_skip_ledger);
	});

	it("writes down every row whose floors live in another file, with that file's real numbers", () => {
		const reading = readings();
		// "Elsewhere" means the row has no floor in ci.yml at all; a row mirrored into ci.yml is
		// ci.yml's own (the process smoke row is both - the floor test covers it from either side).
		const elsewhere = reading.rows.filter((row) => !row.floors_owner.includes(CI_OWNER));
		expect(elsewhere.length).toBeGreaterThan(0);
		const undocumented = elsewhere
			.filter((row) => !reading.exceptions.some((exception) => exception.name === row.name))
			.map((row) => `${row.name}: floors live in ${row.floors_owner} but no exception records them`);
		expect(undocumented, undocumented.join("\n")).toEqual([]);
		const mismatches = exceptionMismatches(reading);
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});
});

describe("the floor pin can go red (planted mutations, same comparison functions)", () => {
	const plantedRow = (rows: MatrixRow[], name: string, key: string, value: unknown): MatrixRow[] => {
		const mutant = asMutable(rows);
		const row = rowNamed(mutant, name);
		if (row === undefined) throw new Error(`no row ${name}`);
		row[key] = value;
		return mutant;
	};

	it("is red when a ci.yml floor is one below the reading", () => {
		const rows = workflowRows();
		const reading = readings();
		const baseline = rowNamed(rows, "ai");
		const mutant = plantedRow(rows, "ai", "min_tests", Number(baseline?.min_tests) - 1);
		const mismatches = floorMismatches(mutant, reading);
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches.join("\n")).toContain("min_tests=1228");
	});

	it("is red when a ran floor is one below the reading", () => {
		const rows = plantedRow(workflowRows(), "coding-agent 2/3", "min_ran_tests", 2796);
		const mismatches = floorMismatches(rows, readings());
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches.join("\n")).toContain("min_ran_tests=2796");
	});

	it("is red when the reading grows and the floor does not follow", () => {
		const reading = readings();
		const mutant = asMutable(reading);
		const row = mutant.rows.find((entry) => entry.name === "agent-core");
		if (row === undefined) throw new Error("no agent-core reading");
		row.collected += 100;
		row.ran += 100;
		const mismatches = floorMismatches(workflowRows(), mutant);
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches.join("\n")).toContain("ceil(0.9 * 208) = 188");
	});

	it("is red when a matrix row loses its reading", () => {
		const mutant = asMutable(readings());
		mutant.rows = mutant.rows.filter((entry) => entry.name !== "tui");
		expect(floorMismatches(workflowRows(), mutant).join("\n")).toContain("tui: the workflow row has no reading");
	});

	it("is red when the ci.yml smoke row and the module disagree", () => {
		const config = smokeConfig();
		const recorded = readings().rows.find((row) => row.name === "coding-agent process smoke");
		const mutant = plantedRow(workflowRows(), "coding-agent process smoke", "min_tests", config.floors.min_tests + 1);
		expect(smokeMismatches(mutant, config, recorded).join("\n")).toContain(
			"scripts/lib/ci-process-smoke.mjs exports min_tests",
		);
	});

	it("is red when the module's floor moves away from the row", () => {
		const config = asMutable(smokeConfig());
		config.floors.min_ran_tests += 1;
		const recorded = readings().rows.find((row) => row.name === "coding-agent process smoke");
		expect(smokeMismatches(workflowRows(), config, recorded).join("\n")).toContain("exports min_ran_tests");
	});

	it("is red when the module's declared skips stop accounting for collected-ran", () => {
		const config = asMutable(smokeConfig());
		config.tag_skip_entries[0].count += 1;
		config.tag_skip_ledger = config.tag_skip_ledger.replace(
			"daemon-supervisor-process.test.ts=8",
			"daemon-supervisor-process.test.ts=9",
		);
		const row = rowNamed(workflowRows(), "coding-agent process smoke");
		if (row === undefined) throw new Error("no smoke row");
		row.tag_skip_ledger = config.tag_skip_ledger;
		const recorded = readings().rows.find((entry) => entry.name === "coding-agent process smoke");
		expect(smokeMismatches(workflowRows(), config, recorded).join("\n")).toContain("declares 13 skip(s)");
	});

	it("is red when an exception's recorded numbers stop matching the owner file", () => {
		const mutant = asMutable(readings());
		const exception = mutant.exceptions[0];
		if (exception === undefined) throw new Error("no exception recorded");
		exception.owner_flags.min_tests += 1;
		expect(exceptionMismatches(mutant).join("\n")).toContain("update the recorded exception");
	});

	it("counts the floor the way the policy does, including the exact products", () => {
		// 10 * 0.9 is 9.000000000000002 in binary floating point: a naive Math.ceil would ask for
		// 10 where the policy asks for 9, and every row with a round product would be over-floored.
		const cases: [number, number, number][] = [
			[10, 0.9, 9],
			[24, 0.9, 22],
			[6, 0.9, 6],
			[1365, 0.9, 1229],
			[643, 0.9, 579],
			[2720, 0.9, 2448],
			[52, 0.9, 47],
			[43, 0.9, 39],
		];
		for (const [value, ratio, want] of cases) {
			expect(floorFor(value, ratio), `floorFor(${value}, ${ratio})`).toBe(want);
		}
	});
});
