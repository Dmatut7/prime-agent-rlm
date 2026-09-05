import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition, writeFileAtomic } from "../src/core/tools/edit.js";

const fsHooks = vi.hoisted(() => ({
	onAfterWriteFile: undefined as (() => void) | undefined,
}));

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	const writeFileWithHook = async (...args: unknown[]): Promise<void> => {
		await (actual.writeFile as unknown as (...a: unknown[]) => Promise<void>)(...args);
		fsHooks.onAfterWriteFile?.();
	};
	return {
		...actual,
		writeFile: writeFileWithHook,
	};
});

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-atomic-"));
	tempDirs.push(dir);
	return dir;
}

async function tempFileResidues(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter((entry) => entry.endsWith(".tmp"));
}

afterEach(async () => {
	fsHooks.onAfterWriteFile = undefined;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
	it("replaces file content and preserves the original file mode", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "before", "utf-8");
		await chmod(file, 0o600);

		await writeFileAtomic(file, "after");

		expect(await readFile(file, "utf-8")).toBe("after");
		expect((await stat(file)).mode & 0o7777).toBe(0o600);
		expect(await tempFileResidues(dir)).toEqual([]);
	});

	it("does not touch the original file when the signal is already aborted", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "original", "utf-8");
		const controller = new AbortController();
		controller.abort();

		await expect(writeFileAtomic(file, "corrupted", controller.signal)).rejects.toThrow("Operation aborted");

		expect(await readFile(file, "utf-8")).toBe("original");
		expect(await tempFileResidues(dir)).toEqual([]);
	});

	it("keeps the original intact and removes the temp file when aborted mid-write", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "original", "utf-8");
		const controller = new AbortController();
		// Abort as soon as the temp file has been written, before the rename commits it.
		fsHooks.onAfterWriteFile = () => controller.abort();

		await expect(writeFileAtomic(file, "corrupted", controller.signal)).rejects.toThrow("Operation aborted");

		expect(await readFile(file, "utf-8")).toBe("original");
		expect(await tempFileResidues(dir)).toEqual([]);
	});
});

describe("edit tool atomic write", () => {
	it("rejects and leaves the original file intact when aborted during the write", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "original content\n", "utf-8");
		const controller = new AbortController();
		fsHooks.onAfterWriteFile = () => controller.abort();

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"t1",
				{ path: file, edits: [{ oldText: "original", newText: "edited" }] },
				controller.signal,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("Operation aborted");

		expect(await readFile(file, "utf-8")).toBe("original content\n");
		expect(await tempFileResidues(dir)).toEqual([]);
	});

	it("still applies edits atomically on the happy path", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "original content\n", "utf-8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"t2",
			{ path: "target.txt", edits: [{ oldText: "original", newText: "edited" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in target.txt." }]);
		expect(await readFile(file, "utf-8")).toBe("edited content\n");
		expect(await tempFileResidues(dir)).toEqual([]);
	});
});
