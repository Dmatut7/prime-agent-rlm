import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir, getSessionsDir } from "../src/config.js";

/**
 * Tests must never write into the developer's real agent dir: a session created
 * without its own session dir would otherwise land in the real session list.
 * vitest.config.ts points the agent dir at a run-scoped temp root.
 */
describe("test process agent dir", () => {
	it("is not the real home agent dir", () => {
		const real = resolve(join(homedir(), ".prime", "agent"));
		expect(resolve(getAgentDir())).not.toBe(real);
		expect(resolve(getSessionsDir()).startsWith(real)).toBe(false);
	});
});
