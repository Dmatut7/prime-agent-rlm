/**
 * The 2026-09-19 spin deadlock (docs/fork/audit-20260919-findings.md): a worker burned
 * 100% CPU for 40+ minutes inside `_waitForIdleOrSettlement`, and every RPC against it
 * timed out because the loop starved its own event loop.
 *
 * Three defects, four needles:
 *
 * 1. `waitForIdle` looped on promises that were already settled whenever an action
 *    stayed unfinished with nothing left to pump, so the loop never returned to the
 *    macrotask queue: timers, IO and the teardown that would have cleared the state all
 *    starved. The loop now yields a macrotask every cycle, paces that yield down to a
 *    poll once a cycle stops making progress, and gives up with an error log when
 *    nothing that owns the wait is in flight. Pinned out of process
 *    (test/fixtures/wait-for-idle-spin-fixture.ts) because the pre-fix spin starves the
 *    runner's own test timeout - and pinned twice, once per stranded shape.
 * 2. `_disposeAsyncOnce` awaited child-session and kernel teardown before the
 *    synchronous `dispose()` that clears the queue, and that teardown can need the IO
 *    the spinning waiter was starving - a self-locking chain. The queue is now settled
 *    first, so a waiter is released before any teardown await.
 * 3. The pump's deferred-error path only rolled *undelivered* work back. A batch whose
 *    primary had already reached the transcript stayed in `committing` forever:
 *    `CLEARABLE_STATES` is {queued, selected, preparing}, so not even `dispose()` can
 *    reach it, and `unfinishedActionCount` pinned every idle wait, RLM quiescence check
 *    and eviction decision behind it. Delivered work is now terminalized, the way the
 *    abort path already does it.
 *
 * Fault injection is at public seams only (an agent method replaced on the instance, a
 * real child session with a wedged `disposeAsync`); no private member is probed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { createHarness, type Harness } from "../harness.js";

const fixturePath = resolve(__dirname, "../../fixtures/wait-for-idle-spin-fixture.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");

/**
 * No `beat` line for this long after `ready` means the loop is starving its timers: the
 * fixture bounds its own wait well inside this (it reports `never-returned` and exits
 * after 20s of a settled-but-hung wait), so silence can only mean starvation.
 */
const STARVATION_SILENCE_MS = 5_000;
const FIXTURE_EXIT_BOUND_MS = 90_000;

type FixtureLine = {
	stage: string;
	ticks?: number;
	ms?: number;
	queued?: number;
	unfinished?: number;
	bash?: boolean;
	streaming?: boolean;
	mode?: string;
	message?: string;
};

type FixtureVerdict = {
	outcome: "exited" | "starved" | "hard-timeout";
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	lines: FixtureLine[];
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => {
		setTimeout(resolveSleep, ms);
	});
}

function fixtureEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Subagent sessions leak their own routing keys into every child they spawn; an
	// unsanitized fixture would write session leases and journals into the real
	// ~/.prime/agent (see the shared-worktree discipline in AGENTS.md).
	for (const key of Object.keys(env)) {
		if (key.startsWith("RLM_") || key.startsWith("PRIME_AGENT_") || key.startsWith("PI_")) {
			delete env[key];
		}
	}
	env.TSX_TSCONFIG_PATH = repoTsconfigPath;
	env.DO_NOT_TRACK = "1";
	env[ENV_AGENT_DIR] = agentDir;
	return env;
}

function parseLines(stdout: string): FixtureLine[] {
	return stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as FixtureLine];
			} catch {
				return [];
			}
		});
}

async function runFixture(mode: "orphan" | "leak", agentDir: string): Promise<FixtureVerdict> {
	const child = spawn(process.execPath, [tsxPath, fixturePath, mode], {
		env: fixtureEnvironment(agentDir),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});

	const startedAt = Date.now();
	let readyAt: number | undefined;
	let lastBeatAt = Date.now();
	let lastTicks = 0;
	let outcome: FixtureVerdict["outcome"] = "hard-timeout";
	let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	while (Date.now() - startedAt < FIXTURE_EXIT_BOUND_MS) {
		const done = await Promise.race([exited.then((result) => result), sleep(200).then(() => undefined)]);
		const lines = parseLines(stdout);
		if (readyAt === undefined && lines.some((line) => line.stage === "ready")) {
			readyAt = Date.now();
			lastBeatAt = readyAt;
		}
		const ticks = lines.reduce((latest, line) => (line.stage === "beat" ? (line.ticks ?? 0) : latest), 0);
		if (ticks > lastTicks) {
			lastTicks = ticks;
			lastBeatAt = Date.now();
		}
		if (done) {
			exit = done;
			outcome = "exited";
			break;
		}
		if (readyAt !== undefined && Date.now() - lastBeatAt > STARVATION_SILENCE_MS) {
			outcome = "starved";
			break;
		}
	}
	if (outcome !== "exited") child.kill("SIGKILL");
	exit = exit ?? (await Promise.race([exited, sleep(5_000).then(() => null)]));
	return {
		outcome,
		code: exit?.code ?? null,
		signal: exit?.signal ?? null,
		stdout,
		stderr,
		lines: parseLines(stdout),
	};
}

function describeVerdict(verdict: FixtureVerdict): string {
	return `fixture ${verdict.outcome} (code=${verdict.code} signal=${verdict.signal})\nstdout:\n${verdict.stdout}\nstderr:\n${verdict.stderr.slice(0, 2000)}`;
}

describe("waitForIdle spin deadlock (audit 2026-09-19)", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	const quietSettings = { stallWatchdog: { enabled: false }, retry: { enabled: false } } as const;

	async function expectNoStarvation(mode: "orphan" | "leak"): Promise<void> {
		const agentDir = mkdtempSync(join(tmpdir(), "spin-fixture-agent-dir-"));
		tempDirs.push(agentDir);
		const verdict = await runFixture(mode, agentDir);
		const setupFailure = verdict.lines.find((line) => line.stage === "error");
		expect(setupFailure, describeVerdict(verdict)).toBeUndefined();
		expect(verdict.outcome, describeVerdict(verdict)).toBe("exited");
		expect(verdict.code, describeVerdict(verdict)).toBe(0);
		const ready = verdict.lines.find((line) => line.stage === "ready");
		const returned = verdict.lines.find((line) => line.stage === "returned");
		expect(returned, describeVerdict(verdict)).toBeDefined();
		// A wait that ran while work was stranded must have stayed on the event loop the
		// whole way: a heartbeat that kept ticking is the proof. (In `leak` mode the fixed
		// pump settles the batch, so nothing is stranded and the wait returns at once -
		// that is the healthy outcome, not a missed reproduction.)
		if ((ready?.unfinished ?? 0) > 0) {
			expect(returned?.ticks ?? 0, describeVerdict(verdict)).toBeGreaterThan(0);
		}
		if (mode === "leak") {
			// The delivered dispatch is terminal work: it must not outlive the wait.
			expect(returned?.unfinished ?? 1, describeVerdict(verdict)).toBe(0);
		}
	}

	it("keeps the event loop alive for a turn stranded in `selected` behind a running bash", {
		timeout: 120_000,
	}, async () => {
		await expectNoStarvation("orphan");
	});

	it("keeps the event loop alive for a delivered dispatch stranded by a deferred failure", {
		timeout: 120_000,
	}, async () => {
		await expectNoStarvation("leak");
	});

	it("terminalizes a dispatched turn whose deferred failure landed after delivery", { timeout: 30_000 }, async () => {
		const harness = track(await createHarness({ settings: { ...quietSettings } }));
		const agent = harness.session.agent;
		const realPrompt = agent.prompt.bind(agent);
		let pause: { release(): void } | undefined;
		let armed = true;
		agent.prompt = async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> => {
			if (typeof input === "string") {
				return realPrompt(input, images);
			}
			if (!armed) {
				return realPrompt(input);
			}
			armed = false;
			const delivered = Array.isArray(input) ? input : [input];
			// The dispatch reached the transcript and then failed, while a queued-work
			// pause made the pump classify the failure as deferred (the epoch bump is
			// what `_isDeferredSessionInputError` keys on).
			agent.state.messages.push(...delivered);
			pause = harness.session.acquireQueuedWorkPause();
			throw new Error("injected dispatch failure after delivery");
		};
		harness.setResponses([fauxAssistantMessage("never reached")]);

		const dispatched = harness.session.prompt("dispatched turn");
		dispatched.catch(() => {});

		await vi.waitFor(
			() => {
				expect(harness.session.messages.some((message) => message.role === "user")).toBe(true);
				expect(harness.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 8_000, interval: 20 },
		);

		expect(harness.session.hasPendingSessionWork).toBe(false);
		pause?.release();
		await sleep(50);
		// A released pause must not resurrect the stranded action either.
		expect(harness.session.unfinishedActionCount).toBe(0);
	});

	it("settles queued work at the start of disposeAsync, before a wedged child teardown", {
		timeout: 30_000,
	}, async () => {
		const child = track(await createHarness({ settings: { ...quietSettings } }));
		// The child stays mid-turn, so no terminal notice reaches the parent.
		child.setResponses([
			async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
				await new Promise<void>((resolve) => {
					const signal = options?.signal;
					if (!signal) return;
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("child done");
			},
		]);
		// The production wedge: the child's async teardown needs IO that the parent's own
		// teardown is waiting on, so `_disposeAsyncOnce` never reaches the synchronous
		// `dispose()` that used to be its last step.
		child.session.disposeAsync = () => new Promise<void>(() => {});

		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				settings: { ...quietSettings },
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		await parent.session.runRlmChild("wedge task", { name: "wedged-child" });
		const pause = parent.session.acquireQueuedWorkPause();
		await parent.session.followUp("queued work");
		expect(parent.session.unfinishedActionCount).toBeGreaterThan(0);

		void parent.session.disposeAsync().catch(() => {});

		await vi.waitFor(
			() => {
				expect(parent.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 8_000, interval: 20 },
		);
		expect(parent.session.hasPendingSessionWork).toBe(false);
		pause.release();
	});
});
