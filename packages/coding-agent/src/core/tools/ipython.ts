import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import { resolveKernelBashShell } from "../../utils/shell.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelClient,
	type KernelDeathCause,
	type KernelDiffDisplay,
	type KernelLateHostReply,
	KernelRestartLedger,
	type KernelRestartPolicy,
	type KernelSentAgentMessage,
	type KernelUnexpectedExitFacts,
	ReplKernelManager,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, type SnapshotResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// The standard modules the prompt teaches (\`shlex.quote\`, \`json.dumps\`, \`os.chdir\`, Path)
// are bound up front, so following the prompt never starts with a NameError. The bootstrap
// runs after a state restore, so each is bound only when the name is still free: a restored
// user variable called \`json\` or \`re\` keeps its value.
const RLM_BOOTSTRAP_HEADER_CODE = `
import asyncio
import importlib as _prime_agent_header_importlib
for _prime_agent_header_name in ("json", "os", "re", "shlex", "sys"):
    if _prime_agent_header_name not in globals():
        globals()[_prime_agent_header_name] = _prime_agent_header_importlib.import_module(_prime_agent_header_name)
if "Path" not in globals():
    from pathlib import Path
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
`.trim();

const RLM_BOOTSTRAP_RUNTIME_CODE = `
try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
    bash = _prime_agent_rlm_module.bash
    import rlm.mcp as mcp
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def spawn(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def create_session(self, prompt, **kwargs):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

    rlm = _PrimeAgentMissingRlm()

    def bash(command):
        rlm._raise_missing()
`.trim();

/**
 * Line the runtime bootstrap prints (once, after the skill import loop) when
 * one or more pre-imported Python skills failed to import. The host scans the
 * bootstrap cell's stdout for this marker so unavailable skills reach the
 * model instead of failing only on first call.
 */
export const PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER = "__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__";

/** Map of skill import name -> import error, parsed from a bootstrap cell's stdout. */
export type UnavailablePythonSkills = Record<string, string>;

/** Extract the unavailable-skill report a bootstrap cell printed, or undefined. */
export function parseUnavailablePythonSkills(stdout: string): UnavailablePythonSkills | undefined {
	const at = stdout.indexOf(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
	if (at < 0) return undefined;
	const raw = stdout.slice(at + PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER.length).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const errors: UnavailablePythonSkills = {};
	for (const [name, error] of Object.entries(parsed)) {
		if (typeof error === "string" && error.length > 0) {
			errors[name] = error;
		}
	}
	return Object.keys(errors).length > 0 ? errors : undefined;
}

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const baseCode = [RLM_BOOTSTRAP_HEADER_CODE, RLM_BOOTSTRAP_RUNTIME_CODE].join("\n\n");
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	const packagePaths = Object.fromEntries(pythonSkills.map((skill) => [skill.importName, skill.packagePath]));
	if (importNames.length === 0) {
		return baseCode;
	}

	return `
${baseCode}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    # Computed from the current run on every lookup, so importlib.reload of a skill
    # cannot leave inspect.signature(skill) pinned to the startup-time snapshot.
    @property
    def __signature__(self):
        run = getattr(self, "run", None)
        if not callable(run):
            return None
        try:
            return _prime_agent_inspect.signature(run)
        except Exception:
            return None

    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __getattr__(self, attr):
        if attr in ("__path__", "__all__"):
            # The import machinery probes these on 'from name import x'; it must see a
            # non-package answer instead of the unavailable-skill error.
            raise AttributeError(attr)
        # The same named RuntimeError for attribute access as for calling, instead of
        # leaking this class name in an AttributeError.
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_rebind_function_globals(fn, target):
    """Rebuild a module-level function against the wrapper's own dict.

    Without this the wrapper's dict is a shallow copy: skill functions keep the raw
    module dict as __globals__, so global rebinding and attribute writes on the
    kernel-visible skill name are invisible to the skill's own code (and vice versa).
    """
    try:
        rebound = _prime_agent_types.FunctionType(
            fn.__code__, target, fn.__name__, fn.__defaults__, fn.__closure__
        )
    except Exception:
        return fn
    rebound.__dict__.update(fn.__dict__)
    rebound.__module__ = fn.__module__
    rebound.__qualname__ = fn.__qualname__
    rebound.__doc__ = fn.__doc__
    rebound.__annotations__ = fn.__annotations__
    if fn.__kwdefaults__ is not None:
        rebound.__kwdefaults__ = dict(fn.__kwdefaults__)
    return rebound

_PRIME_AGENT_SKILL_WRAPPERS = {}

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    existing = _PRIME_AGENT_SKILL_WRAPPERS.get(module)
    if existing is not None:
        return existing
    if isinstance(module, _PrimeAgentCallableSkillModule):
        _PRIME_AGENT_SKILL_WRAPPERS[module] = module
        return module
    raw_dict = module.__dict__
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(raw_dict)
    for _prime_agent_key, _prime_agent_value in list(wrapped.__dict__.items()):
        # Only functions this module defined itself: a helper imported from another
        # module keeps the globals of the module that defined it.
        if (
            _prime_agent_inspect.isfunction(_prime_agent_value)
            and _prime_agent_value.__globals__ is raw_dict
        ):
            wrapped.__dict__[_prime_agent_key] = _prime_agent_rebind_function_globals(
                _prime_agent_value, wrapped.__dict__
            )
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    _PRIME_AGENT_SKILL_WRAPPERS[module] = wrapped
    return wrapped

def _prime_agent_repoint_cross_skill_references():
    """Skills that import each other hold raw module references from import time.

    Swapping them for the wrappers keeps the callable contract (await A.B(...))
    working inside skill code, and lets importlib.reload(A.B) find the wrapper in
    sys.modules instead of failing with a backwards "not in sys.modules" error.
    """
    for _prime_agent_holder in list(_PRIME_AGENT_SKILL_WRAPPERS.values()):
        for _prime_agent_key, _prime_agent_value in list(_prime_agent_holder.__dict__.items()):
            # A module dict can hold unhashable values (e.g. its own __spec__), so the
            # registry lookup is gated on module values.
            if not isinstance(_prime_agent_value, _prime_agent_types.ModuleType):
                continue
            _prime_agent_replacement = _PRIME_AGENT_SKILL_WRAPPERS.get(_prime_agent_value)
            if _prime_agent_replacement is not None and _prime_agent_replacement is not _prime_agent_value:
                _prime_agent_holder.__dict__[_prime_agent_key] = _prime_agent_replacement

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

# A skill import name the kernel already answers to (a loaded module, a bootstrap
# global, the stdlib, or a builtin) must not be wrapped: wrapping would replace the
# real sys.modules entry with a startup-time snapshot copy.
_prime_agent_reserved_skill_names = (
    frozenset(_prime_agent_sys.modules)
    | frozenset(globals())
    | frozenset(getattr(_prime_agent_sys, "stdlib_module_names", ()))
    | frozenset(_prime_agent_sys.builtin_module_names)
)

_PRIME_AGENT_SKILL_PACKAGE_PATHS = ${JSON.stringify(packagePaths)}

def _prime_agent_restored_skill_module(name):
    """The skill's own module, bound by a state restore that ran before this bootstrap.

    A saved namespace revives a skill by re-importing it, so the name arrives here as
    the plain module from the skill's own package. That is not a foreign module
    shadowing the name, so it is wrapped like a fresh import. Anything bound to the
    name that lives outside the skill's package is still refused.
    """
    root = _PRIME_AGENT_SKILL_PACKAGE_PATHS.get(name)
    if not root:
        return None
    root = _prime_agent_os.path.realpath(root) + _prime_agent_os.sep
    found = None
    for candidate in (globals().get(name), _prime_agent_sys.modules.get(name)):
        if candidate is None:
            continue
        if not isinstance(candidate, _prime_agent_types.ModuleType):
            return None
        origin = getattr(candidate, "__file__", None)
        if not origin:
            return None
        if not (
            _prime_agent_os.path.realpath(origin).startswith(root)
            or _prime_agent_same_skill_source(root, name, origin)
        ):
            return None
        found = candidate
    return found

def _prime_agent_same_skill_source(root, name, origin):
    """Whether origin is this skill's own source file, installed from another checkout.

    The shared kernel venv installs skills by content, so the editable install can point
    at a sibling worktree (or differ only in path case) while holding the very same code.
    Comparing bytes with the declared package's file accepts exactly that case; a
    same-named module from anywhere else has different contents and stays refused.
    """
    base = _prime_agent_os.path.basename(origin)
    for expected in (
        _prime_agent_os.path.join(root, "src", name, base),
        _prime_agent_os.path.join(root, name, base),
        _prime_agent_os.path.join(root, "src", base),
        _prime_agent_os.path.join(root, base),
    ):
        try:
            with open(expected, "rb") as want, open(origin, "rb") as got:
                return want.read() == got.read()
        except OSError:
            continue
    return False

def _prime_agent_loaded_skill_wrapper(name):
    """The wrapper an earlier bootstrap of this kernel (or a restored state) already bound."""
    for candidate in (globals().get(name), _prime_agent_sys.modules.get(name)):
        if type(candidate).__name__ == "_PrimeAgentCallableSkillModule":
            return candidate
    return None

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    _prime_agent_existing_wrapper = _prime_agent_loaded_skill_wrapper(_prime_agent_skill_name)
    if _prime_agent_existing_wrapper is not None:
        # A re-bootstrap (kernel restart, restored state) finds the skill it loaded
        # itself: keep it, it is not a foreign module shadowing the name.
        globals()[_prime_agent_skill_name] = _prime_agent_existing_wrapper
        _prime_agent_sys.modules[_prime_agent_skill_name] = _prime_agent_existing_wrapper
        continue
    _prime_agent_restored_module = _prime_agent_restored_skill_module(_prime_agent_skill_name)
    if _prime_agent_restored_module is not None:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(_prime_agent_restored_module)
        continue
    if _prime_agent_skill_name in _prime_agent_reserved_skill_names:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = (
            "refused: this import name is already provided by the kernel "
            "(a loaded module, a kernel global, or the standard library)"
        )
        continue
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        # An exception with an empty message would otherwise be dropped by the
        # host-side parser; fall back to the exception type name.
        _prime_agent_skill_error_text = (
            str(_prime_agent_skill_error) or type(_prime_agent_skill_error).__name__
        )
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = _prime_agent_skill_error_text
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            _prime_agent_skill_error_text,
        )
        # Park the stub in sys.modules too, so 'import name' and 'from name import run'
        # bind the stub and raise the named RuntimeError instead of re-raising the
        # skill's own dependency error from a bare import.
        _prime_agent_sys.modules[_prime_agent_skill_name] = globals()[_prime_agent_skill_name]

_prime_agent_repoint_cross_skill_references()

if _PRIME_AGENT_SKILL_IMPORT_ERRORS:
    import json as _prime_agent_json
    print(
        "${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}"
        + _prime_agent_json.dumps(_PRIME_AGENT_SKILL_IMPORT_ERRORS)
    )
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
/**
 * How long the wait/kill choice waits for a person. With nobody at the keyboard (an
 * unattended run) the question would otherwise block the session forever, so an
 * unanswered prompt restarts the kernel, the same answer a headless session gets.
 */
export const BUSY_KERNEL_CHOICE_TIMEOUT_MS = 60_000;
const BUSY_KERNEL_PROMPT = [
	"Interrupted Python cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
	`With no answer in ${Math.round(BUSY_KERNEL_CHOICE_TIMEOUT_MS / 1000)}s the kernel is restarted automatically.`,
].join("\n");
/**
 * Appended to an aborted cell's result: the output above it is partial, and the
 * kernel may still be running the cell (see `KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE`).
 */
export const IPYTHON_ABORTED_CELL_NOTICE = [
	"<ipython_cell_aborted>",
	'This cell was aborted while it was still running, so any output above is partial. The kernel may still be executing it: the next cell can report "The Python kernel is still running the previously interrupted cell" — retry after a moment; a kernel that stays busy is restarted automatically and its saved state restored.',
	"</ipython_cell_aborted>",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The Python kernel was restarted. Variables, imports, async tasks, and open resources from before the restart may no longer be available; check any restored state and recreate missing resources before using them.",
	"</ipython_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("Python execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IpythonToolInput = Static<typeof ipythonSchema>;

/**
 * Why a cell was aborted, as recorded by the host. Lets the model tell a stall-watchdog
 * kill from a user interrupt, and know which kernel process was involved.
 */
export interface IpythonAbortCause {
	/** Session silence the stall watchdog measured when it aborted the turn, in ms. */
	silentMs?: number;
	/** Machine-readable stall reasons (e.g. `stall_watchdog`, `loop_stalled`). */
	reasons?: readonly string[];
	/** Kernel process id, when the host knows it. */
	kernelPid?: number;
	/** Epoch ms of the abort. */
	at?: number;
}

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Output that arrived without this cell's id (threads, other cells' leftovers), shown separately from stdout. */
	backgroundOutput?: string;
	/** Diffs streamed from file edits, rendered by the cell view. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	/**
	 * True when this result head carries a kernel revival notice: the kernel process died on its
	 * own and a replacement ran this cell. The notice text itself is in the content block.
	 */
	kernelReset?: boolean;
	/** Structured cause when the cell was aborted mid-flight (stall watchdog, host abort). */
	abortCause?: IpythonAbortCause;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have prime-agent-runtime installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every bash() command. */
	commandPrefix?: string;
	/** Shell used by bash(). */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	/**
	 * Fires once per kernel start when installed Python skills failed to import
	 * into the kernel (skill import name -> import error), so the session can tell
	 * the model before it wastes turns calling them.
	 */
	onUnavailableSkills?: (errors: UnavailablePythonSkills) => void;
	/** Fires when the kernel's last live background bash() handle settles, so owed continuations can resume. */
	onBackgroundWorkSettled?: () => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/**
	 * Fires once per kernel death the host did not order (crash, OOM kill), with the structured
	 * cause. The kernel's stderr ring never leaves the host process, so this callback is the only
	 * way the death reaches the session log.
	 */
	onUnexpectedExit?: (cause: KernelDeathCause, facts: KernelUnexpectedExitFacts) => void;
	/**
	 * A namespace snapshot write failed: fired once per failure episode so the session can
	 * show the model a receipt (the write is otherwise invisible outside the stderr ring).
	 */
	onSnapshotFailure?: (detail: string) => void;
	/**
	 * A background prewarm start failed. Without this the failure is invisible until the first
	 * ipython cell - or forever, when the session never runs python (first-run bootstrap errors).
	 */
	onStartupFailure?: (error: Error) => void;
	/**
	 * Live kernel restart budget, read at every unexpected exit. Omit for the shipped defaults
	 * (three revivals per rolling hour, then fail closed).
	 */
	restartPolicy?: () => KernelRestartPolicy;
	/**
	 * Read-only host request types a cell abort may cancel, and the bound one such request gets.
	 * See {@link KernelManagerOptions.cancellableHostRequestTypes}: a side-effecting type must
	 * stay out of the list, or an Esc on the spawning cell kills work the model was promised would
	 * outlive the turn.
	 */
	cancellableHostRequestTypes?: readonly string[];
	readOnlyHostRequestTimeoutMs?: () => number;
	/** A host reply that could not be delivered because the kernel that asked for it was gone. */
	onLateHostReply?: (reply: KernelLateHostReply) => void;
	/**
	 * Read once per aborted cell: the host's record of why the turn was aborted
	 * (for a session, the last stall-watchdog abort). Undefined means "no recorded
	 * cause", and the result then only says the cell was aborted mid-flight.
	 */
	getAbortCause?: () => IpythonAbortCause | undefined;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's Python kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelClient>;
	private startedManager?: KernelClient;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();
	/** Snapshot policy of the dispose that aborted a startup, honored by startKernel's failure teardown. */
	private disposeSnapshot = true;
	/**
	 * Revival budget shared by every manager this provisioner creates. A startup that fails makes
	 * its manager defunct, and the next cell provisions a replacement: without a shared ledger each
	 * replacement would start counting from zero, so a kernel that dies before it is ready - the
	 * most common shape of a broken environment - would be respawned once per cell forever and the
	 * model would never see the fail-closed budget fact (K-P1-1).
	 */
	private readonly restartLedger = new KernelRestartLedger();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelClient | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/**
	 * Start the kernel in the background. Failures surface on the next ensure(); a first-run
	 * bootstrap failure is also reported through {@link IpythonToolOptions.onStartupFailure} -
	 * it used to vanish entirely when the session never ran a python cell (r36 INSB-4/F5).
	 */
	prewarm(): void {
		void this.ensure().catch((error: unknown) => {
			this.options?.onStartupFailure?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/**
	 * Persist the namespace, then remove live variables above the snapshot's
	 * per-variable size limit. Returns the full write result - FR-5: a null
	 * return means the write was refused or failed, and the post-compaction
	 * notice must not claim persistence then.
	 */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.pruneOversizedVariables()) ?? null;
	}

	/**
	 * Whether this kernel has a snapshot target configured at all. Non-persistent
	 * sessions configure none: their snapshot writes are not failures but the
	 * absence of the mechanism (FR-5's post-compaction notice words them apart).
	 */
	hasSnapshotTarget(): boolean {
		return this.options?.snapshotDir !== undefined;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(options?: { snapshot?: boolean }): Promise<void> {
		this.disposeSnapshot = options?.snapshot ?? true;
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true });
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelClient> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		// A kernel the host tore down (an abort-timeout kill, a UI kill, a dispose) can only
		// throw from here on, so drop the memo and let this call provision the replacement.
		// Without it the next cell would be handed the defunct instance and fail closed.
		if (this.startedManager?.isDefunct === true) {
			this.managerPromise = undefined;
			this.startedManager = undefined;
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelClient> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			// Always inject an absolute trusted shell (undefined only on win32
			// without bash, where the runtime's teaching error fires instead).
			const shellPath = resolveKernelBashShell(this.options?.shellPath);
			const commandPrefix = this.options?.commandPrefix;
			const bootstrapCode = buildRlmBootstrapCode(this.options?.pythonSkills);
			const m = new ReplKernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				// bash() reads these to pick its shell and command prefix.
				env: {
					...this.options?.env,
					...(shellPath ? { PRIME_AGENT_BASH_SHELL: shellPath } : {}),
					...(commandPrefix ? { PRIME_AGENT_BASH_COMMAND_PREFIX: commandPrefix } : {}),
				},
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
				stderrLogPath: snapshotDir ? join(snapshotDir, "kernel-stderr.log") : undefined,
				bootstrapCode,
				...(this.options?.onUnexpectedExit ? { onUnexpectedExit: this.options.onUnexpectedExit } : {}),
				...(this.options?.onSnapshotFailure ? { onSnapshotFailure: this.options.onSnapshotFailure } : {}),
				...(this.options?.restartPolicy ? { restartPolicy: this.options.restartPolicy } : {}),
				restartLedger: this.restartLedger,
				...(this.options?.cancellableHostRequestTypes
					? { cancellableHostRequestTypes: this.options.cancellableHostRequestTypes }
					: {}),
				...(this.options?.readOnlyHostRequestTimeoutMs
					? { readOnlyHostRequestTimeoutMs: this.options.readOnlyHostRequestTimeoutMs }
					: {}),
				...(this.options?.onLateHostReply ? { onLateHostReply: this.options.onLateHostReply } : {}),
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting Python kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — the ready timeout,
				// plus the bootstrap lock bound that startupSignal now reaches through
				// ensureKernelPython — so the permit covers only start(). Restore/bootstrap run
				// per-kernel afterwards and are unbounded execute()s; holding the global permit
				// across them could pin it forever on a wedged bootstrap and starve every other
				// session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					const snapshotPath = snapshotPathIn(snapshotDir);
					const snapshotExisted = existsSync(snapshotPath);
					this.emitStartupProgress("Restoring Python state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						// restoreState() resolves null only for a real failure: surface it so the
						// model knows the saved state was not revived. A payload the runtime could
						// not load was isolated aside on disk (`<path>.corrupt-<stamp>`); a load
						// that never finished (a timeout, a teardown) leaves it in place to retry.
						pendingRestore =
							restore ??
							({
								restored: [],
								failed: [],
								path: snapshotPath,
								error: existsSync(snapshotPath)
									? "the saved snapshot exists but could not be restored; it stays on disk unchanged for a later kernel to load, and this kernel starts empty"
									: "the saved snapshot exists but could not be restored (corrupt or unreadable); the kernel starts empty and the failed snapshot was isolated aside on disk",
							} satisfies RestoreResult);
					}
				}
				this.emitStartupProgress("Preparing Python runtime...");
				const bootstrap = await m.execute(bootstrapCode, {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the Python kernel:\n${details}`);
				}
				// Broken skills stay importable-looking placeholders; report them so the
				// model learns before its first call, not from the placeholder's error.
				const unavailableSkills = parseUnavailablePythonSkills(bootstrap.stdout);
				if (unavailableSkills) {
					this.options?.onUnavailableSkills?.(unavailableSkills);
				}
			} catch (error) {
				// Never leak the kernel process if startup fails after spawn — and never
				// surface the failure before the teardown (final snapshot flush included)
				// finished, or a replacement provisioner gated on this dispose could
				// race the still-flushing kernel over the same snapshot files.
				await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true }).catch(() => undefined);
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		// No UI means nobody can be offered the wait/kill choice, and "cancel" only rethrows:
		// the unresponsive kernel keeps burning CPU and every later cell hits the same
		// busy-after-interrupt error, so the session stays soft-bricked. Kill it instead -
		// the next cell provisions a replacement and may restore the last saved snapshot.
		return "kill";
	}
	const askedAt = Date.now();
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
		timeout: BUSY_KERNEL_CHOICE_TIMEOUT_MS,
	});
	// Unanswered until the timeout: nobody is there to choose, so do what a headless
	// session does instead of leaving every later cell blocked on this kernel.
	if (choice === undefined && !signal?.aborted && Date.now() - askedAt >= BUSY_KERNEL_CHOICE_TIMEOUT_MS - 250) {
		return "kill";
	}
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean; resetNotice?: string }> {
	// A kernel that was killed after a previous cell's interrupt grace expired (headless
	// aborts kill instead of preserving) is replaced by this call's ensure(), so the model
	// owes a reset notice on the first cell that runs on the replacement.
	let kernelRestarted = provisioner.manager?.isDefunct === true;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			const result = await m.execute(code, {
				signal,
				// Headless callers get the kill-on-grace-timeout behaviour that an interactive
				// caller gets from the wait/kill prompt below.
				killOnAbortTimeout: !ctx?.hasUI,
				onStream,
				onLateSentAgentMessage: onLateSentAgentMessage
					? (message) => onLateSentAgentMessage(toolCallId, message)
					: undefined,
			});
			// Consumed only for a result that actually reaches the model. A thrown error leaves
			// the notice pending, so the next cell carries it instead of losing it (the model
			// would otherwise never learn that its namespace was rolled back).
			const resetNotice = m.consumeRestartNotice?.(code);
			return { result, kernelRestarted, ...(resetNotice === undefined ? {} : { resetNotice }) };
		} catch (error) {
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for Python kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting Python kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

/** Model-facing result of one executed cell. */
export interface IpythonToolResultAssembly {
	content: (TextContent | ImageContent)[];
	details: IpythonToolDetails;
	isError: boolean;
}

/** Renders the host's abort cause for the model; undefined when there is nothing to say. */
export function formatIpythonAbortCause(cause: IpythonAbortCause | undefined): string | undefined {
	if (!cause) return undefined;
	const parts: string[] = [];
	if (typeof cause.silentMs === "number" && cause.silentMs > 0) {
		parts.push(`the turn was aborted after ${Math.max(1, Math.round(cause.silentMs / 1000))}s of session silence`);
	}
	const reasons = (cause.reasons ?? []).filter((reason) => reason.length > 0);
	if (reasons.length > 0) {
		parts.push(`reasons: ${reasons.join(", ")}`);
	}
	if (typeof cause.kernelPid === "number" && cause.kernelPid > 0) {
		parts.push(`kernel pid ${cause.kernelPid}`);
	}
	if (parts.length === 0) return undefined;
	return `Abort cause: ${parts.join("; ")}.`;
}

/**
 * Builds the model-facing result for one executed cell.
 *
 * An aborted cell keeps whatever output it produced and gains the structured cause:
 * the alternative (a bare "aborted" stub) is what makes a model re-run a long command
 * blind, and re-running it is the expensive part of a stall kill.
 */
export function assembleIpythonToolResult(
	r: ExecuteResult,
	options: { kernelRestarted: boolean; abortCause?: IpythonAbortCause; resetNotice?: string },
): IpythonToolResultAssembly {
	let text = r.stdout;
	if (r.stderr) text += (text ? "\n" : "") + r.stderr;
	if (r.result) text += (text ? "\n" : "") + r.result;
	if (r.status === "error" && r.error) {
		text += (text ? "\n" : "") + r.error.traceback.join("\n");
	}
	if (r.backgroundOutput) {
		text += `${text ? "\n" : ""}[background output (unattributed)]\n${r.backgroundOutput}`;
	}
	if (r.status === "aborted") {
		const cause = formatIpythonAbortCause(options.abortCause);
		const notice = cause ? `${IPYTHON_ABORTED_CELL_NOTICE}\n${cause}` : IPYTHON_ABORTED_CELL_NOTICE;
		text = text ? `${text}\n${notice}` : notice;
	}
	if (options.kernelRestarted) {
		text = text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE;
	}
	if (options.resetNotice) {
		// Above everything else: the rollback facts have to be read before the output of a cell
		// that ran on a replacement kernel is trusted.
		text = text ? `${options.resetNotice}\n\n${text}` : options.resetNotice;
	}

	const imageBlocks = imageBlocksFromAttachments(r.attachments);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

	return {
		content,
		details: {
			durationMs: r.durationMs,
			status: r.status,
			errorEname: r.error?.ename,
			stdout: r.stdout,
			stderr: r.stderr,
			result: r.result,
			backgroundOutput: r.backgroundOutput,
			diffs: r.diffs,
			attachments: r.attachments,
			sentAgentMessages: r.sentAgentMessages,
			kernelRestarted: options.kernelRestarted,
			...(options.resetNotice ? { kernelReset: true as const } : {}),
			error: r.error,
			...(options.abortCause ? { abortCause: options.abortCause } : {}),
		},
		isError: r.status === "error" || r.status === "aborted",
	};
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python code in a persistent Python REPL; run shell commands inside it with `bash('cmd')`, not through a separate shell tool. Top-level `await` is supported. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Run shell commands with `bash('cmd')` / `await bash('cmd')`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent Python REPL for code, state, and bash() orchestration",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			try {
				const {
					result: r,
					kernelRestarted,
					resetNotice,
				} = await executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					params.code,
					signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);

				return assembleIpythonToolResult(r, {
					kernelRestarted,
					...(resetNotice === undefined ? {} : { resetNotice }),
					// Only an aborted cell asks the host why: a finished cell has no cause to report.
					abortCause: r.status === "aborted" ? options?.getAbortCause?.() : undefined,
				});
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
