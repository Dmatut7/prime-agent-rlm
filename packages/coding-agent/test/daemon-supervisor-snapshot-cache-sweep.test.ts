import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * #4. `snapshotCacheRoot` ends in the running process's own generation UUID, so
 * the `rmSync` that preceded its `mkdirSync` could never delete anything: a
 * supervisor that was killed instead of shutting down left its transcript overflow
 * directory behind forever, and every restart added another one beside it. Startup
 * now reclaims every sibling generation, which is safe because supervisor ownership
 * of the descriptor directory is exclusive by then.
 */

const roots: string[] = [];

afterEach(async () => {
	await disposeSupervisorHarnesses();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

describe("snapshot cache generation reclamation", () => {
	it("removes the generations a killed supervisor left and keeps its own", async () => {
		const descriptorDir = join(tempRoot("ma-snapshot-cache-sweep-"), "workers");
		const stale = join(descriptorDir, "snapshot-cache", "11111111-2222-3333-4444-555555555555");
		mkdirSync(stale, { recursive: true });
		// What an interrupted attach leaves: chunks spilled past the memory cache.
		writeFileSync(join(stale, "chunk-0.bin"), "x".repeat(4096));
		const second = join(descriptorDir, "snapshot-cache", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		mkdirSync(second, { recursive: true });

		const harness = await startSupervisorHarness({
			prefix: "ma-snapshot-cache-sweep-",
			supervisorOptions: { descriptorDir },
		});
		await harness.waitForWorkerReady();

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(second)).toBe(false);
		const generations = readdirSync(join(descriptorDir, "snapshot-cache"));
		expect(generations).toHaveLength(1);
		expect(lstatSync(join(descriptorDir, "snapshot-cache", generations[0]!)).isDirectory()).toBe(true);
		expect(harness.logText()).toContain("Reclaimed 2 stale snapshot cache generation(s)");
	}, 60_000);

	it("never follows a planted symlink out of the cache directory", async () => {
		const root = tempRoot("ma-snapshot-cache-symlink-");
		const descriptorDir = join(root, "workers");
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "sentinel.txt"), "do not touch");
		const cacheParent = join(descriptorDir, "snapshot-cache");
		mkdirSync(cacheParent, { recursive: true });
		symlinkSync(outside, join(cacheParent, "99999999-8888-7777-6666-555555555555"));

		const harness = await startSupervisorHarness({
			prefix: "ma-snapshot-cache-symlink-",
			supervisorOptions: { descriptorDir },
		});
		await harness.waitForWorkerReady();

		expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("do not touch");
		expect(lstatSync(join(cacheParent, "99999999-8888-7777-6666-555555555555")).isSymbolicLink()).toBe(true);
	}, 60_000);

	it("leaves a stray file in the cache directory alone", async () => {
		const descriptorDir = join(tempRoot("ma-snapshot-cache-stray-"), "workers");
		const cacheParent = join(descriptorDir, "snapshot-cache");
		mkdirSync(cacheParent, { recursive: true });
		writeFileSync(join(cacheParent, "not-a-generation.txt"), "stray");

		const harness = await startSupervisorHarness({
			prefix: "ma-snapshot-cache-stray-",
			supervisorOptions: { descriptorDir },
		});
		await harness.waitForWorkerReady();

		expect(readFileSync(join(cacheParent, "not-a-generation.txt"), "utf8")).toBe("stray");
	}, 60_000);
});
