/**
 * Out-of-process reproductions of the `waitForIdle` spin deadlock
 * (docs/fork/audit-20260919-findings.md: "主案" + "复现双证").
 *
 * Why a subprocess: before the fix, `_waitForIdleOrSettlement` loops on promises that
 * are already settled, so the loop never returns to the event loop. Every timer in the
 * process starves - including vitest's own test timeout - which would hang a shard
 * instead of failing it. Here the runner stays alive to observe the starvation, report
 * it, and kill the child.
 *
 * Two modes, one per stranded shape. Both are built from public API plus one documented
 * seam each; no private member is probed.
 *
 *   orphan  A turn the pump selected but refused to dispatch, stranded in `selected`
 *           while a real `executeBash` holds the pump busy. `selected` is not `queued`,
 *           so the idle waiter's park (which reads `queuedActions()`) never engages and
 *           the loop reschedules a pump that immediately blocks again. The seam: the
 *           agent's own idle wait is held at the pump's first await so the bash starts
 *           inside the window between admission and the pump's block check - without
 *           the hold that interleaving is a race.
 *
 *   leak    A dispatched turn whose primary reached the transcript and whose dispatch
 *           then failed while a queued-work pause made the pump classify the failure as
 *           deferred. The deferred path only rolled undelivered work back, and
 *           `CLEARABLE_STATES` is {queued, selected, preparing}, so nothing - not even
 *           `dispose()` - could ever reach the stranded `committing` action. The seam:
 *           `agent.prompt` is replaced on the instance with "deliver, then fail".
 *
 * Exit codes: 0 = waitForIdle returned while timers kept firing, 2 = it never returned
 * while timers still fired, 3 = the fixture could not reach the stranded state.
 * Starvation shows up as silence: no `beat` line after `ready`, and no exit at all.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "../suite/harness.js";

type FixtureLine =
	| { stage: "ready"; mode: string; queued: number; unfinished: number; streaming: boolean; bash: boolean }
	| { stage: "beat"; ticks: number }
	| {
			stage: "returned";
			ms: number;
			ticks: number;
			unfinished: number;
			queued: number;
			bash: boolean;
			streaming: boolean;
	  }
	| { stage: "never-returned"; ticks: number; unfinished: number; queued: number; bash: boolean; streaming: boolean }
	| { stage: "error"; message: string };

function say(line: FixtureLine): void {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(10);
	}
	return predicate();
}

const quietSettings = { stallWatchdog: { enabled: false }, retry: { enabled: false } } as const;

/**
 * The orphan shape: a `selected` turn the pump refused to dispatch, plus a real bash
 * holding the pump busy for a few seconds. Once the bash ends the turn must dispatch and
 * the wait must return - a wedged loop cannot even notice the bash ended, because
 * noticing is an event-loop turn.
 */
async function strandSelectedOrphan(harness: Harness): Promise<string | undefined> {
	const agent = harness.session.agent;
	let releasePump: () => void = () => {};
	const pumpHold = new Promise<void>((resolve) => {
		releasePump = resolve;
	});
	// Hold the pump at its own first await so the bash below lands inside the window
	// between admission (which selects the action) and the pump's block check.
	agent.waitForIdle = () => pumpHold;
	harness.setResponses([fauxAssistantMessage("turn done")]);

	void harness.session.prompt("stranded turn").catch(() => {});
	if (!(await waitFor(() => harness.session.unfinishedActionCount > 0, 10_000))) {
		return "the prompt never became a session action";
	}
	// Let the pump reach the held await.
	await sleep(100);

	void harness.session.executeBash("sleep 3").catch(() => {});
	if (!(await waitFor(() => harness.session.isBashRunning, 10_000))) {
		return "the bash command never started";
	}
	// From here the agent is idle as far as anybody can tell; only the bash blocks.
	agent.waitForIdle = () => Promise.resolve();
	releasePump();
	if (!(await waitFor(() => harness.session.queuedActionCount === 0, 10_000))) {
		return "the stranded action is still counted as queued";
	}
	if (harness.session.unfinishedActionCount === 0) {
		return "the stranded action reached a terminal state before the wait started";
	}
	return undefined;
}

/** The leak shape: a delivered dispatch that failed while the pump was deferred. */
async function strandDeliveredCommit(harness: Harness): Promise<string | undefined> {
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
		agent.state.messages.push(...delivered);
		// A concurrent pause bumps the pump epoch, which is what makes the failure
		// "deferred" instead of terminal.
		pause = harness.session.acquireQueuedWorkPause();
		throw new Error("injected dispatch failure after delivery");
	};
	harness.setResponses([fauxAssistantMessage("never reached")]);

	const dispatched = harness.session.prompt("dispatched turn");
	dispatched.catch(() => {});
	if (!(await waitFor(() => harness.session.messages.some((message) => message.role === "user"), 10_000))) {
		return "the dispatch never reached the transcript";
	}
	await sleep(100);
	pause?.release();
	// Before the fix this is where the action stranded for good; after it the deferred
	// path terminalizes the delivered batch, so "nothing stranded" is the healthy outcome
	// and the wait below has to return at once.
	await waitFor(() => harness.session.unfinishedActionCount > 0, 1_000);
	return undefined;
}

async function main(): Promise<number> {
	const mode = process.argv[2] === "leak" ? "leak" : "orphan";
	const harness = await createHarness({ settings: { ...quietSettings } });
	const setupFailure = mode === "leak" ? await strandDeliveredCommit(harness) : await strandSelectedOrphan(harness);
	if (setupFailure) {
		say({ stage: "error", message: `${mode}: ${setupFailure}` });
		return 3;
	}

	say({
		stage: "ready",
		mode,
		queued: harness.session.queuedActionCount,
		unfinished: harness.session.unfinishedActionCount,
		streaming: harness.session.isStreaming,
		bash: harness.session.isBashRunning,
	});

	let ticks = 0;
	const beat = setInterval(() => {
		ticks += 1;
		say({ stage: "beat", ticks });
	}, 200);
	const startedAt = Date.now();
	const returned = harness.session.waitForIdle().then(() => "returned" as const);
	const gaveUp = sleep(20_000).then(() => "never-returned" as const);
	const outcome = await Promise.race([returned, gaveUp]);
	clearInterval(beat);
	if (outcome === "returned") {
		say({
			stage: "returned",
			ms: Date.now() - startedAt,
			ticks,
			unfinished: harness.session.unfinishedActionCount,
			queued: harness.session.queuedActionCount,
			bash: harness.session.isBashRunning,
			streaming: harness.session.isStreaming,
		});
		harness.cleanup();
		return 0;
	}
	say({
		stage: "never-returned",
		ticks,
		unfinished: harness.session.unfinishedActionCount,
		queued: harness.session.queuedActionCount,
		bash: harness.session.isBashRunning,
		streaming: harness.session.isStreaming,
	});
	return 2;
}

main().then(
	(code) => {
		process.exit(code);
	},
	(error: unknown) => {
		say({ stage: "error", message: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	},
);
