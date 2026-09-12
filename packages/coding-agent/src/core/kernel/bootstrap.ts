import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getLogger } from "@earendil-works/pi-ai";
import { getPackageDir } from "../../config.js";
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
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// `-P` (safe path, Python >= 3.11, which prime-agent-runtime requires) keeps the
// current directory off sys.path, so a checkout carrying `rlm/`, `dill.py`, or a
// stdlib-named module cannot shadow the kernel's own imports. Every kernel-python
// invocation must carry it; the process-local flag is preferred over
// PYTHONSAFEPATH, which the kernel's bash() children would inherit.
export const KERNEL_PYTHON_SAFE_PATH_ARGS: readonly string[] = ["-P"];
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
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
 * the same generation; any difference (runtime source, bootstrap schema, snapshot
 * requirement, default packages) gets its own directory, so a generation a kernel is
 * running from is never rebuilt under it.
 *
 * The requested Python skills are deliberately *not* part of this key. They are per-session (a
 * session may enable a subset, and the record inside the generation is a union so subsets can
 * share it), and `pruneKernelVenvGenerations` keeps only one unreferenced generation: keying the
 * directory on the skill set would give every subset its own ~30s build and then have those
 * builds delete each other. Skill differences are reconciled inside the generation instead - by
 * content, never by absolute path (see {@link pythonSkillsSatisfied}, K-P1-2).
 */
function kernelVenvBuildIdentity(runtimeIdentity: string): string {
	return JSON.stringify({
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
export function kernelVenvDirForIdentity(base: string, runtimeIdentity: string): string {
	return generationDirForSuffix(base, kernelVenvGenerationSuffix(kernelVenvBuildIdentity(runtimeIdentity)));
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

function run(
	command: string,
	args: string[],
	options: { stdio?: "ignore" | "inherit"; signal?: AbortSignal } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancelled = (): Error => new KernelBootstrapAbortedError(`${command} ${args.join(" ")} was cancelled`);
		const child = spawn(command, args, {
			env: process.env,
			stdio: options.stdio ?? "ignore",
			// Kills the child on abort, so a cancelled boot does not leave a uv install running.
			signal: options.signal,
		});
		child.on("error", (error) => {
			// An abort before or during spawn surfaces here as an AbortError; report the
			// cancellation rather than the opaque underlying reason.
			reject(options.signal?.aborted ? cancelled() : error);
		});
		child.on("exit", (code, signal) => {
			if (options.signal?.aborted) {
				reject(cancelled());
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
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
async function acquireBootstrapLock(
	venv: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

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
			if (!isNodeError(error, "EEXIST")) throw error;

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
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// dist/prime-agent-runtime is listed first deliberately: it is the only path stable
	// across every shipped layout (dist/, dist/bundle/, bun), where import.meta.url-relative
	// resolution breaks. `npm run build` rebuilds it from live source (copy-assets does
	// rm -rf + cp), so the staleness hash still refreshes on every build. The relative
	// paths below cover running from source (tsx) where dist/ hasn't been built.
	return [
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeSourceDir(): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

// Identity of the runtime to be installed. For a local source checkout this is a
// content hash of every rlm/*.py file plus pyproject.toml, so any runtime code or
// dependency change invalidates an existing venv automatically. Falls back to the
// bare package name when the runtime resolves to a registry install (no local source).
export async function resolveRuntimeIdentity(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to RUNTIME_REQUIREMENT: that constant is the registry-install identity, and
// recording it for a local checkout would permanently mask later source changes.
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

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = path.join(venv, "bin", "python");
	const sourceDir = await resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = await resolveRuntimeIdentity();

	await run(uv, ["python", "install", PYTHON_VERSION], { signal: options.signal });
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"], { signal: options.signal });
	await run(
		uv,
		[
			"pip",
			"install",
			"--python",
			python,
			runtimeRequirement,
			STATE_SNAPSHOT_REQUIREMENT,
			...DEFAULT_RLM_EXTRA_UV_ARGS,
		],
		{ signal: options.signal },
	);
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
				{ signal: options.signal },
			);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			// A cancelled boot stops here instead of reporting every remaining skill as a
			// failed install (and killing one more subprocess per skill).
			if (error instanceof KernelBootstrapAbortedError) throw error;
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills);
}

async function kernelBaseReady(python: string, venv: string, runtimeIdentity: string): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity)
	);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	// Typed bootstrap failures already carry their own specific, actionable guidance, and
	// callers need the class to tell a cancellation or a lock timeout from a real failure.
	if (error instanceof KernelBootstrapLockTimeoutError || error instanceof KernelBootstrapAbortedError) {
		return error;
	}
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
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
		const missing: string[] = [];
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
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
	const runtimeIdentity = await resolveRuntimeIdentity();
	// This build identity's own directory. A kernel started from it keeps this exact path
	// for its whole life, and a later identity change builds a sibling instead of touching it.
	const venv = kernelVenvDirForIdentity(base, runtimeIdentity);
	const python = path.join(venv, "bin", "python");
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
	if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return claimedPython();

	// The lock stays keyed on the base path, so pre- and post-generation hosts serialize
	// on the same lock through a mixed-version window.
	const releaseLock = await acquireBootstrapLock(base, {
		signal: options.signal,
		timeoutMs: options.lockTimeoutMs,
	});
	try {
		if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return claimedPython();
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
