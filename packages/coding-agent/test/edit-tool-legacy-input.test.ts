import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolRenderContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
	});

	it("does not add built-in edit guidance to the system prompt", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.promptGuidelines).toBeUndefined();
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in legacy.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});

describe("edit tool display washing", () => {
	function renderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
		return {
			args: {},
			toolCallId: "t1",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			includeImageDimensions: false,
			isError: false,
			...overrides,
		};
	}

	it("washes the path in the call header and the error text in the result", () => {
		initTheme("dark");
		const definition = createEditToolDefinition(process.cwd());
		const dirtyPath = "src/\x1b[2Jfile.ts";

		const call = definition.renderCall!(
			{ path: dirtyPath, edits: [{ oldText: "a", newText: "b" }] },
			theme,
			renderContext({ args: { path: dirtyPath, edits: [{ oldText: "a", newText: "b" }] }, argsComplete: false }),
		);
		const header = call.render(80).join("\n");
		expect(header).not.toContain("\x1b[2J");
		expect(stripAnsi(header)).toContain("src/");

		const result = definition.renderResult!(
			{ content: [{ type: "text", text: "edit failed \x1b]52;c;eA==\x07here" }] } as never,
			{ expanded: false, isPartial: false },
			theme,
			renderContext({ isError: true }),
		);
		const output = result.render(80).join("\n");
		expect(output).not.toContain("]52;");
		expect(output).not.toContain("\x07");
		expect(stripAnsi(output)).toContain("edit failed");
	});
});
