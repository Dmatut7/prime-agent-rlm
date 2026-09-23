import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";

/**
 * The RLM prompt names concrete Python fields and signatures from the kernel
 * runtime. A prompt that names a field the runtime does not have teaches the
 * model an AttributeError, so every name the prompt teaches is checked
 * against the runtime source here.
 */

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../prime-agent-runtime/src/rlm");
const rlmInit = readFileSync(path.join(runtimeDir, "__init__.py"), "utf8");
const bashSource = readFileSync(path.join(runtimeDir, "bash.py"), "utf8");
const harnessSource = readFileSync(path.join(runtimeDir, "harness.py"), "utf8");

function classBody(source: string, className: string): string {
	const start = source.indexOf(`class ${className}`);
	expect(start, `class ${className} not found in runtime source`).toBeGreaterThanOrEqual(0);
	const rest = source.slice(start);
	const next = rest.slice(1).search(/\n(?:class |def |async def |@dataclass)/);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

function dataclassFields(source: string, className: string): string[] {
	const fields = [...classBody(source, className).matchAll(/^ {4}([a-z_]+): /gm)].map((match) => match[1] as string);
	expect(fields.length, `${className} has no fields`).toBeGreaterThan(0);
	return fields;
}

function methodSignature(name: string): { isAsync: boolean; params: string[] } {
	const match = new RegExp(`^ {4}(async )?def ${name}\\(([^)]*)\\)`, "ms").exec(harnessSource);
	expect(match, `harness method ${name} not found`).not.toBeNull();
	const params = (match?.[2] ?? "")
		.split(",")
		.map((param) => param.trim().split(":")[0]?.trim() ?? "")
		.filter((param) => param && param !== "self" && param !== "*" && !param.startsWith("**"));
	return { isAsync: match?.[1] !== undefined, params };
}

const prompt = buildRlmPrompt({
	cwd: "/work",
	messagesPath: "/work/messages.jsonl",
	installedSkills: ["agent_message", "agent_observe", "edit"],
	activeTools: ["ipython"],
});

describe("RLM prompt names only real runtime API", () => {
	it("teaches the BashResult fields the runtime defines", () => {
		const fields = dataclassFields(bashSource, "BashResult");
		expect(fields).toEqual(["exit_code", "output", "duration"]);
		for (const field of fields) {
			expect(prompt).toContain(`r.${field}`);
		}
		expect(prompt).toContain("there is no `duration_ms`");
	});

	it("teaches BashHandle members that exist, including the exit_code that waits for completion", () => {
		const body = classBody(bashSource, "BashHandle");
		for (const member of ["pid", "running", "output", "tail", "poll", "kill", "exit_code"]) {
			expect(body).toMatch(new RegExp(`def ${member}\\(`));
			expect(prompt).toContain(`h.${member}`);
		}
		expect(prompt).toContain("`h.exit_code` stays `None` until the command finishes");
	});

	it("lists the list_subagents row fields exactly", () => {
		const fields = dataclassFields(rlmInit, "RLMSubagent");
		expect(fields).not.toContain("name");
		const listed = (/A row's fields are ([^.]+)\./.exec(prompt)?.[1] ?? "").replace(/\(not `[a-z_]+`\)/g, "");
		const named = [...listed.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
		expect(new Set(named)).toEqual(new Set(fields));
	});

	it("lists the spawn handle fields exactly", () => {
		const fields = dataclassFields(rlmInit, "RLMSpawnHandle");
		expect(prompt).toContain(
			`returns immediately after task admission with ${fields
				.slice(0, -1)
				.map((field) => `\`${field}\``)
				.join(", ")}, and \`${fields.at(-1)}\``,
		);
	});

	it("lists the collect snapshot fields exactly", () => {
		const fields = dataclassFields(rlmInit, "RLMChildResult");
		const listed = (/the field list is ([^.]+)\./.exec(prompt)?.[1] ?? "").replace(/\(not `[a-z_]+`\)/g, "");
		const named = [...listed.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
		expect(new Set(named)).toEqual(new Set(fields));
	});

	it("describes harness CRUD as synchronous with its real positional parameters", () => {
		for (const kind of ["memory", "prompt_note", "skill", "subagent"]) {
			const create = methodSignature(`create_${kind}`);
			const update = methodSignature(`update_${kind}`);
			expect(create.isAsync).toBe(false);
			expect(update.isAsync).toBe(false);
			expect(create.params.slice(0, 2)).toEqual(["title", "content"]);
			expect(update.params.slice(0, 3)).toEqual(["id", "title", "content"]);
		}
		expect(methodSignature("overview").isAsync).toBe(false);
		expect(methodSignature("record_refinement").params.slice(0, 2)).toEqual(["trigger", "changes"]);
		expect(prompt).toContain("`rlm.harness.*` methods are ordinary synchronous calls");
		expect(prompt).toContain("Create calls take `(title, content, *, id=None, path=...)`");
		expect(prompt).toContain("update calls take `(id, title, content)`");
	});
});
