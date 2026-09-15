import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getKernelVenvDir } from "../src/core/kernel/bootstrap.js";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import { formatHarnessStateForPrompt, type HarnessState } from "../src/core/refinement/index.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

/**
 * The model-facing prompt may only teach a call form or a command that works in the session that
 * receives it. R12 measured two promises that do not: skills advertised as same-named shell
 * commands (every one of them is exit 127 in a real `bash()` child, and the host-backed skills have
 * no out-of-process implementation at all because the kernel's host bridge is a non-inheritable
 * protocol fd), and `uv pip install <pkg>` taught as the install command next to a parenthetical
 * denying that the kernel venv has pip.
 */

const PYTHON_SKILLS = ["agent_message", "agent_observe", "compact", "edit", "goal", "rlm_heartbeat", "websearch"];
const KERNEL_PYTHON_PLACEHOLDER = "<kernel-python>";

function replPrompt(): string {
	return buildRlmPrompt({
		cwd: "/repo",
		messagesPath: "/repo/session.jsonl",
		installedSkills: PYTHON_SKILLS,
		activeTools: ["ipython", "bash"],
	});
}

function shellOnlyPrompt(): string {
	return buildRlmPrompt({
		cwd: "/repo",
		messagesPath: "/repo/session.jsonl",
		installedSkills: PYTHON_SKILLS,
		activeTools: ["bash"],
		allowRecursion: false,
	});
}

function emptyHarnessState(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

/** Every backticked install command the prompt teaches together with a package placeholder. */
function taughtInstallCommands(prompt: string): string[] {
	return [...prompt.matchAll(/`([^`]*pip install[^`]*)`/g)]
		.map((match) => match[1] as string)
		.filter((command) => command.includes("<pkg>"));
}

describe("skill invocation doctrine: Python modules, not shell commands", () => {
	it("never advertises a skill shell command to a REPL session", () => {
		const prompt = replPrompt();
		expect(prompt).not.toContain("available as a shell command");
		expect(prompt).not.toContain("available as shell commands");
		expect(prompt).not.toContain("`<skill> --help`");
		expect(prompt).not.toContain(`${KERNEL_PYTHON_PLACEHOLDER} --help`);
		expect(prompt).not.toContain("in shell when a CLI exists");
	});

	it("states the real boundary and keeps the REPL entry point it does honor", () => {
		const prompt = replPrompt();
		expect(prompt).toContain("not a shell command");
		// Positive control: the path that does work stays documented verbatim.
		expect(prompt).toContain("Installed Python skill modules (pre-imported): `agent_message`");
		expect(prompt).toContain("Read each skill's SKILL.md for its API");
		expect(prompt).toContain("inspect.signature(<skill>.<function>)");
	});

	it("tells a session without the ipython tool that Python skills cannot run there", () => {
		const prompt = shellOnlyPrompt();
		expect(prompt).not.toContain("available as shell commands");
		expect(prompt).toContain("are not shell commands");
		expect(prompt).toContain("no ipython tool");
		// Kernel environment claims belong to a session that has the kernel.
		expect(prompt).not.toContain("Pre-installed Python packages");
	});

	it("keeps the harness-state call contract on the same honest wording", () => {
		const repl = formatHarnessStateForPrompt(emptyHarnessState());
		expect(repl).not.toContain("in shell when a CLI exists");
		expect(repl).toContain("not a shell command");

		const shellOnly = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			harnessState: emptyHarnessState(),
		});
		expect(shellOnly).not.toContain("use installed skills as shell commands");
	});
});

/** The generation layout `<base>-<hash>/{bin,Scripts}/python`, or undefined when none is built. */
function installedKernelPython(): string | undefined {
	const configured = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (configured && existsSync(configured)) return configured;
	const base = getKernelVenvDir();
	const parent = path.dirname(base);
	if (!existsSync(parent)) return undefined;
	const scriptName = process.platform === "win32" ? "python.exe" : "python";
	for (const entry of readdirSync(parent)) {
		if (!entry.startsWith(`${path.basename(base)}-`)) continue;
		for (const binDir of ["bin", "Scripts"]) {
			const candidate = path.join(parent, entry, binDir, scriptName);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

function hasUvOnPath(): boolean {
	return spawnSync(process.platform === "win32" ? "where" : "which", ["uv"], { encoding: "utf8" }).status === 0;
}

describe("package-install doctrine: every taught command must run", () => {
	it("anchors every taught install command on an explicit interpreter and drops the pip denial", () => {
		const commands = taughtInstallCommands(replPrompt());
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			expect(command).toContain(KERNEL_PYTHON_PLACEHOLDER);
		}
		const prompt = replPrompt();
		expect(prompt).not.toContain("no pip module");
		expect(commands.length).toBeGreaterThan(1);
	});

	const kernelPython = installedKernelPython();
	const canProbe = kernelPython !== undefined && hasUvOnPath();
	const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

	it.skipIf(!canProbe)(
		"each taught install command runs on this machine with the kernel interpreter substituted",
		() => {
			expect(kernelPython).toBeDefined();
			for (const command of taughtInstallCommands(replPrompt())) {
				if (!command.includes("<pkg>")) continue;
				const run = command.replace(KERNEL_PYTHON_PLACEHOLDER, kernelPython as string).replace("<pkg>", "requests");
				const result = spawnSync(shell, process.platform === "win32" ? ["/d", "/c", run] : ["-lc", run], {
					encoding: "utf8",
					timeout: 45_000,
					cwd: process.env.TMPDIR ?? "/tmp",
					env: { ...process.env, VIRTUAL_ENV: "" },
				});
				expect(result.status, `${run}\n${result.stdout}\n${result.stderr}`).toBe(0);
			}
		},
	);

	it.skipIf(!kernelPython)("the venv the prompt installs into is the seeded one, contrary to the old claim", () => {
		const pip = spawnSync(kernelPython as string, ["-m", "pip", "--version"], { encoding: "utf8", timeout: 30_000 });
		expect(pip.status, `${pip.stdout}\n${pip.stderr}`).toBe(0);
		expect(pip.stdout).toContain("pip");
	});

	it.skipIf(!canProbe)("the bare `uv pip install <pkg>` the old prompt taught fails in this environment", () => {
		const bare = spawnSync(shell, ["-lc", "uv pip install --dry-run six"], {
			encoding: "utf8",
			timeout: 45_000,
			cwd: process.env.TMPDIR ?? "/tmp",
			env: { ...process.env, VIRTUAL_ENV: "" },
		});
		expect(bare.status).not.toBe(0);
		expect(`${bare.stdout}${bare.stderr}`).toContain("No virtual environment found");
	});
});
