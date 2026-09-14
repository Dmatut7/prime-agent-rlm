/**
 * Child process behind test/sync-sleep.test.ts: a caller blocked in a lock-retry sleep while the
 * wall clock is stepped backwards.
 *
 * It holds the locks the callers below need, so their retry loops really run; it then prints how
 * long each caller took. A caller whose sleep waits on the wall clock never returns, which is what
 * the parent test detects through its process timeout.
 *
 * Run by the test, not by the suite directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import lockfile from "proper-lockfile";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.js";
import { FileSettingsStorage } from "../../src/core/settings-manager.js";
import { sleepSync } from "../../src/utils/sleep.js";

const root = mkdtempSync(join(tmpdir(), "sync-sleep-probe-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });

/** How far back the wall clock steps once the callers are inside their retry sleeps. */
const WALL_CLOCK_SHIFT_MS = 3_600_000;
const realNow = Date.now.bind(Date);
let reads = 0;
let frozen = false;
function breakWallClock(): void {
	if (frozen) return;
	frozen = true;
	Date.now = () => {
		reads += 1;
		return reads > 3 ? realNow() - WALL_CLOCK_SHIFT_MS : realNow();
	};
}

const settingsPath = join(agentDir, "settings.json");
writeFileSync(settingsPath, "{}\n");
const releaseSettings = lockfile.lockSync(settingsPath, { realpath: false });
const settingsStorage = new FileSettingsStorage(root, agentDir);
breakWallClock();
const settingsStarted = performance.now();
let settingsOutcome = "returned";
try {
	settingsStorage.withLock("global", () => undefined);
} catch (error) {
	settingsOutcome = String((error as { code?: string }).code ?? error);
}
const settingsElapsedMs = Math.round(performance.now() - settingsStarted);
releaseSettings();

const authPath = join(agentDir, "auth.json");
new FileAuthStorageBackend(authPath).withLock(() => ({ result: undefined }));
const releaseAuth = lockfile.lockSync(authPath, { realpath: false });
const authStorage = new FileAuthStorageBackend(authPath);
const authStarted = performance.now();
let authOutcome = "returned";
try {
	authStorage.withLock(() => ({ result: undefined }));
} catch (error) {
	authOutcome = String((error as { code?: string }).code ?? error);
}
const authElapsedMs = Math.round(performance.now() - authStarted);
releaseAuth();

const sleepStarted = performance.now();
sleepSync(40);
const sleepElapsedMs = Math.round(performance.now() - sleepStarted);

rmSync(root, { recursive: true, force: true });

console.log(
	JSON.stringify({
		wallClockShiftMs: WALL_CLOCK_SHIFT_MS,
		wallClockReads: reads,
		settings: { outcome: settingsOutcome, elapsedMs: settingsElapsedMs },
		auth: { outcome: authOutcome, elapsedMs: authElapsedMs },
		sleep: { outcome: "returned", elapsedMs: sleepElapsedMs },
	}),
);
