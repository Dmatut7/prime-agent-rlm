import { accessSync, existsSync, constants as fsConstants, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { APP_NAME, getAgentDir, getAuthPath, getSessionsDir } from "../config.js";
import { getKernelVenvDir } from "../core/kernel/bootstrap.js";
import { isKernelVenvGenerationDir } from "../core/kernel/venv-in-use.js";
import { SESSION_ID_PATTERN } from "../core/session-id.js";
import { FirstLineTooLongError, MAX_FIRST_LINE_BYTES, readFirstLineSync } from "../utils/file-lines.js";

/**
 * Doctor's read-only health checks. Every check reports one of three verdicts plus the next
 * step an operator should take; none of them may write, create, remove or chmod anything.
 * That is why the session scan parses headers itself instead of reusing
 * `readSessionHeaderId`: that path tightens over-permissive transcripts to 0600, which is a
 * fix, and `doctor` without `--fix` must stay a pure observation.
 */
export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	status: DoctorCheckStatus;
	detail: string;
	next: string;
}

/** Filesystem locations the checks observe. Injectable so tests can point at fixtures. */
export interface DoctorCheckRoots {
	agentDir: string;
	authPath: string;
	sessionsDir: string;
	kernelVenvDir: string;
	/** `PRIME_AGENT_KERNEL_PYTHON` override, when set: checked instead of the managed venv. */
	kernelPythonOverride?: string;
}

export interface DoctorScanLimits {
	/** Maximum number of session files parsed before the scan reports itself as truncated. */
	maxSessionFiles: number;
	/** Maximum total session bytes read before the scan reports itself as truncated. */
	maxSessionBytes: number;
}

export const DEFAULT_DOCTOR_SCAN_LIMITS: DoctorScanLimits = {
	maxSessionFiles: 200,
	maxSessionBytes: 64 * 1024 * 1024,
};

const OK_NEXT = "No action needed.";

export function resolveDoctorCheckRoots(): DoctorCheckRoots {
	return {
		agentDir: getAgentDir(),
		authPath: getAuthPath(),
		sessionsDir: getSessionsDir(),
		kernelVenvDir: getKernelVenvDir(),
		kernelPythonOverride: process.env.PRIME_AGENT_KERNEL_PYTHON?.trim() || undefined,
	};
}

export function collectReadonlyDoctorChecks(
	roots: DoctorCheckRoots,
	limits: DoctorScanLimits = DEFAULT_DOCTOR_SCAN_LIMITS,
): DoctorCheck[] {
	return [
		checkAuthFile(roots.authPath),
		checkKernelVenv(roots.kernelVenvDir, roots.kernelPythonOverride),
		checkSessions(roots.sessionsDir, limits),
	];
}

interface AuthFileVerdict {
	credentials: number;
	malformed: number;
}

/**
 * Count credentials by shape only. Values are never read into the report: doctor output must
 * stay free of secrets, so the only thing that can leave this function is a count.
 */
function inspectAuthFile(path: string): { verdict: AuthFileVerdict | undefined; problem?: string } {
	if (!existsSync(path)) {
		return { verdict: undefined, problem: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return { verdict: undefined, problem: `invalid-json:${error instanceof Error ? error.message : "parse error"}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { verdict: undefined, problem: "not-an-object" };
	}
	let credentials = 0;
	let malformed = 0;
	for (const value of Object.values(parsed as Record<string, unknown>)) {
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "api_key" &&
			typeof (value as { key?: unknown }).key === "string" &&
			(value as { key: string }).key.length > 0
		) {
			credentials++;
		} else if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "oauth" &&
			typeof (value as { access?: unknown }).access === "string"
		) {
			credentials++;
		} else {
			malformed++;
		}
	}
	return { verdict: { credentials, malformed } };
}

function checkAuthFile(path: string): DoctorCheck {
	const { verdict, problem } = inspectAuthFile(path);
	if (problem === "missing") {
		return {
			id: "auth",
			status: "warn",
			detail: `no ${basename(path)} found at ${path}; this machine has no stored provider credentials`,
			next: `Start ${APP_NAME} and use /login, or authenticate a provider, to store credentials.`,
		};
	}
	if (problem?.startsWith("invalid-json:")) {
		return {
			id: "auth",
			status: "fail",
			detail: `${path} is not valid JSON (${problem.slice("invalid-json:".length)}); stored credentials cannot be read`,
			next: `Fix or delete ${path} (its contents must map provider ids to credentials) and re-authenticate with /login.`,
		};
	}
	if (problem === "not-an-object") {
		return {
			id: "auth",
			status: "fail",
			detail: `${path} does not contain a JSON object mapping provider ids to credentials`,
			next: `Fix or delete ${path} and re-authenticate with /login.`,
		};
	}
	const { credentials, malformed } = verdict!;
	if (credentials === 0) {
		return {
			id: "auth",
			status: "warn",
			detail: `${path} contains no usable provider credentials (${malformed} malformed entr${malformed === 1 ? "y" : "ies"})`,
			next: "Re-authenticate with /login or set a provider API key so commands can reach a model.",
		};
	}
	const suffix = malformed > 0 ? ` (${malformed} malformed entr${malformed === 1 ? "y" : "ies"} ignored)` : "";
	return {
		id: "auth",
		status: "ok",
		detail: `${credentials} provider credential${credentials === 1 ? "" : "s"} stored in ${basename(path)}${suffix}`,
		next: OK_NEXT,
	};
}

function kernelInterpreterRelativePath(): string {
	return process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The managed venv directories that exist: the legacy unsuffixed base plus generation siblings. */
function existingKernelVenvDirs(base: string): string[] {
	const dirs: string[] = [];
	if (existsSync(base)) {
		dirs.push(base);
	}
	try {
		for (const entry of readdirSync(dirname(base), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(dirname(base), entry.name);
			if (dirs.includes(candidate)) continue;
			if (isKernelVenvGenerationDir(base, candidate)) {
				dirs.push(candidate);
			}
		}
	} catch {
		// An unreadable parent directory is itself a finding the interpreter check reports.
	}
	return dirs;
}

function checkKernelVenv(base: string, override?: string): DoctorCheck {
	if (override) {
		if (existsSync(override) && isExecutable(override)) {
			return {
				id: "kernel-venv",
				status: "ok",
				detail: `PRIME_AGENT_KERNEL_PYTHON points at a usable interpreter at ${override}`,
				next: OK_NEXT,
			};
		}
		return {
			id: "kernel-venv",
			status: "fail",
			detail: `PRIME_AGENT_KERNEL_PYTHON points at ${override}, which is missing or not executable`,
			next: `Fix or unset PRIME_AGENT_KERNEL_PYTHON; without it the next kernel start builds a managed venv at ${base}.`,
		};
	}
	const dirs = existingKernelVenvDirs(base);
	if (dirs.length === 0) {
		return {
			id: "kernel-venv",
			status: "warn",
			detail: `no kernel venv found at ${base}`,
			next: "No action needed unless kernels fail to start: the venv is built automatically on the first kernel start.",
		};
	}
	const interpreter = kernelInterpreterRelativePath();
	const withInterpreter = dirs.filter((dir) => existsSync(join(dir, interpreter)));
	if (withInterpreter.length === 0) {
		return {
			id: "kernel-venv",
			status: "fail",
			detail: `kernel venv directories exist (${dirs.join(", ")}) but hold no interpreter at ${interpreter}`,
			next: `Remove the broken venv generation(s) under ${base} and start a session: bootstrap rebuilds the venv from scratch.`,
		};
	}
	const stale = withInterpreter.filter((dir) => !isExecutable(join(dir, interpreter)));
	if (stale.length === 0) {
		return {
			id: "kernel-venv",
			status: "ok",
			detail: `kernel venv ready: ${withInterpreter.length} generation(s) under ${base}, interpreter at ${join(withInterpreter[0]!, interpreter)}`,
			next: OK_NEXT,
		};
	}
	return {
		id: "kernel-venv",
		status: "fail",
		detail: `kernel venv interpreter ${join(stale[0]!, interpreter)} exists but is not executable`,
		next: `Restore the executable bit (chmod +x) on the interpreter under ${stale[0]!}, or remove the generation so bootstrap rebuilds it.`,
	};
}

interface SessionScan {
	scanned: number;
	total: number;
	truncated: boolean;
	unparseable: string[];
	/**
	 * Set when the sessions directory itself could not be listed. "I read nothing"
	 * and "there is nothing to read" are different facts, and only the second one
	 * may be reported as an empty directory.
	 */
	dirError?: string;
}

/** The errno code of a filesystem failure, for a detail line an operator can act on. */
function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && code.length > 0 ? code : "unknown error";
}

/**
 * Validate one session header line without any of the read-path side effects (no chmod, no
 * symlink policy). A missing line, a first line longer than the ceiling, or a header that is
 * not a `session` entry with a well-formed id all count as unreadable.
 */
function headerFromFirstLineIsReadable(firstLine: string | undefined): boolean {
	if (firstLine === undefined) {
		return false;
	}
	let header: unknown;
	try {
		header = JSON.parse(firstLine);
	} catch {
		return false;
	}
	return (
		typeof header === "object" &&
		header !== null &&
		(header as { type?: unknown }).type === "session" &&
		typeof (header as { id?: unknown }).id === "string" &&
		SESSION_ID_PATTERN.test((header as { id: string }).id)
	);
}

function scanSessions(dir: string, limits: DoctorScanLimits): SessionScan {
	const scan: SessionScan = { scanned: 0, total: 0, truncated: false, unparseable: [] };
	let files: string[] = [];
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(dir, name))
			.sort();
	} catch (error) {
		scan.dirError = errnoCode(error);
		return scan;
	}
	scan.total = files.length;
	// Budget of bytes actually read. Only the first line is read per file, and the per-read
	// ceiling passed to readFirstLineSync shrinks with the remaining budget, so the whole
	// scan reads at most maxSessionBytes however large the transcripts are.
	let bytes = 0;
	for (const file of files) {
		if (scan.scanned >= limits.maxSessionFiles) {
			scan.truncated = true;
			break;
		}
		const remaining = limits.maxSessionBytes - bytes;
		if (remaining <= 0) {
			scan.truncated = true;
			break;
		}
		const readCeiling = Math.min(MAX_FIRST_LINE_BYTES, remaining);
		try {
			const firstLine = readFirstLineSync(file, readCeiling);
			bytes += firstLine === undefined ? 1 : Buffer.byteLength(firstLine);
			if (!headerFromFirstLineIsReadable(firstLine)) {
				scan.unparseable.push(file);
			}
		} catch (error) {
			bytes += readCeiling;
			if (error instanceof FirstLineTooLongError && readCeiling < MAX_FIRST_LINE_BYTES) {
				// The scan budget, not the transcript, is what ran out: stop instead of
				// blaming a file whose header simply did not fit the remaining bytes.
				scan.truncated = true;
				break;
			}
			scan.unparseable.push(file);
		}
		scan.scanned++;
	}
	return scan;
}

function checkSessions(dir: string, limits: DoctorScanLimits): DoctorCheck {
	if (!existsSync(dir)) {
		return {
			id: "sessions",
			status: "ok",
			detail: `no sessions directory at ${dir}; nothing to scan`,
			next: OK_NEXT,
		};
	}
	const scan = scanSessions(dir, limits);
	if (scan.dirError !== undefined) {
		return {
			id: "sessions",
			status: "fail",
			detail: `${dir} exists but could not be listed (${scan.dirError}); no session file was scanned`,
			next: `Make ${dir} a readable directory (check its permissions and that no file sits at that path); until then ${APP_NAME} cannot list or resume sessions. Re-run doctor afterwards.`,
		};
	}
	if (scan.unparseable.length > 0) {
		const shown = scan.unparseable.slice(0, 5).join(", ");
		const more = scan.unparseable.length > 5 ? `, and ${scan.unparseable.length - 5} more` : "";
		return {
			id: "sessions",
			status: "fail",
			detail: `${scan.unparseable.length} of ${scan.scanned} scanned session file(s) have an unreadable header: ${shown}${more}`,
			next: "Move the named transcripts aside (or delete them if unneeded): unreadable headers break resume and session listing. Re-run doctor afterwards.",
		};
	}
	if (scan.truncated) {
		return {
			id: "sessions",
			status: "warn",
			detail: `scanned ${scan.scanned} of ${scan.total} session file(s) (doctor bounds its scan); every scanned header was readable`,
			next: `Spot-check the remaining transcripts with ${APP_NAME} list, or clear old sessions to fit the scan.`,
		};
	}
	return {
		id: "sessions",
		status: "ok",
		detail: `${scan.scanned} session file(s) scanned, all readable${scan.scanned === 0 ? " (directory is empty)" : ""}`,
		next: OK_NEXT,
	};
}
