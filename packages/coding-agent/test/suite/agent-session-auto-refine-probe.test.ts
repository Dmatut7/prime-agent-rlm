import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHarnessStatePath } from "../../src/core/refinement/refinement.js";
import { createHarness, type Harness } from "./harness.js";

type SessionWithRefineProbe = {
	_autoRefineAllowedForSession(): boolean;
	_localHarnessStateDir(): string | undefined;
	_autoRefineWritableProbe: { at: number; allowed: boolean } | undefined;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_rlmDepth: number;
};

/**
 * The depth is seeded by rootRlmDepthFromEnv() from process.env.RLM_DEPTH, so running
 * inside an agent worker shell makes every harness session a depth-1 child, and
 * _autoRefineAllowedForSession() returns false at the depth gate (agent-session.ts
 * _rlmDepth !== 0). Pinning _rlmDepth = 0 here keeps this nail independent of the
 * runner environment; under a clean environment it is a no-op.
 */
function rootSession(harness: Harness): SessionWithRefineProbe {
	const internals = harness.session as unknown as SessionWithRefineProbe;
	internals._rlmDepth = 0;
	return internals;
}

/**
 * The probe runs on the session event queue and loads the whole local harness
 * store, so the claim "this is cheaper now" is a call count, not a timing.
 * Counting does not mock behaviour: the real implementation still runs.
 */
describe("_autoRefineAllowedForSession probe cost", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resolves the harness directory once per call and caches the verdict for the TTL", async () => {
		// A persisted session, so there is an artifact directory and therefore a local
		// harness state dir; without one the method returns before probing anything.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = rootSession(harness);
		expect(internals._localHarnessStateDir()).toBeTypeOf("string");

		const spy = vi.spyOn(internals, "_localHarnessStateDir");
		const first = internals._autoRefineAllowedForSession();
		const second = internals._autoRefineAllowedForSession();
		const third = internals._autoRefineAllowedForSession();

		expect([second, third]).toEqual([first, first]);
		// One call for the first (uncached) probe, then the TTL serves the rest.
		// Before the fix this was two calls per invocation and no cache at all.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(internals._autoRefineWritableProbe).toBeDefined();
	});

	it("serves the cached verdict within the TTL instead of re-probing", async () => {
		// The call-count nail above would still pass for an implementation that caches the
		// resolved directory but re-loads and re-asserts the store on every call, which is
		// where most of the cost lives. This nails the verdict itself being reused.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = rootSession(harness);
		const dir = internals._localHarnessStateDir();
		expect(dir).toBeTypeOf("string");
		const statePath = getHarnessStatePath(dir as string);

		// A fresh persisted session has no state file yet, and a missing file loads as an
		// empty store, which is writable.
		expect(internals._autoRefineAllowedForSession()).toBe(true);

		try {
			// Break the state file, not its directory: loadHarnessState validates the
			// directory shape first and lstats the state file second, where a symlink is
			// refused as a non-regular private file. A dangling link is enough, because
			// lstat reports the link itself instead of following it.
			// The harness directory is only created on first write, so make it here; the
			// directory shape check runs before the file lstat and wants a 0700 directory.
			mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
			rmSync(statePath, { force: true });
			symlinkSync("nowhere", statePath);

			// Still allowed: the TTL is serving the cached verdict rather than re-probing.
			expect(internals._autoRefineAllowedForSession()).toBe(true);

			// Positive control: the break above is real, so once the cache is dropped the
			// same shape has to be detected. Without this, the assertion above could pass
			// merely because replacing the file changed nothing.
			await internals._invalidatePendingAutoRefineForBranchChange();
			expect(internals._autoRefineAllowedForSession()).toBe(false);
		} finally {
			// Leave no dangling link behind, or harness cleanup can trip over it.
			rmSync(statePath, { force: true });
		}
	});

	it("re-probes after the cache is invalidated", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = rootSession(harness);

		internals._autoRefineAllowedForSession();
		expect(internals._autoRefineWritableProbe).toBeDefined();

		await internals._invalidatePendingAutoRefineForBranchChange();
		expect(internals._autoRefineWritableProbe).toBeUndefined();

		const spy = vi.spyOn(internals, "_localHarnessStateDir");
		internals._autoRefineAllowedForSession();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
