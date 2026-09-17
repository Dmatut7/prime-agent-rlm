import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getLogger } from "@earendil-works/pi-ai";
import { getPackageDir, isBunBinary } from "../../config.js";
import { readKernelBootstrapSettings } from "../settings-manager.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import {
	claimKernelVenvBootSync,
	decideKernelVenvRebuild,
	generationDirForSuffix,
	KernelVenvRebuildDeferredError,
	kernelVenvDirForPython,
	kernelVenvGenerationSuffix,
	pruneKernelVenvGenerations,
	readKernelVenvInUseState,
} from "./venv-in-use.js";

const bootstrapLog = getLogger("coding-agent.kernel-bootstrap");

const BOOTSTRAP_SCHEMA = 10;
const PYTHON_VERSION = "3.11";
/**
 * Registry name of the Python kernel runtime. Deliberately *not* an install requirement any more:
 * `https://pypi.org/pypi/prime-agent-runtime` is unregistered (404), so installing this bare name
 * means "install whatever a stranger uploads under it next" - into an interpreter that runs the
 * model's Python in-process, with this process's authority. A registry install therefore has to be
 * opted into explicitly and pinned by hand ({@link resolveKernelRuntimeInstall}); this constant is
 * only ever spelled out in the pin check and in error messages.
 */
const RUNTIME_REGISTRY_NAME = "prime-agent-runtime";
/** Opt-in that re-enables a registry install of the runtime when no local source is shipped. */
export const REGISTRY_RUNTIME_ALLOW_ENV = "PRIME_AGENT_KERNEL_ALLOW_REGISTRY_RUNTIME";
/** Exact `name==version` requirement installed when {@link REGISTRY_RUNTIME_ALLOW_ENV} is `1`. */
export const REGISTRY_RUNTIME_SPEC_ENV = "PRIME_AGENT_KERNEL_REGISTRY_RUNTIME_SPEC";
// `-P` (safe path, Python >= 3.11, which prime-agent-runtime requires) keeps the
// current directory off sys.path, so a checkout carrying `rlm/`, `dill.py`, or a
// stdlib-named module cannot shadow the kernel's own imports. Every kernel-python
// invocation must carry it; the process-local flag is preferred over
// PYTHONSAFEPATH, which the kernel's bash() children would inherit.
export const KERNEL_PYTHON_SAFE_PATH_ARGS: readonly string[] = ["-P"];
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
/**
 * Default packages the kernel can import on the model's behalf, pinned to exact versions.
 *
 * Pinned on purpose: an unpinned name is re-resolved to whatever is newest at every boot, so a new
 * machine silently installs Python nobody reviewed into the interpreter that already holds the
 * model's session state. Each version is the newest stable release whose `requires_python` accepts
 * PYTHON_VERSION (3.11); `uv pip install` resolves the whole set together for that interpreter, so
 * the pair is self-consistent. Bumping a pin is a deliberate change: the list is part of the venv
 * generation identity, so it rebuilds each kernel venv exactly once.
 */
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests==2.34.2", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx==0.28.1", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml==6.0.3", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli==2.4.1", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv==1.2.3", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas==3.0.5", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy==2.4.6", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy==1.17.1", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4==4.15.0", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml==6.1.3", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic==2.13.5", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro==1.0.16", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const UV_INSTALL_COMMAND = "curl --max-time 120 -LsSf https://astral.sh/uv/install.sh | sh";
/**
 * Hard ceiling for one uv subprocess (r36 INSB-3/F6): without it, a proxy that blackholes or a
 * wedged DNS lookup leaves the first run silent forever - the user's last visible line is the
 * "~30s" progress message. Generous on purpose: `uv pip install` legitimately moves hundreds of
 * MB on slow links. Overridable for tests via PRIME_AGENT_KERNEL_UV_TIMEOUT_MS.
 */
const DEFAULT_UV_COMMAND_TIMEOUT_MS = 900_000;
/**
 * One python invocation, fed over stdin, that imports every default package (r36 INSB-4/F3): the
 * warm path used to trust the manifest alone, so a venv whose packages were uninstalled after the
 * fact stayed "ready" forever and failed far from the cause. Stdin (rather than `-c`) keeps the
 * argv shape distinct from the readiness probes.
 */
const RLM_EXTRA_IMPORTS_PROBE_SCRIPT = [
	"import importlib, sys",
	`names = ${JSON.stringify(DEFAULT_RLM_EXTRA_IMPORT_NAMES)}`,
	"missing = []",
	"for name in names:",
	"    try:",
	"        importlib.import_module(name)",
	"    except BaseException:",
	"        missing.append(name)",
	"sys.exit(1 if missing else 0)",
].join("\n");

function uvCommandTimeoutMs(): number {
	const raw = Number.parseInt(process.env.PRIME_AGENT_KERNEL_UV_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UV_COMMAND_TIMEOUT_MS;
}
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
// Range, not equality: the runtime this check runs against is the copy installed in the venv,
// which comes from resolveRuntimeSourceDir() — on a built checkout that is
// dist/prime-agent-runtime, i.e. it keeps reporting the old PROTOCOL_VERSION until the next
// `npm run build`. Demanding an exact version here would fail every boot (and, with the
// generation directories, defer it outright while any kernel is alive) across the whole
// window between a runtime source change and the build that ships it. The bounds must track
// REPL_PROTOCOL_VERSION_MIN / REPL_PROTOCOL_VERSION in repl-manager.ts.
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert hasattr(rlm, 'run'); assert callable(rlm); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert 3 <= _repl.PROTOCOL_VERSION <= 4; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_VERSION_TMP_FILE = `${BOOTSTRAP_VERSION_FILE}.tmp`;
// Bounded retry for the atomic marker swap: replacing an existing marker can
// fail while a scanner or editor holds the file open.
const BOOTSTRAP_MARKER_SWAP_ATTEMPTS = 3;
const BOOTSTRAP_MARKER_SWAP_RETRY_MS = 50;
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;

interface InFlightBootstrap {
	key: string;
	promise: Promise<string>;
	/** Aborts the shared boot once every attached caller has aborted. */
	controller: AbortController;
	waiters: number;
	aborted: number;
}

let inFlightEnsureKernelPython: InFlightBootstrap | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
	/**
	 * Cancels the wait for the bootstrap lock and the installs it guards. Sessions in one
	 * process share one memoized bootstrap, so the work is cancelled only once every caller
	 * attached to it has aborted (see {@link ensureKernelPython}).
	 */
	signal?: AbortSignal;
	/**
	 * Bound for waiting on the bootstrap lock, in milliseconds; 0 waits forever. Defaults to
	 * the `kernelBootstrap.lockTimeoutMs` setting, read when the wait actually starts.
	 */
	lockTimeoutMs?: number;
}

/** One Python skill as recorded in the venv's `.bootstrap-version` manifest. */
export interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
	/**
	 * Path-independent fingerprint of the content this skill's editable install resolves to
	 * ({@link pythonSkillContentHash}). Absent in a manifest written before fingerprints existed,
	 * which reads as "not installed": one reinstall upgrades the record.
	 *
	 * This is what makes the manifest usable by more than one checkout. The install itself is
	 * editable and therefore names an absolute path, but two checkouts of the same commit install
	 * byte-identical content under different paths, and comparing paths made every alternating
	 * boot reinstall the whole skill set under the machine-wide bootstrap lock (K-P1-2).
	 */
	contentHash?: string;
}

interface BootstrapVersion {
	schema: number;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

/**
 * The bootstrap lock stayed held past its bound. Thrown instead of waiting forever: an
 * unbounded wait here is invisible to the user (the session shows "Starting Python
 * kernel...") until the stall watchdog aborts the turn minutes later. The message has to
 * carry a way out, because turning "slow" into "failed" is only acceptable if the failure
 * is actionable.
 */
export class KernelBootstrapLockTimeoutError extends Error {
	readonly lockDir: string;
	readonly waitedMs: number;
	readonly holderPid: number | null;

	constructor(lockDir: string, waitedMs: number, holderPid: number | null) {
		super(
			`Timed out after ${Math.round(waitedMs / 1000)}s waiting for the kernel venv bootstrap lock at ${lockDir}` +
				`${holderPid === null ? " (holder pid unknown)" : ` (held by pid ${holderPid})`}. ` +
				"Another prime-agent process is preparing the Python kernel there: wait for it, stop it, or remove that lock directory if it is wedged. " +
				"Raise kernelBootstrap.lockTimeoutMs in settings to wait longer (0 waits forever), or set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap.",
		);
		this.name = "KernelBootstrapLockTimeoutError";
		this.lockDir = lockDir;
		this.waitedMs = waitedMs;
		this.holderPid = holderPid;
	}
}

/** Every session waiting on one shared bootstrap aborted, so the work was cancelled. */
export class KernelBootstrapAbortedError extends Error {
	constructor(detail: string) {
		super(`Kernel venv bootstrap aborted: ${detail}`);
		this.name = "KernelBootstrapAbortedError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

/** Fingerprint returned for a package path that is not there any more. */
const MISSING_PACKAGE_HASH = "missing";
/**
 * Directories that never take part in what an editable install resolves to. `__pycache__` is the
 * load-bearing one: a kernel importing the skill writes `.pyc` files *into the source tree*, so
 * counting them would change the fingerprint on every boot and reinstall the skill forever.
 */
const SKILL_CONTENT_IGNORED_DIRS = new Set([
	"__pycache__",
	".git",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".venv",
	"node_modules",
]);
const SKILL_CONTENT_IGNORED_SUFFIXES = [".pyc", ".pyo", ".egg-info"];

function collectSkillContentFiles(dir: string, files: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Symlinks are not followed: a link out of the package would make the fingerprint depend
		// on a tree this build does not own.
		if (entry.isSymbolicLink()) continue;
		if (SKILL_CONTENT_IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKILL_CONTENT_IGNORED_DIRS.has(entry.name)) continue;
			collectSkillContentFiles(full, files);
			continue;
		}
		if (entry.isFile()) files.push(full);
	}
}

/**
 * Path-independent fingerprint of the content one skill's editable install resolves to: its
 * packaging metadata plus everything under `src/` (the wheel hatchling builds from
 * `packages = ["src/<import_name>"]`). Deliberately *not* the whole package directory: a
 * `SKILL.md` or a `references/` edit cannot change what the kernel imports, and letting it
 * change the fingerprint would make two checkouts fight over the shared install over prose.
 *
 * A package with no `src/` falls back to every file it has (minus the ignored ones), so an
 * unusual layout still gets a content-addressed fingerprint rather than an empty one.
 */
export function pythonSkillContentHash(packagePath: string): string {
	if (!existsSync(packagePath)) return MISSING_PACKAGE_HASH;
	const files: string[] = [];
	const srcDir = path.join(packagePath, "src");
	if (existsSync(srcDir)) {
		files.push(path.join(packagePath, "pyproject.toml"));
		collectSkillContentFiles(srcDir, files);
	} else {
		collectSkillContentFiles(packagePath, files);
		files.push(path.join(packagePath, "pyproject.toml"));
	}
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(packagePath, file));
		hash.update("\0");
		try {
			hash.update(readFileSync(file));
		} catch {
			// Unreadable content is its own fingerprint input: it must not read as "empty package".
			hash.update("unreadable");
		}
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Whether a recorded install still holds the content its fingerprint was taken from.
 *
 * The install is editable, so it resolves to whichever checkout wrote the record - a directory
 * this process does not own and cannot assume is still there. A checkout that was deleted (the
 * record then points at nothing), moved, or edited underneath the record makes it a lie, and a
 * lie has to cost one reinstall: the alternative is a kernel whose skill imports fail, or that
 * silently runs another tree's code while its manifest claims this one.
 */
export function pythonSkillInstallIsFaithful(entry: BootstrapPythonSkill): boolean {
	if (entry.contentHash === undefined) return false;
	return pythonSkillContentHash(entry.packagePath) === entry.contentHash;
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
			contentHash: pythonSkillContentHash(packagePath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort(compareBootstrapPythonSkills);
}

/** Stable record order, so the manifest stays byte-identical across boots. */
function compareBootstrapPythonSkills(a: BootstrapPythonSkill, b: BootstrapPythonSkill): number {
	const packageCompare = a.packagePath.localeCompare(b.packagePath);
	if (packageCompare !== 0) return packageCompare;
	return a.importName.localeCompare(b.importName);
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
			contentHash: pythonSkillContentHash(packagePath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

/**
 * Everything that makes a built venv interchangeable. Two builds with the same key are
 * the same generation; any difference (interpreter line, runtime source, bootstrap schema,
 * snapshot requirement, default packages) gets its own directory, so a generation a kernel is
 * running from is never rebuilt under it.
 *
 * The interpreter line is part of the key (L8D-2): bytecode and the venv's installed
 * binaries are only interchangeable within one major.minor line, so bumping
 * PYTHON_VERSION must move to a fresh generation instead of rm-and-rebuilding the
 * same directory a live kernel is running from. The skills note below is why that
 * rule does not extend to everything installable.
 *
 * The requested Python skills are deliberately *not* part of this key. They are per-session (a
 * session may enable a subset, and the record inside the generation is a union so subsets can
 * share it), and `pruneKernelVenvGenerations` keeps only one unreferenced generation: keying the
 * directory on the skill set would give every subset its own ~30s build and then have those
 * builds delete each other. Skill differences are reconciled inside the generation instead - by
 * content, never by absolute path (see {@link pythonSkillsSatisfied}, K-P1-2).
 */
function kernelVenvBuildIdentity(runtimeIdentity: string, pythonVersion: string = PYTHON_VERSION): string {
	return JSON.stringify({
		python: pythonVersion,
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
	});
}

/**
 * The generation directory for one runtime identity: `<base>-<12 hex>`. The base itself is
 * never used as a venv any more; it only names the family and holds the bootstrap lock.
 */
export function kernelVenvDirForIdentity(
	base: string,
	runtimeIdentity: string,
	pythonVersion: string = PYTHON_VERSION,
): string {
	return generationDirForSuffix(
		base,
		kernelVenvGenerationSuffix(kernelVenvBuildIdentity(runtimeIdentity, pythonVersion)),
	);
}

/** The generation directory this checkout's runtime identity resolves to. */
export async function activeKernelVenvDir(base: string): Promise<string> {
	return kernelVenvDirForIdentity(base, await resolveRuntimeIdentity());
}

/**
 * The managed generation a kernel python path belongs to, or undefined for an interpreter
 * bootstrap does not own (PRIME_AGENT_KERNEL_PYTHON, a project venv, or the legacy
 * unsuffixed directory). Only managed generations carry the in-use references that keep a
 * rebuild from deleting a live kernel's tree.
 */
export function managedKernelVenvDirForPython(python: string): string | undefined {
	return kernelVenvDirForPython(python, [getKernelVenvDir(), getXdgKernelVenvDir()]);
}

/** Legacy venv directories already reported, so a boot mentions one at most once. */
const reportedLegacyKernelVenvDirs = new Set<string>();

/**
 * The unsuffixed venv directory predates generations. Kernels spawned by older hosts run
 * from it without leaving references, so "no references" is not evidence that it is free:
 * it is never rebuilt, renamed, or deleted here, only reported.
 */
function reportLegacyKernelVenv(base: string, options: EnsureKernelPythonOptions): void {
	if (!options.onProgress || reportedLegacyKernelVenvDirs.has(base)) return;
	if (!existsSync(path.join(base, "pyvenv.cfg"))) return;
	reportedLegacyKernelVenvDirs.add(base);
	reportProgress(
		options,
		`note: ${base} is a pre-generation kernel venv that this build no longer uses; ` +
			"remove it to reclaim the disk space once no older prime-agent host is running",
	);
}

/**
 * A subprocess failure whose own stderr was captured. Carrying that text matters because uv's
 * diagnostics name the real cause (ENOSPC, EACCES, index errors, proxy failures); without it every
 * failure collapses into an opaque "failed with exit code N" (r36 INSB-3).
 */
class KernelSubprocessError extends Error {
	readonly subprocessStderr: string | undefined;

	constructor(message: string, subprocessStderr?: string) {
		super(message);
		this.name = "KernelSubprocessError";
		this.subprocessStderr = subprocessStderr;
	}
}

interface RunCommandOptions {
	stdio?: "ignore" | "inherit";
	signal?: AbortSignal;
	/** Hard ceiling for this subprocess; a step that never answers cannot hang a first run. */
	timeoutMs?: number;
	/** Captures stderr and attaches it to the failure message. */
	captureStderr?: boolean;
	/** Script fed to the child's stdin (used with `-` args). */
	stdinScript?: string;
}

function run(command: string, args: string[], options: RunCommandOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancelled = (): Error => new KernelBootstrapAbortedError(`${command} ${args.join(" ")} was cancelled`);
		const commandLine = `${command} ${args.join(" ")}`;
		let stderrText: string | undefined;
		let stderrChunks = "";
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const defaultIo: "ignore" | "inherit" = options.stdio ?? "ignore";
		const stdio: ("ignore" | "inherit" | "pipe")[] = [
			options.stdinScript !== undefined ? "pipe" : defaultIo,
			options.captureStderr ? "ignore" : defaultIo,
			options.captureStderr ? "pipe" : defaultIo,
		];
		const child = spawn(command, args, {
			env: process.env,
			stdio,
			// Kills the child on abort, so a cancelled boot does not leave a uv install running.
			signal: options.signal,
		});
		if (options.stdinScript !== undefined && child.stdin !== null) {
			child.stdin.on("error", () => undefined);
			child.stdin.end(options.stdinScript);
		}
		if (options.captureStderr) {
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("error", () => undefined);
			child.stderr?.on("data", (chunk: string) => {
				// Keep a bounded tail: uv can be verbose, and the diagnostic is at the end.
				stderrChunks = (stderrChunks + chunk).slice(-16_384);
			});
		}
		if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
			killTimer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
		}
		const clearTimer = (): void => {
			if (killTimer !== undefined) clearTimeout(killTimer);
		};
		child.on("error", (error) => {
			clearTimer();
			// An abort before or during spawn surfaces here as an AbortError; report the
			// cancellation rather than the opaque underlying reason.
			reject(options.signal?.aborted ? cancelled() : error);
		});
		child.on("exit", (code, signal) => {
			clearTimer();
			if (options.captureStderr && stderrChunks.trim() !== "") {
				stderrText = stderrChunks;
			}
			if (options.signal?.aborted) {
				reject(cancelled());
				return;
			}
			if (code === 0 && !timedOut) {
				resolve();
				return;
			}
			const reason = timedOut
				? `timed out after ${options.timeoutMs}ms`
				: signal
					? `signal ${signal}`
					: `exit code ${code}`;
			const stderrDetail = stderrText !== undefined ? `\n${stderrText.trim().slice(-4_000)}` : "";
			reject(new KernelSubprocessError(`${commandLine} failed with ${reason}${stderrDetail}`, stderrText));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * What a Python interpreter is missing to serve as the kernel runtime: the runtime API itself, then
 * the default packages the kernel imports on the model's behalf. Shared by the
 * `PRIME_AGENT_KERNEL_PYTHON` contract check and the post-install recheck, so both name a gap the
 * same way.
 */
async function missingKernelRuntimeLabels(python: string): Promise<string[]> {
	if (!(await hasPrimeAgentRuntime(python))) {
		return [
			"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
		];
	}
	const missingExtraImports = await missingRlmExtraImportLabels(python);
	return missingExtraImports.length > 0 ? [`default Python packages (${missingExtraImports.join(", ")})`] : [];
}

/**
 * A successful `uv pip install` is not evidence that the runtime it installed can serve this host:
 * the install can copy an older runtime in, and the readiness check the warm path relies on is only
 * ever reached *before* an install. Re-run it here, so a fresh generation that cannot serve the
 * kernel fails where it was created, naming what is missing, instead of reporting "ready" and
 * failing later inside the kernel.
 */
async function verifyFreshKernelRuntime(venv: string, python: string): Promise<void> {
	const missing = await missingKernelRuntimeLabels(python);
	if (missing.length === 0) return;
	throw new Error(
		`the runtime installed into ${venv} did not pass its readiness check: it is missing ${missing.join(" and ")}. ` +
			"Nothing will run from this generation. Re-run this command to rebuild it; if it fails again, check that uv " +
			"can reach a current prime-agent-runtime (network, index, or a pre-populated uv cache), or point " +
			"PRIME_AGENT_KERNEL_PYTHON at a Python that already has one installed.",
	);
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function readLockPid(lockDir: string): Promise<number | null> {
	try {
		const raw = await readFile(path.join(lockDir, "pid"), "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

/**
 * Waits for the machine-wide bootstrap lock. Both exits are checked before every retry, so
 * the wait is bounded by `timeoutMs` and interruptible by `signal`; it used to be neither,
 * which is how a wedged holder turned one stuck kernel start into a session that only the
 * 900s stall watchdog could end. Breaking a provably abandoned lock is unchanged.
 */
/**
 * The bootstrap lock directory could not be created (r36 INSB-3/F2): a read-only HOME, an NFS-RO
 * mount, or a full disk used to leak a bare `EACCES: permission denied, mkdir ...` from outside
 * the try/catch that wraps bootstrap failures, with no kernel context and no way out.
 */
class KernelBootstrapLockCreateError extends Error {
	constructor(lockDir: string, cause: unknown) {
		super(
			`couldn't create the kernel bootstrap lock at ${lockDir}: ${errorMessage(cause)} ` +
				`Fix permissions on ${path.dirname(lockDir)} (or free space on that volume), or set ` +
				"PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime installed to skip auto-bootstrap.",
		);
		this.name = "KernelBootstrapLockCreateError";
	}
}

async function acquireBootstrapLock(
	venv: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	try {
		await mkdir(path.dirname(lockDir), { recursive: true });
	} catch (error) {
		throw new KernelBootstrapLockCreateError(lockDir, error);
	}

	const timeoutMs = options.timeoutMs ?? readKernelBootstrapSettings().lockTimeoutMs;
	const startedAt = Date.now();
	const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : undefined;

	for (;;) {
		if (options.signal?.aborted) {
			throw new KernelBootstrapAbortedError(`every session waiting for the bootstrap lock at ${lockDir} aborted`);
		}
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) {
				throw error instanceof KernelBootstrapLockCreateError
					? error
					: new KernelBootstrapLockCreateError(lockDir, error);
			}

			const pid = await readLockPid(lockDir);
			if (pid === null ? await lockMissingPidIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			if (deadline !== undefined && Date.now() >= deadline) {
				throw new KernelBootstrapLockTimeoutError(lockDir, Date.now() - startedAt, pid);
			}

			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? [name, `${name}.exe`] : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], {
			stdio: options.onProgress ? "ignore" : "inherit",
			signal: options.signal,
			timeoutMs: uvCommandTimeoutMs(),
		});
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${UV_INSTALL_COMMAND}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string" &&
						(v.contentHash === undefined || typeof v.contentHash === "string")
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

/**
 * Readiness is a subset test, not an equality test: every requested skill must appear in the
 * recorded set with the same *content*, while entries the record keeps for skills this session
 * did not request are harmless. Two sessions with different skill sets then share one venv
 * instead of rewriting the record back and forth and reinstalling on every boot.
 *
 * The comparison is path-independent on purpose (K-P1-2). One import name can only have one
 * editable install, so a recorded entry from another checkout used to be treated as a conflict
 * and reinstalled - and because two checkouts of the same commit have identical content under
 * different absolute paths, every alternating boot reinstalled the whole set under the
 * machine-wide bootstrap lock, each one flipping the record to its own tree. Content is the
 * actual question: an install of the same bytes serves both checkouts.
 *
 * Content equality is not enough on its own, because the install points at the *other* tree: it
 * also has to still be there and still hold those bytes ({@link pythonSkillInstallIsFaithful}).
 * A checkout that was deleted or edited underneath the record fails here and costs one
 * reinstall, which is how a dangling editable install repairs itself.
 *
 * The compared facts mirror the per-skill skip condition in {@link syncPythonSkills}, so
 * "satisfied" means exactly "a sync would install nothing".
 */
export function pythonSkillsSatisfied(
	installed: readonly BootstrapPythonSkill[] | undefined,
	requested: readonly BootstrapPythonSkill[],
	installIsFaithful: (entry: BootstrapPythonSkill) => boolean = pythonSkillInstallIsFaithful,
): boolean {
	const recorded = new Map((installed ?? []).map((skill) => [skill.importName, skill]));
	return requested.every((skill) => {
		const entry = recorded.get(skill.importName);
		if (entry === undefined || entry.contentHash === undefined) return false;
		return entry.contentHash === skill.contentHash && installIsFaithful(entry);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity) &&
		pythonSkillsSatisfied(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null, runtimeIdentity: string): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

/**
 * Union of the recorded skills and the ones this boot installed, deduped by import name
 * with the freshly installed entry winning (it carries the hash now on disk). Readiness is
 * a subset test, so keeping entries for skills this session never requested is what lets
 * sessions with different skill sets share one venv: without the union, a narrow session
 * rewrites the record down to its own set and the next wide session reinstalls everything.
 */
function mergePythonSkillRecords(
	previous: readonly BootstrapPythonSkill[] | undefined,
	installed: readonly BootstrapPythonSkill[],
): BootstrapPythonSkill[] {
	const byImportName = new Map<string, BootstrapPythonSkill>();
	for (const skill of previous ?? []) {
		byImportName.set(skill.importName, skill);
	}
	for (const skill of installed) {
		byImportName.set(skill.importName, skill);
	}
	return [...byImportName.values()].sort(compareBootstrapPythonSkills);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	// Re-read immediately before writing: every writer holds the bootstrap lock, but the
	// caller's copy of the record predates the installs it just performed.
	const previous = (await readBootstrapVersion(venv))?.pythonSkills;
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: mergePythonSkillRecords(previous, pythonSkills),
	};
	const filePath = path.join(venv, BOOTSTRAP_VERSION_FILE);
	const tmpPath = path.join(venv, BOOTSTRAP_VERSION_TMP_FILE);
	const serialized = `${JSON.stringify(version)}\n`;
	// Write-then-rename is atomic: a kill mid-write can never leave a partial
	// marker, which would read as absent and force a full venv rebuild. Replacing
	// an existing marker can fail transiently while another process holds it, so
	// retry the swap. A marker that stays unwritten is only stale - the next
	// startup re-syncs skills - whereas an in-place overwrite truncated by a
	// failure or a kill reads as absent and rebuilds the whole venv.
	let lastError: unknown;
	for (let attempt = 1; attempt <= BOOTSTRAP_MARKER_SWAP_ATTEMPTS; attempt += 1) {
		try {
			await writeFile(tmpPath, serialized, "utf8");
			await rename(tmpPath, filePath);
			return;
		} catch (error) {
			lastError = error;
			// Retry below; the previous marker is still intact.
		}
		if (attempt < BOOTSTRAP_MARKER_SWAP_ATTEMPTS) await sleep(BOOTSTRAP_MARKER_SWAP_RETRY_MS);
	}
	// Give up without overwriting the marker in place: the untouched previous
	// marker stays valid. The failure still surfaces - a marker this process
	// cannot write is one the next startup cannot trust.
	await rm(tmpPath, { force: true }).catch(() => undefined);
	throw lastError;
}

/**
 * Where one runtime resolution looks for the runtime it will install. Injectable so the layouts
 * below can be exercised from a temp tree; every production caller takes the defaults.
 */
export interface RuntimeSourceResolution {
	/** Directory holding the module asking for the runtime. Defaults to this module's directory. */
	moduleDir?: string;
	/** Package directory that owns that module. Defaults to {@link getPackageDir}. */
	packageDir?: string;
	/** True for a Bun compiled binary, which ships its assets next to the executable. */
	bunBinary?: boolean;
}

function resolveRuntimeSourceResolution(options: RuntimeSourceResolution): Required<RuntimeSourceResolution> {
	return {
		moduleDir: options.moduleDir ?? path.dirname(fileURLToPath(import.meta.url)),
		packageDir: options.packageDir ?? getPackageDir(),
		bunBinary: options.bunBinary ?? isBunBinary,
	};
}

/**
 * True when the running module graph is the checkout's own `src/`. `./prime-agent.sh` runs tsx over
 * `src/cli.ts`, so such a process is executing the code the user edits and must install the
 * checkout's `prime-agent-runtime` - the sibling directory those edits land in. A built tree
 * (`dist/`, `dist/bundle/`, a Bun binary) runs outside `src/` and keeps choosing the build output
 * copy it shipped with.
 */
function isSourceModuleDir(moduleDir: string, packageDir: string): boolean {
	const sourceRoot = `${path.resolve(packageDir, "src")}${path.sep}`;
	return `${path.resolve(moduleDir)}${path.sep}`.startsWith(sourceRoot);
}

/**
 * Runtime directories to try, most preferred first.
 *
 * `dist/prime-agent-runtime` is a build output: it is the only path stable across every shipped
 * layout (dist/, dist/bundle/, bun), where import.meta.url-relative resolution breaks, so a built
 * tree reads it first. A source run must not: that copy is whatever the last `npm run build` left
 * behind, and preferring it makes edits to `<checkout>/prime-agent-runtime/src/rlm` invisible - the
 * identity hash never moves, so the venv generation is reused and the kernel keeps running the old
 * Python with no error and no notice. Editing live runtime source therefore has to win over the
 * copy; the copy stays in the list as the last resort for a checkout that ships no source runtime.
 */
export function runtimeCandidateDirs(options: RuntimeSourceResolution = {}): string[] {
	const { moduleDir, packageDir, bunBinary } = resolveRuntimeSourceResolution(options);
	const builtDir = path.join(packageDir, "dist", "prime-agent-runtime");
	const checkoutDir = path.resolve(packageDir, "..", "..", "prime-agent-runtime");
	const moduleRelative = [
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
	const ordered = bunBinary
		? [builtDir, ...moduleRelative]
		: isSourceModuleDir(moduleDir, packageDir)
			? [checkoutDir, ...moduleRelative, builtDir]
			: [builtDir, ...moduleRelative];
	return [...new Set(ordered)];
}

export async function resolveRuntimeSourceDir(options: RuntimeSourceResolution = {}): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs(options)) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

/**
 * Whether one requirement string pins an exact version (`name==x.y.z`). Ranges, wildcards and bare
 * names all resolve to "something newer later", which is exactly the property that makes a registry
 * install unreviewable.
 */
export function isPinnedRequirementSpec(spec: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?==[A-Za-z0-9][A-Za-z0-9._+!-]*$/.test(spec.trim());
}

/**
 * This install ships no runtime source to install, and a registry install is not allowed (or was
 * asked for without an exact pin). Carries its own actionable text; never wraps another error.
 */
export class KernelRuntimeSourceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelRuntimeSourceUnavailableError";
	}
}

function runtimeSourceUnavailableError(): KernelRuntimeSourceUnavailableError {
	return new KernelRuntimeSourceUnavailableError(
		`This installation ships no "${RUNTIME_REGISTRY_NAME}" Python source to install, and the registry ` +
			`fallback is refused. "${RUNTIME_REGISTRY_NAME}" is unregistered on PyPI ` +
			`(https://pypi.org/pypi/${RUNTIME_REGISTRY_NAME} returns 404), so installing that bare name would ` +
			"install whatever package is published under it next, and the kernel imports it in-process with " +
			"this process's authority: whoever registers the name first would get code execution inside the " +
			"kernel. Install one of these instead:\n" +
			`  - a prime-agent build that ships its runtime source (the Python package in the checkout's "${RUNTIME_REGISTRY_NAME}/" directory), or\n` +
			"  - set PRIME_AGENT_KERNEL_PYTHON to a Python that already has a current " +
			`${RUNTIME_REGISTRY_NAME} and the default Python packages installed (bootstrap is skipped), or\n` +
			`  - opt into a registry install explicitly with ${REGISTRY_RUNTIME_ALLOW_ENV}=1 and pin the exact ` +
			`version in ${REGISTRY_RUNTIME_SPEC_ENV} (for example "${RUNTIME_REGISTRY_NAME}==1.2.3"). An unpinned ` +
			"or ranged requirement is refused, because it would reintroduce the same unresolved-name install.",
	);
}

function registryRequirementFromEnv(env: NodeJS.ProcessEnv): string {
	const spec = env[REGISTRY_RUNTIME_SPEC_ENV]?.trim() ?? "";
	if (!spec) {
		throw new KernelRuntimeSourceUnavailableError(
			`${REGISTRY_RUNTIME_ALLOW_ENV}=1 allows a registry install of the kernel runtime, but ` +
				`${REGISTRY_RUNTIME_SPEC_ENV} is unset. Set it to the exact requirement to install, for example ` +
				`"${RUNTIME_REGISTRY_NAME}==1.2.3". Open-ended requirements are refused: the index name ` +
				`"${RUNTIME_REGISTRY_NAME}" is unregistered, so the resolved version has to be a version you ` +
				"checked and pinned.",
		);
	}
	if (!isPinnedRequirementSpec(spec)) {
		throw new KernelRuntimeSourceUnavailableError(
			`${REGISTRY_RUNTIME_SPEC_ENV}="${spec}" is not an exact "name==version" pin. Pin the version, for ` +
				`example "${RUNTIME_REGISTRY_NAME}==1.2.3"; a bare name, a range or a wildcard resolves to whatever ` +
				`is published under "${RUNTIME_REGISTRY_NAME}" later, which is the install this check exists to refuse.`,
		);
	}
	return spec;
}

/** What a fresh kernel venv is built from: the requirement to install and its generation identity. */
export interface KernelRuntimeInstall {
	/** uv/pip requirement: a local runtime source path, or an explicitly pinned registry spec. */
	requirement: string;
	/** Venv generation identity. Never the bare registry name (see {@link RUNTIME_REGISTRY_NAME}). */
	identity: string;
	/** The local runtime source directory, or null for an opted-in registry install. */
	sourceDir: string | null;
}

/**
 * The runtime a fresh generation installs, resolved from the layouts above.
 *
 * A local source still wins and is identified by content, so any runtime code or dependency change
 * invalidates an existing venv automatically. With no local source the only accepted answer is an
 * explicitly opt-in, exactly pinned registry requirement: the bare registry name is never returned,
 * neither as a requirement nor as an identity, because naming it is what turns an unreviewed package
 * into in-process code execution (see {@link runtimeSourceUnavailableError}).
 */
export async function resolveKernelRuntimeInstall(
	options: RuntimeSourceResolution = {},
): Promise<KernelRuntimeInstall> {
	const sourceDir = await resolveRuntimeSourceDir(options);
	if (sourceDir) {
		return { requirement: sourceDir, identity: await hashRuntimeSource(sourceDir), sourceDir };
	}
	if (process.env[REGISTRY_RUNTIME_ALLOW_ENV] !== "1") {
		throw runtimeSourceUnavailableError();
	}
	const requirement = registryRequirementFromEnv(process.env);
	return { requirement, identity: `registry:${requirement}`, sourceDir: null };
}

/**
 * Identity of the runtime to be installed: a content hash for a local source checkout, or the exact
 * pinned spec for an opted-in registry install. Never the bare registry name.
 */
export async function resolveRuntimeIdentity(options: RuntimeSourceResolution = {}): Promise<string> {
	return (await resolveKernelRuntimeInstall(options)).identity;
}

/**
 * Why a runtime that resolved to the build output copy may still be the wrong source: on a built
 * tree that is the "runtime source was edited but not rebuilt" state, and it is the one way this
 * process can end up running Python older than the checkout next to it. Undefined when there is
 * nothing to say - a source run (which installs the checkout source itself), a build copy whose
 * contents match the checkout, or no checkout source at all.
 */
export async function runtimeSourceShadowNotice(options: RuntimeSourceResolution = {}): Promise<string | undefined> {
	const { packageDir } = resolveRuntimeSourceResolution(options);
	const builtDir = path.join(packageDir, "dist", "prime-agent-runtime");
	const checkoutDir = path.resolve(packageDir, "..", "..", "prime-agent-runtime");
	if ((await resolveRuntimeSourceDir(options)) !== builtDir) return undefined;
	let buildIdentity: string;
	let checkoutIdentity: string;
	try {
		buildIdentity = await hashRuntimeSource(builtDir);
		checkoutIdentity = await hashRuntimeSource(checkoutDir);
	} catch {
		// A missing or unreadable checkout runtime is not a shadowed source.
		return undefined;
	}
	if (buildIdentity === checkoutIdentity) return undefined;
	return (
		`the kernel runtime resolved to the build copy at ${builtDir}, whose contents differ from ${checkoutDir} ` +
		`(${buildIdentity} vs ${checkoutIdentity}). Edits under ${path.join(checkoutDir, "src", "rlm")} do not take ` +
		"effect until `npm run build` refreshes the copy; ./prime-agent.sh runs the checkout's source runtime instead."
	);
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to a registry identity: recording one for a local checkout would
// permanently mask later source changes.
async function hashRuntimeSource(sourceDir: string): Promise<string> {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	async function collect(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	await collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/** Reported once per process rather than once per boot: it describes the installation, not the boot. */
let runtimeSourceShadowReported = false;

async function reportRuntimeSourceShadow(options: EnsureKernelPythonOptions): Promise<void> {
	if (runtimeSourceShadowReported) return;
	runtimeSourceShadowReported = true;
	const notice = await runtimeSourceShadowNotice();
	if (!notice) return;
	// The machine-wide log and the session's own progress output: a silently older kernel is the
	// failure this warns about, so it must not end up only in a log file nobody reads.
	bootstrapLog.warn(notice, { notice: "runtime-source-shadowed-by-build-copy" });
	reportProgress(options, `Warning: ${notice}`);
}

/**
 * The interpreter path inside one managed kernel venv. uv lays a Windows venv
 * out as `Scripts\python.exe` and a POSIX venv out as `bin/python`; the
 * readiness probes and the `uv pip install --python` argument address that
 * file directly, so a POSIX literal on win32 never exists and the kernel
 * cannot boot (`venv-in-use.ts` already accepts both bin and scripts layouts).
 */
export function kernelVenvInterpreter(venv: string): string {
	return process.platform === "win32"
		? path.win32.join(venv, "Scripts", "python.exe")
		: path.join(venv, "bin", "python");
}

/**
 * The one `uv pip install` argv a fresh generation is built from. Exported so the requirement shape
 * (runtime + snapshot + pinned default packages) is assertable without a network or a real install.
 */
export function kernelInstallArgs(python: string, runtimeRequirement: string): string[] {
	return [
		"pip",
		"install",
		"--python",
		python,
		runtimeRequirement,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	];
}

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	// Resolved before uv is touched: an installation with nothing safe to install from has to fail
	// without spawning anything, and its requirement is never the bare registry name.
	const install = await resolveKernelRuntimeInstall();
	const uv = await ensureUv(options);
	const python = kernelVenvInterpreter(venv);
	const runtimeIdentity = install.identity;

	const uvRun = (args: string[]): Promise<void> =>
		run(uv, args, { signal: options.signal, timeoutMs: uvCommandTimeoutMs(), captureStderr: true });
	await uvRun(["python", "install", PYTHON_VERSION]);
	// Nothing invokes the venv's own pip; every kernel-venv package is installed
	// through `uv pip install --python`, so the venv is created unseeded.
	await uvRun(["venv", venv, "--python", PYTHON_VERSION]);
	await uvRun(kernelInstallArgs(python, install.requirement));
	// Land the base marker before the skill sync: a session killed mid-sync must
	// leave the next one on the skills-only path instead of wiping the venv and
	// re-paying the runtime install. `uv venv` refuses a non-empty directory, so
	// this generation has no previous marker for the write's union to pick up.
	await writeBootstrapVersion(venv, runtimeIdentity, []);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}

/**
 * What one skill sync is allowed to do to a generation directory. A directory a live kernel was
 * spawned from is pinned by the in-use invariant in `venv-in-use.ts` - "never rebuilt in place"
 * covers swapping an editable install exactly as much as it covers `rm -rf` - so the sync that
 * runs against a warm, referenced generation has to hold back the mutations that would change
 * what a running kernel resolves.
 */
export interface PythonSkillSyncGuard {
	/** True when a recorded install must not be replaced by this checkout's copy. */
	skipReplacements: boolean;
	liveReferences: number;
	referenceStateUnknown: boolean;
}

/** A fresh build has no references by construction (`decideKernelVenvRebuild` deferred otherwise). */
const UNGUARDED_SKILL_SYNC: PythonSkillSyncGuard = {
	skipReplacements: false,
	liveReferences: 0,
	referenceStateUnknown: false,
};

/** Whether one requested skill is already installed, by content, at a path that still holds it. */
function skillInstallIsCurrent(candidate: BootstrapPythonSkill, recorded: BootstrapPythonSkill | undefined): boolean {
	return (
		recorded !== undefined &&
		recorded.contentHash !== undefined &&
		recorded.contentHash === candidate.contentHash &&
		pythonSkillInstallIsFaithful(recorded)
	);
}

function reportSkillReplacementDeferred(
	skill: BootstrapPythonSkill,
	recorded: BootstrapPythonSkill,
	guard: PythonSkillSyncGuard,
	options: EnsureKernelPythonOptions,
): void {
	const why = guard.referenceStateUnknown
		? "this venv's in-use reference state could not be read"
		: `${guard.liveReferences} kernel(s) still run from this venv`;
	reportProgress(
		options,
		`Warning: Python skill ${skill.importName} stays installed from ${recorded.packagePath} because ${why}; ` +
			`this checkout's copy (${skill.packagePath}) differs and was not installed over it`,
	);
	bootstrapLog.warn("kernel skill replacement deferred: generation in use", {
		importName: skill.importName,
		installedFrom: recorded.packagePath,
		requestedFrom: skill.packagePath,
		liveReferences: guard.liveReferences,
		referenceStateUnknown: guard.referenceStateUnknown,
	});
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
	guard: PythonSkillSyncGuard = UNGUARDED_SKILL_SYNC,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	// Keyed by import name: that is the unit one editable install claims, and the manifest never
	// holds two entries for it (`mergePythonSkillRecords` dedupes the same way).
	const currentPythonSkills = new Map((version?.pythonSkills ?? []).map((skill) => [skill.importName, skill]));
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		const existingSkill = currentPythonSkills.get(skill.importName);
		if (skillInstallIsCurrent(skill, existingSkill)) {
			// Re-record the entry that names the install's real location, not this checkout's path:
			// claiming an install this tree did not perform would point the next faithfulness check
			// at the wrong directory, and the two checkouts would start trading the record back.
			installedPythonSkills.push(existingSkill as BootstrapPythonSkill);
			continue;
		}
		if (guard.skipReplacements && existingSkill !== undefined) {
			// Held back, not installed: the record keeps the entry that is really on disk, so this
			// generation stays unsatisfied for this checkout and the retry happens on a later boot
			// (once the references drop) instead of swapping content under a running kernel.
			reportSkillReplacementDeferred(skill, existingSkill, guard, options);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName && installed.contentHash === dependency.contentHash,
				);
				return !(
					installedThisSync || skillInstallIsCurrent(dependency, currentPythonSkills.get(dependency.importName))
				);
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await run(
				uv,
				["pip", "install", "--python", python, ...formatPythonSkillInstallArgs(skill), ...localDependencyArgs],
				{
					signal: options.signal,
					timeoutMs: uvCommandTimeoutMs(),
					captureStderr: true,
				},
			);
		} catch (error) {
			// A cancelled boot stops here instead of reporting every remaining skill as a
			// failed install (and killing one more subprocess per skill).
			if (error instanceof KernelBootstrapAbortedError) throw error;
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
			continue;
		}
		installedPythonSkills.push(
			skill,
			...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
		);
		// Persist progress after every completed install group so a session killed
		// mid-sync resumes at the first missing skill instead of re-paying the whole
		// sync. `writeBootstrapVersion` re-reads the marker and unions by import name,
		// so skills an earlier boot recorded but this sync has not visited yet (they
		// sit later in install order) survive the incremental write; the final write
		// below stays this sync's authoritative one. A marker write failure is not a
		// skill install failure, so it is deliberately outside the catch above.
		await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills);
	}
	await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills);
}

async function kernelBaseReady(python: string, venv: string, runtimeIdentity: string): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity) &&
		// A venv whose default packages no longer import needs a rebuild, not a skill sync -
		// the base-ready branch would otherwise hand the broken generation back out (r36 INSB-4).
		(await defaultRlmExtraPackagesImportable(python))
	);
}

async function defaultRlmExtraPackagesImportable(python: string): Promise<boolean> {
	try {
		await run(python, [...KERNEL_PYTHON_SAFE_PATH_ARGS, "-"], {
			stdinScript: RLM_EXTRA_IMPORTS_PROBE_SCRIPT,
		});
		return true;
	} catch {
		return false;
	}
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills) &&
		(await defaultRlmExtraPackagesImportable(python))
	);
}

function formatBootstrapFailure(error: unknown): Error {
	// Typed bootstrap failures already carry their own specific, actionable guidance, and
	// callers need the class to tell a cancellation or a lock timeout from a real failure.
	if (
		error instanceof KernelBootstrapLockTimeoutError ||
		error instanceof KernelBootstrapAbortedError ||
		error instanceof KernelRuntimeSourceUnavailableError ||
		error instanceof KernelBootstrapLockCreateError
	) {
		return error;
	}
	// r36 INSB-3: when uv's own stderr is attached, it names the actual cause (ENOSPC, EACCES,
	// index or proxy errors) - leading with "needs internet" would misdirect the user.
	const carriesSubprocessStderr = error instanceof KernelSubprocessError && error.subprocessStderr !== undefined;
	const hint = carriesSubprocessStderr
		? "The output above is uv's own diagnostic; it names the actual failure (disk, permissions, index, or network). "
		: "First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. ";
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n${hint}` +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap.",
	);
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		const missing = await missingKernelRuntimeLabels(python);
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const base = await resolveWritableKernelVenvDir();
	// Before the warm early-return: a warm generation built from a build copy stays warm forever, so
	// the only chance to say "this is not the source you are editing" is on every boot that reads it.
	await reportRuntimeSourceShadow(options);
	const runtimeIdentity = await resolveRuntimeIdentity();
	// This build identity's own directory. A kernel started from it keeps this exact path
	// for its whole life, and a later identity change builds a sibling instead of touching it.
	const venv = kernelVenvDirForIdentity(base, runtimeIdentity);
	const python = kernelVenvInterpreter(venv);
	/**
	 * Hand back this generation's interpreter, claimed.
	 *
	 * The claim (P2-2) covers the gap this function cannot: between returning a path and the
	 * caller recording the spawned kernel's reference, the generation has no pid pointing at it,
	 * so a concurrent boot's sweep used to read "zero references" and could `rm -rf` the directory
	 * the caller is about to exec. Taking the bootstrap lock instead would not close that gap - the
	 * vulnerable window starts after the lock is released, and the warm path below never takes it -
	 * so the protection travels with the returned path and is superseded by the reference the spawn
	 * records (or swept once this process is provably gone).
	 */
	const claimedPython = (): string => {
		const claim = claimKernelVenvBootSync(venv, { pid: process.pid });
		if (claim.reason) {
			// Not fatal: the boot proceeds with today's (unprotected) behaviour and the reason is
			// in the machine-wide log rather than only in this process's memory.
			bootstrapLog.warn("could not claim the kernel venv generation for this boot", {
				venvDir: venv,
				pid: process.pid,
				reason: claim.reason,
			});
		}
		return python;
	};
	// GC trigger 1 (boot): reclaim generations whose references have all dropped. Only
	// provably abandoned directories are touched, so this needs no lock; the generation
	// this boot is about to use is excluded, and a generation another boot claimed but has not
	// spawned from yet is kept by the claim itself (P2-2).
	await pruneKernelVenvGenerations(base, { activeDir: venv }).catch(() => undefined);
	// Before the warm early-return so a machine that never rebuilds still hears about the
	// leftover pre-generation directory once (interactive boots only; see the callee).
	reportLegacyKernelVenv(base, options);
	// No-skill callers (postinstall, runtime-bootstrap, bootstrap-cli) never sync skills;
	// letting them reach syncPythonSkills would rewrite the marker with an empty list,
	// wiping the recorded skills and forcing the next real session to re-sync every
	// skill. They only need the base kernel to be ready.
	const readyForCaller = async (): Promise<boolean> =>
		pythonSkills.length === 0
			? kernelBaseReady(python, venv, runtimeIdentity)
			: kernelReady(python, venv, runtimeIdentity, pythonSkills);
	if (await readyForCaller()) return claimedPython();

	// The lock stays keyed on the base path, so pre- and post-generation hosts serialize
	// on the same lock through a mixed-version window.
	const releaseLock = await acquireBootstrapLock(base, {
		signal: options.signal,
		timeoutMs: options.lockTimeoutMs,
	});
	try {
		if (await readyForCaller()) return claimedPython();
		if (await kernelBaseReady(python, venv, runtimeIdentity)) {
			// The in-use invariant covers this branch too, and it used to be the one place that
			// mutated a generation without reading its references: an editable reinstall swaps
			// content under every kernel that was spawned from this directory (K-P1-2). Reading
			// the state also sweeps the references whose holders are provably gone.
			const inUse = await readKernelVenvInUseState(venv);
			await syncPythonSkills(await ensureUv(options), venv, python, runtimeIdentity, pythonSkills, options, {
				skipReplacements: inUse.unknown || inUse.references.length > 0,
				liveReferences: inUse.references.length,
				referenceStateUnknown: inUse.unknown,
			});
			return claimedPython();
		}

		// A generation that still has live references is never rebuilt in place: its kernel
		// keeps resolving lazy imports (and this repo's skills are imported dynamically)
		// against that absolute path, so rebuilding under it would mix two builds inside one
		// running kernel. Unreadable reference bookkeeping counts as in use.
		const inUse = await readKernelVenvInUseState(venv);
		const hadVenv = existsSync(venv);
		const decision = decideKernelVenvRebuild({
			platform: process.platform,
			generationDirExists: hadVenv,
			liveReferences: inUse.references.length,
			referenceStateUnknown: inUse.unknown,
		});
		if (decision.mode === "defer") {
			throw new KernelVenvRebuildDeferredError(venv, decision.liveReferences, decision.referenceStateUnknown);
		}

		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		if (hadVenv) {
			reportProgress(options, `rebuilding unreferenced kernel venv ${path.basename(venv)}`);
			await rm(venv, { recursive: true, force: true });
		}

		await bootstrapVenv(venv, pythonSkills, options);
		// The install just replaced (or created) the generation this boot will hand out, so verify
		// what landed before announcing it; the readiness checks the warm path runs are all earlier.
		await verifyFreshKernelRuntime(venv, python);
		// GC trigger 2 (post-build): a new generation just landed, so retire the surplus
		// now rather than leaving it on disk until the next boot.
		await pruneKernelVenvGenerations(base, { activeDir: venv }).catch(() => undefined);
	} catch (error) {
		// Already actionable and specific; the bootstrap wrapper would bury the reason.
		if (error instanceof KernelVenvRebuildDeferredError) throw error;
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}

	reportProgress(options, "✓ ready");
	// Claimed here rather than before the build: the rebuild above removed the whole directory,
	// so a claim written earlier would have been deleted with it.
	return claimedPython();
}

/**
 * Counts the callers attached to one in-flight bootstrap. A caller's abort cancels the
 * shared work only once every caller has aborted: sessions in one process share the
 * memoized bootstrap, so one session being disposed must not tear down another session's
 * kernel boot. A single caller that wants its own wait to end immediately already gets
 * that from `raceStartupWithAbort` in the kernel start path.
 */
function trackBootstrapWaiter(entry: InFlightBootstrap, signal: AbortSignal | undefined): void {
	entry.waiters += 1;
	if (!signal) return;

	const onAbort = (): void => {
		entry.aborted += 1;
		if (entry.aborted >= entry.waiters) {
			entry.controller.abort(new KernelBootstrapAbortedError("every waiting session aborted"));
		}
	};
	if (signal.aborted) {
		onAbort();
		return;
	}
	signal.addEventListener("abort", onAbort, { once: true });
	const detach = (): void => signal.removeEventListener("abort", onAbort);
	// Never leaves a listener behind on a signal that outlives the boot (e.g. a session-wide
	// dispose signal shared by many kernel starts).
	void entry.promise.then(detach, detach);
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	// Refuse before touching the memo, the readiness probes, or the lock: a cancelled
	// session must not spawn subprocesses, and must not be handed a boot it will not use.
	if (options.signal?.aborted) {
		return Promise.reject(new KernelBootstrapAbortedError("the session aborted before the kernel bootstrap started"));
	}

	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	const inFlight = inFlightEnsureKernelPython;
	if (inFlight?.key === key) {
		trackBootstrapWaiter(inFlight, options.signal);
		return inFlight.promise;
	}

	const controller = new AbortController();
	const promise = ensureKernelPythonUncached({ ...options, signal: controller.signal }, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	const entry: InFlightBootstrap = { key, promise, controller, waiters: 0, aborted: 0 };
	inFlightEnsureKernelPython = entry;
	trackBootstrapWaiter(entry, options.signal);
	return promise;
}
