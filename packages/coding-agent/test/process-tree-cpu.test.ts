import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	explicitTimeoutMs,
	parseCpuTime,
	parsePsSnapshot,
	readProcessTreeCpuMs,
} from "../src/core/process-tree-cpu.js";

describe("parseCpuTime", () => {
	it.each([
		["0:01.50", 1_500],
		["1:02.25", 62_250],
		["00:00:03", 3_000],
		["01:00:00", 3_600_000],
		["2-00:00:01", 172_801_000],
		["4.5", 4_500],
	])("reads %s", (value, ms) => {
		expect(parseCpuTime(value)).toBe(ms);
	});

	it("rejects junk", () => {
		expect(parseCpuTime("TIME")).toBeUndefined();
		expect(parseCpuTime("1:2:3:4")).toBeUndefined();
	});
});

describe("readProcessTreeCpuMs", () => {
	const snapshot = [
		"  1     0  0:10.00",
		" 50     1  0:01.00",
		" 60    50  0:02.00",
		" 61    60  0:00.50",
		" 70     1  0:09.00",
		"garbage line",
	].join("\n");

	it("sums a root and all its descendants", () => {
		expect(parsePsSnapshot(snapshot)).toHaveLength(5);
		expect(readProcessTreeCpuMs([50], () => snapshot)).toBe(3_500);
		expect(readProcessTreeCpuMs([50, 60], () => snapshot)).toBe(3_500);
		expect(readProcessTreeCpuMs([60, 70], () => snapshot)).toBe(11_500);
	});

	it("is undefined when ps fails or no root runs", () => {
		expect(
			readProcessTreeCpuMs([50], () => {
				throw new Error("ps missing");
			}),
		).toBeUndefined();
		expect(readProcessTreeCpuMs([999], () => snapshot)).toBeUndefined();
		expect(readProcessTreeCpuMs([], () => snapshot)).toBeUndefined();
	});

	const hasPython = process.platform !== "win32" && spawnSync("python3", ["-c", "pass"]).status === 0;

	it.skipIf(!hasPython)(
		"sees a silent busy loop burning CPU",
		async () => {
			// The child burns a fixed budget of *process* CPU, not wall time: under a
			// starved CI runner the burn stretches in wall time instead of shrinking
			// the reading, which is what made a fixed sleep + accrued-CPU threshold
			// flake. The reader only has to keep up with 2s of burn.
			const child = spawn(
				"python3",
				["-c", "import time\nend=time.process_time()+2\nwhile time.process_time()<end: pass"],
				{
					stdio: "ignore",
				},
			);
			let childExited = false;
			child.once("exit", () => {
				childExited = true;
			});
			try {
				const pid = child.pid as number;
				let baseline: number | undefined;
				// State barrier: the child is alive and visible in a ps snapshot.
				const startedAt = Date.now();
				while (baseline === undefined) {
					if (Date.now() - startedAt > 10_000) {
						throw new Error("Timed out waiting for the busy-loop child to appear in ps");
					}
					baseline = readProcessTreeCpuMs([pid]);
					if (baseline === undefined) {
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				}
				// State barrier: the reading advances with the burn. 700ms of accrued
				// CPU is far below what the child accrues before exiting (~2s), so a
				// working reader reaches it no matter how the scheduler slices.
				let gained = 0;
				while (gained < 700 && !childExited) {
					const reading = readProcessTreeCpuMs([pid]);
					if (reading !== undefined) {
						gained = reading - baseline;
					}
					if (gained < 700) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				}
				expect(
					childExited,
					`reader kept up with the burn: only ${gained}ms CPU seen before the 2s burn ended`,
				).toBe(false);
				expect(gained).toBeGreaterThanOrEqual(700);
			} finally {
				child.kill("SIGKILL");
			}
		},
		60_000,
	);
});

describe("explicitTimeoutMs", () => {
	it.each([
		[{ code: "r = await bash('pytest', timeout=900)" }, 900_000],
		[{ code: "subprocess.run(cmd, timeout=1200.5)" }, 1_200_500],
		[{ command: "timeout 600 make -j8" }, 600_000],
		[{ command: "timeout -k 5 10m ./job" }, 600_000],
		[{ command: "pytest --timeout=300" }, 300_000],
		[{ command: "ls", timeout: 120 }, 120_000],
		[{ code: "snap = await rlm.collect(timeout_ms=600000)" }, 600_000],
	])("reads %j", (args, ms) => {
		expect(explicitTimeoutMs(args)).toBe(ms);
	});

	it("is undefined without a timeout", () => {
		expect(explicitTimeoutMs({ command: "npm test" })).toBeUndefined();
		expect(explicitTimeoutMs(undefined)).toBeUndefined();
	});
});
