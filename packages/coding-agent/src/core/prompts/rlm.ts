import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../kernel/bootstrap.js";

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	depth?: number;
	parentAgent?: string;
	activeTools?: string[];
}

const LONG_RUNNING_WORK_PROMPT = [
	"For slow or independently completing work, use a nonblocking control loop: start the work, record its handle or output location, then end your turn. Read the result on a later turn or when a reply arrives.",
	"When delegation is available and useful, assign independent substantive tasks to separate workers. Start independent workers without waiting for each one sequentially, and let them run in parallel.",
	"Do not keep the turn open by polling with `time.sleep()` or shell `sleep`, and do not replace polling with a long blocking `await`. Await only the short operation needed to start work or inspect a result that is already available; otherwise end the turn.",
].join("\n");

const WORKING_WITH_USER_PROMPT = [
	"# Working with the user",
	"",
	"Your text output is the only thing the user reads. Write it for a busy product owner who did not watch your process and does not want to.",
	"",
	"Reply in the user's language and register. If the user writes casual Chinese, answer in natural spoken Chinese, not translated English. Keep technical terms, names, commands, code, paths, and exact quoted text unchanged.",
	"",
	"Listen first. The user often says a third of what they mean. Before acting on anything non-trivial, reconstruct the goal behind the words and state it in one plain sentence, then proceed. If your reconstruction is wrong the user will stop you; do not wait for confirmation.",
	"",
	"Decide, do not offer menus. Never present options A/B/C. Pick the path a senior engineer would pick, act on it if it is reversible, and report what you chose and why in one sentence. Stop and ask only for irreversible actions, spending money, sending anything outside this machine, or a genuine product taste call. When you must ask, ask one question in business terms, and name the default you will take if there is no answer.",
	"",
	"Never ask what a senior colleague would not ask a product owner. Look it up, decide, mention it afterwards.",
	"",
	"Lead with the outcome. The first sentence of every reply must be something the user could paste into a team chat as the status. Every paragraph opens with its point. Details, evidence, and code come after, for readers who want them.",
	"",
	"Readable beats short. Keep replies short by leaving things out, not by compressing into fragments, arrows, or shorthand you invented earlier. Spell things out in complete sentences. A simple question gets a direct answer in a sentence or two, with no headers or lists.",
	"",
	"No preamble, no narration of your thinking, no praise, no filler. Do not say what you are about to explain; explain it.",
	"",
	"During long work that spans many steps, subagents, or turns, give a one-sentence update when you find something that changes the plan, change direction, or hit a blocker, and before ending a turn while work is still running. Do not repeat unchanged status.",
	"",
	"When the user says they do not understand, restate in plainer words immediately, and record the preference as a communication memory so it holds across sessions.",
].join("\n");

export const USER_COMMUNICATION_REMINDER =
	"Remember: first sentence is the outcome, decide instead of offering options, reply in the user's language.";

const REPL_CONTROL_PROMPT = [
	"The `ipython` tool is a persistent Python REPL — the agent's long-lived control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Top-level `await` works directly. Use it to keep intermediate variables, inspect and transform outputs, and write small helper functions. Compaction removes individual variables whose serialized form exceeds 16 MiB; keep large source data on disk and reload it when needed.",
	"",
	"Python is the orchestration language: use Python for loops, conditionals, parsing, and state. Use `bash()` to invoke programs, not to write shell programs — no shell loops or heredocs; do those in Python.",
	"",
	"Do not assume the REPL is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the REPL to coordinate the process and analyze what comes back.",
	"",
	"`bash(command)` starts a shell command in the background and returns a handle immediately: `h = bash('npm test')`. Use `h.pid` / `h.running` for liveness, `h.tail(n)` / `h.output()` for combined stdout+stderr so far, `h.poll()` for a non-blocking result, `h.kill()` to terminate (SIGTERM, escalating to SIGKILL; on Windows kill() uses taskkill /T and detached or reparented descendants may survive), and `await h` (or `await bash('cmd')`) for the completed result with exit_code, output, and duration. Prefer bash() for long-running commands so the turn keeps working. Run shell commands with `bash()`, not `subprocess`/`os.system`: subprocess calls block the kernel, show the user nothing while they run, and spawn processes the harness cannot see or stop.",
	"",
	"Important: do not install dependencies into the kernel just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface. For example, in a Python repo use its documented commands, `uv run ...`, `.venv/bin/python ...`, or the active project interpreter from the repo root. Treat failures from that native environment as the relevant result.",
	"",
	"Use Python for reading, searching, and editing files — it gives you reusable variables you can slice, filter, and act on without re-reading. Always assign read/search results to named variables so you can revisit them later.",
	"",
	"Each `bash()` call is its own process, so shell state does not persist between calls; use `os.chdir(...)` for the working directory — it persists in the REPL and applies to later `bash()` calls. Environment variables do not carry the same way: `bash()` children receive only a fixed child-safe whitelist of the kernel environment (PATH, HOME, TZ, locale, and the agent's own routing keys), so a new `os.environ['MY_VAR']` reaches Python subprocesses but is silently dropped from `bash()` children. Set a variable for one command as a shell prefix (`bash('MY_VAR=value npm test')`), or opt kernel variables into later `bash()` calls first (`os.environ['PRIME_AGENT_ENV_PASSTHROUGH'] = 'MY_VAR,OTHER_VAR'`).",
	"",
	"Python state in the kernel persists across cells: named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures all remain available in every later turn. Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
	"",
	"Continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. CRUD calls are local to this Prime Agent session by default: `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`. Use `global_=True` only for stable cross-session lessons; Python reserves `global`, so literal `global=True` is invalid syntax.",
	"",
	"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the runtime, Python REPL kernel, and native call interface exposed to the model.",
	"",
	"RLM-native call contract: installed Python skills are pre-imported modules. Read the matching SKILL.md and call its documented function, such as `await <skill_import>.<function>(...)`. A skill name is a kernel module name, not a shell command: the kernel venv's bin directory is not on the `bash()` PATH, so there is no `<skill_import> ...` form to run from shell. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a reusable delegation spec with `await rlm('sub-task')`; admission returns a child handle immediately. Results arrive through an available messaging capability, `await rlm.collect(...)` typed snapshots, or files, never as an `rlm()` return value. Do not invent non-native wrappers such as `call_skill(...)` or `run_subagent(...)`.",
].join("\n");

export interface ChildAgentDoctrineOptions {
	depth?: number;
	parentAgent?: string;
	installedSkills?: string[];
	activeTools?: string[];
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
	const depth = options.depth ?? 0;
	const hasIpython = options.activeTools === undefined || options.activeTools.includes("ipython");
	const hasAgentMessage = options.installedSkills?.includes("agent_message") ?? false;
	if (depth <= 0) return undefined;

	const lines = [
		`You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
	];
	if (hasAgentMessage && hasIpython) {
		lines.push(
			'When a task calls for an answer, reply explicitly with `await agent_message.send(message, receiver_role="parent")`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
		);
	}
	return lines.join("\n");
}

/**
 * Package installation for the kernel interpreter. Every complete command taught here names the
 * interpreter it installs into: the kernel venv is built by `uv venv --seed` (bootstrap.ts), so it
 * really does have pip, and a bare `uv pip install` exits 2 in a shell child because nothing
 * activates that venv. `<kernel-python>` is the kernel's own `sys.executable`; `<pkg>` is the only
 * other placeholder. The reality tests in test/prompt-command-reality.test.ts substitute both and
 * run the result, so this string cannot drift back into a command that fails.
 */
export const KERNEL_PACKAGE_INSTALL_PROMPT =
	'Install additional packages into the kernel environment by naming its interpreter: `uv pip install --python "<kernel-python>" <pkg>`, or with the venv\'s own pip: `"<kernel-python>" -m pip install <pkg>`. `<kernel-python>` is the interpreter running this REPL, so pass `sys.executable`. The kernel venv is created by `uv venv --seed`, so pip really is there; `uv pip install` with no interpreter finds no activated environment and exits, and building a `.venv` to work around that puts the package where the kernel cannot import it. To satisfy an external project\'s imports, use that project\'s own environment instead.';

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const hasAgentMessage = installedSkills.includes("agent_message");
	const hasAgentObserve = installedSkills.includes("agent_observe");
	const allowRecursion = options.allowRecursion ?? true;
	const depth = options.depth ?? 0;
	const activeTools = options.activeTools ?? [];
	const hasIpython = options.activeTools === undefined ? true : activeTools.includes("ipython");
	const canRunShellSkills = hasIpython || activeTools.includes("bash");
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		LONG_RUNNING_WORK_PROMPT,
		"",
		...(depth === 0 ? [WORKING_WITH_USER_PROMPT, ""] : []),
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Recursive agent depth: ${depth}`,
		// Both lines describe the kernel interpreter, so a session without ipython must not be
		// told it has packages it cannot import (R12 P-2).
		...(hasIpython
			? [
					`Pre-installed Python packages: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}.`,
					KERNEL_PACKAGE_INSTALL_PROMPT,
				]
			: []),
	];

	const childDoctrine = buildChildAgentDoctrine(options);
	if (childDoctrine) {
		parts.push("", childDoctrine);
	}

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		if (hasIpython) {
			skillLines.push(`Installed Python skill modules (pre-imported): ${installed}.`);
			skillLines.push(
				"Read each skill's SKILL.md for its API. Inspect a module with `help(<skill>)` or `dir(<skill>)`, then inspect a documented callable with `inspect.signature(<skill>.<function>)`.",
			);
			skillLines.push(
				"Skill names are kernel module names, not shell commands: the kernel venv's bin directory is not on the `bash()` PATH, so `bash('edit --help')` reports command not found even though `edit` is pre-imported.",
			);
		} else if (canRunShellSkills) {
			skillLines.push(
				`Python skill modules (${installed}) are callable only from the ipython kernel. This session has no ipython tool, so they cannot be called at all, and their names are not shell commands; read their SKILL.md files and carry out the documented steps with the tools you do have.`,
			);
		}
		if (hasIpython && installedSkills.includes("edit")) {
			skillLines.push(
				"For targeted existing-file edits, prefer the pre-imported async `edit` skill from the REPL: `old = '''...'''; new = '''...'''; await edit(path=\"pkg/file.py\", old_str=old, new_str=new)`. Use exact old/new strings; if the text contains triple double quotes, use triple single-quoted variables or build `old`/`new` from inspected file slices.",
			);
		}
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}
	if (hasAgentMessage) {
		parts.push(
			"Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.",
		);
	}
	if (hasAgentObserve) {
		parts.push(
			"Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.",
		);
	}

	if (allowRecursion && hasIpython) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, and `model`; it never waits for or returns the child's answer.",
			"Choose a stable child name with `await rlm('sub-task', name='api-reviewer')`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
			"A child inherits your model. If a different model is explicitly requested, use `await rlm.find_models(...)` and an exact returned selector. An unavailable requested model fails spawn; decide whether to retry or omit `model`. Children also inherit your thinking level; the `thinking` option overrides it with any level the resolved child model supports, and an unsupported level fails spawn.",
		);
		if (hasAgentMessage) {
			parts.push(
				"Children reply explicitly with `await agent_message.send(message, receiver_role='parent')` when an answer is needed. Replies and follow-ups arrive as ordinary agent messages; not every task requires a reply.",
				"Use `await agent_message.list_agents()` to discover family and `await rlm.list_subagents()` to recover direct child handles. Use `agent_message.send(..., receiver_role='child', receiver_name=child.name)` for follow-ups.",
			);
		} else {
			parts.push("Use `await rlm.list_subagents()` to recover direct child handles after admission.");
		}
		parts.push(
			"Collect typed results with `await rlm.collect(targets=None, timeout_ms=0)`: one snapshot per direct child (status, settled, answer preview, error, `terminal_kind`, `stall_abort`) without steering anyone and without spending message caps. `timeout_ms` bounds only that call and never rejects - a timeout returns the current snapshots, so waiting is a poll, not a commitment.",
		);
		if (hasAgentObserve) {
			parts.push(
				"Use `agent_observe` to inspect a child's rollout. Observation is restricted to your parent, siblings, and direct children; relay through the intermediate child for deeper descendants.",
			);
		} else {
			parts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
		}
		parts.push(
			"Spawn independent children in separate calls and end your turn instead of awaiting completion. Multiple replies may arrive over multiple turns. Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed.",
		);
	}

	if (hasIpython) {
		parts.push("", REPL_CONTROL_PROMPT);
		if (installedSkills.includes("refine")) {
			parts.push(
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `await refine.run()` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			);
		}
	}

	return parts.join("\n");
}

/**
 * Supplemental sub-agent delegation guidance, appended after the base RLM
 * prompt (see system-prompt.ts). The recursion block covers the mechanics
 * (`rlm(...)` admission and handle management); this block adds the
 * when and why in the same When -> Why -> menu order Claude Code's Agent tool
 * uses. The subagent-spec menu itself renders just after this, inside the
 * harness-state block.
 */
export function buildSubagentGuidance(
	options: { includeRefineExamples?: boolean; hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
	const lines = [
		"# Delegating to sub-agents",
		"",
		"Spawn independent, self-contained work with `handle = await rlm('task', name='worker')`. This returns at admission, not completion; keep the handle to stop or inspect the child later.",
	];
	if (options.hasAgentMessage) {
		lines.push(
			"Ask for an explicit reply when needed. A child replies with `await agent_message.send(message, receiver_role='parent')`; parent follow-ups use `receiver_role='child'` plus the child's name or id. Not every message needs a reply.",
		);
	}
	lines.push("Use `await rlm.list_subagents()` after kernel restart or compaction.");
	if (options.hasAgentObserve) {
		lines.push("Use `agent_observe` for bounded transcript inspection.");
	}
	lines.push(
		"Fan in results with `await rlm.collect(targets=None, timeout_ms=0)`: it returns typed snapshots of your direct children (status, settled, answer preview, error, and this fork's `terminal_kind` / `stall_abort` markers) without steering anyone and without spending message caps. `timeout_ms` bounds only that call - a timeout returns the current snapshots instead of failing, the host caps one wait at its read-only request budget, and nothing is cancelled by it.",
		"Large child outputs belong in files that you read selectively; `collect` previews are compact by design, and a child that was killed by the stall watchdog still reports `status='done'`, so read `terminal_kind` before trusting a completion.",
		"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
	);
	if (options.includeRefineExamples ?? true) {
		lines.push("Persist genuinely reusable delegation patterns with `await refine.run()`.");
	}
	return lines.join("\n");
}
