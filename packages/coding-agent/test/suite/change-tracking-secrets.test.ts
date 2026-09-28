import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpythonToolDetails } from "../../src/core/tools/ipython.js";
import { resolveKernelPython } from "../kernel-python.js";
import { createHarness, type Harness } from "./harness.js";

// The session's own ipython tool and kernel write a secret file, rotate it through bash and store a
// memory holding a token; nothing of those values may reach the session records on disk.
const python = await resolveKernelPython("import rlm.repl, rlm.effects, dill");

const OLD_KEY = `sk-${"OLD"}FAKE000000000000000000000000`;
const NEW_KEY = `sk-${"NEW"}FAKE000000000000000000000000`;
const MEMORY_KEY = `sk-${"MEM"}FAKE0000000000000000000000`;

function sessionFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sessionFiles(path));
		else if (path.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

describe.skipIf(python === null)("change tracking keeps secrets out of session records", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
	});

	it("records the .env and memory changes without their secret values", async () => {
		vi.stubEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);
		harness = await createHarness({ persistSession: true });
		const write = `open('.env', 'w').write('OPENAI_API_KEY=' + ${JSON.stringify(OLD_KEY.slice(0, 6))} + ${JSON.stringify(OLD_KEY.slice(6))} + '\\n')`;
		const rotate = [
			"import rlm",
			`await rlm.bash("sed -i.bak 's/${"OLD"}/${"NEW"}/' .env && rm .env.bak")`,
			`_ = rlm.harness.create_memory('creds', 'token=' + ${JSON.stringify(MEMORY_KEY.slice(0, 6))} + ${JSON.stringify(MEMORY_KEY.slice(6))})`,
		].join("\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: write }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("ipython", { code: rotate }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("set up the key");

		const details = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message as { details?: IpythonToolDetails }).details);
		expect(details).toHaveLength(2);
		const envChanges = details.map((d) => d?.fileChanges?.find((change) => change.relPath === ".env"));
		expect(envChanges.map((change) => [change?.kind, change?.diffOmitted, change?.diff])).toEqual([
			["created", "sensitive", undefined],
			["modified", "sensitive", undefined],
		]);
		expect(envChanges.map((change) => [change?.added, change?.removed])).toEqual([
			[1, 0],
			[1, 1],
		]);
		const memory = details[1]?.memoryChanges?.find((change) => change.title === "creds");
		expect(memory).toMatchObject({ op: "created", kind: "memory", textOmitted: "sensitive" });
		expect(memory?.after).toBeUndefined();
		// The session's own storage sits inside the working folder here; its files are not changes of the cell.
		const recorded = details.flatMap((d) => (d?.fileChanges ?? []).map((change) => change.relPath ?? change.path));
		expect(recorded.filter((path) => path !== ".env")).toEqual([]);

		const files = sessionFiles(harness.tempDir);
		expect(files.length).toBeGreaterThan(0);
		const onDisk = files.map((file) => readFileSync(file, "utf8")).join("\n");
		// The session file does hold the change records, so the absence below is not vacuous.
		expect(onDisk).toContain('"diffOmitted":"sensitive"');
		for (const secret of [OLD_KEY, NEW_KEY, MEMORY_KEY]) {
			expect(onDisk.includes(secret), secret).toBe(false);
		}
	}, 120_000);
});
