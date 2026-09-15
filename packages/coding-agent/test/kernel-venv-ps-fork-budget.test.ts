import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readKernelVenvInUseState,
	recordKernelVenvInUseSync,
	VENV_IN_USE_DIR_NAME,
} from "../src/core/kernel/venv-in-use.js";

// R31-9 / RC-4: one read of a generation's in-use state must not fork one `ps`
// helper process per live reference. The real cost is ~55ms of synchronous
// execFileSync per reference on macOS/BSD, paid on every kernel boot by
// pruneKernelVenvGenerations, so the probe counts every helper invocation the
// read performs (synchronous and asynchronous) while the reference records
// point at live holder processes.
const psCalls = vi.hoisted(() => ({ synchronous: 0, asynchronous: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: ((command: string, args: string[], options?: object) => {
			if (command === "ps") psCalls.synchronous++;
			return actual.execFileSync(command, args, options);
		}) as typeof actual.execFileSync,
		execFile: ((
			command: string,
			args: string[],
			options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			if (command === "ps") psCalls.asynchronous++;
			return actual.execFile(command, args, options, callback);
		}) as unknown as typeof actual.execFile,
	};
});

const holders: ChildProcess[] = [];
const venvs: string[] = [];

afterEach(() => {
	for (const holder of holders.splice(0)) {
		holder.kill("SIGKILL");
	}
	for (const directory of venvs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function venv(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-venv-ps-budget-"));
	venvs.push(directory);
	mkdirSync(join(directory, VENV_IN_USE_DIR_NAME), { recursive: true });
	return directory;
}

/** A pid that existed a moment ago and is reaped now: never a live reference holder. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	const pid = Number.parseInt(result.stdout.trim(), 10);
	expect(Number.isInteger(pid) && pid > 0).toBe(true);
	return pid;
}

function spawnHolder(): ChildProcess {
	const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
	holders.push(holder);
	return holder;
}

function referenceRecord(pid: number, processStartId?: string): string {
	return `${JSON.stringify({
		version: 1,
		pid,
		...(processStartId !== undefined ? { processStartId } : {}),
		recordedAt: new Date().toISOString(),
	})}\n`;
}

describe("kernel venv in-use ps fork budget", () => {
	it("resolves 27 live references with O(1) helper-process invocations", async () => {
		const directory = venv();
		const live: number[] = [];
		for (let index = 0; index < 27; index++) {
			const holder = spawnHolder();
			await new Promise<void>((resolveSpawn) => holder.once("spawn", resolveSpawn));
			live.push(holder.pid!);
			recordKernelVenvInUseSync(directory, { pid: holder.pid! });
		}
		expect(readdirSync(join(directory, VENV_IN_USE_DIR_NAME))).toHaveLength(27);

		psCalls.synchronous = 0;
		psCalls.asynchronous = 0;
		const state = await readKernelVenvInUseState(directory, { sweepStale: false });

		// Positive control: every live holder is still judged live with its recorded
		// identity, so a batched resolution must have produced real identities.
		expect(state.references.map((reference) => reference.pid).sort((a, b) => a - b)).toEqual(
			[...live].sort((a, b) => a - b),
		);
		expect(state.unknown).toBe(false);
		expect(psCalls.synchronous + psCalls.asynchronous).toBeLessThanOrEqual(1);
	});

	it("still judges a dead pid and a replaced identity as not live", async () => {
		const directory = venv();
		const inUse = join(directory, VENV_IN_USE_DIR_NAME);
		const holder = spawnHolder();
		await new Promise<void>((resolveSpawn) => holder.once("spawn", resolveSpawn));
		const livePid = holder.pid!;
		const dead = deadPid();
		writeFileSync(join(inUse, String(livePid)), referenceRecord(livePid, "ps:replaced-identity"));
		writeFileSync(join(inUse, String(dead)), referenceRecord(dead, "ps:dead-holder"));

		psCalls.synchronous = 0;
		psCalls.asynchronous = 0;
		const state = await readKernelVenvInUseState(directory, { sweepStale: false });

		// Dead pid stays dead (no helper process needed), and a live pid whose
		// recorded identity moved on is stale, not live.
		expect(state.references).toEqual([]);
		expect(state.unknown).toBe(false);
		expect(psCalls.synchronous + psCalls.asynchronous).toBeLessThanOrEqual(1);
	});
});
