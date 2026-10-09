import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizePath } from "../utils/paths.js";
import { collectAutoExtensionEntries } from "./package-manager.js";

/**
 * Project extension trust gate (port of the official trust gating added for
 * GHSA-mqxh-6gq7-558m). Extensions under `<cwd>/.prime/agent/extensions` and
 * extension sources declared by the project's own settings are repository-
 * controlled executable code; they load only after this directory has been
 * trusted. The decision is stored per canonical cwd so it is asked once per
 * directory, and non-interactive runs never prompt: they fail closed and say
 * why, so an unattended run can never hang on a prompt.
 */

export const PROJECT_TRUST_FILE_NAME = "project-trust.json";

/**
 * How long after the gate first lands on a machine the grandfather rule keeps
 * converting "existing use" into a saved trust decision. Long enough to cover
 * the owner's typical post-upgrade horizon, short enough that a repository
 * first visited months later still gets the real prompt.
 */
export const PROJECT_TRUST_GRANDFATHER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ProjectTrustReason =
	| "no-inputs"
	| "override"
	| "saved"
	| "machine-default"
	| "prompt"
	| "prompt-cancelled"
	| "grandfathered";

export interface ProjectTrustResolution {
	trusted: boolean;
	reason: ProjectTrustReason;
}

export interface ProjectTrustPromptChoice {
	trusted: boolean;
	remember: boolean;
}

/** Injectable prompt so tests (and machine modes) never need a real terminal. */
export type ProjectTrustPrompt = (cwd: string, extensionsDir: string) => Promise<ProjectTrustPromptChoice | undefined>;

/** Project-scope settings that can declare executable extension sources. */
export interface ProjectTrustSettingsInputs {
	extensions?: string[];
	packages?: unknown[];
}

interface TrustFile {
	version: number;
	createdAt: string;
	decisions: Record<string, boolean>;
}

/** Canonical store key for a working directory (symlink-stable). */
export function projectTrustKey(cwd: string): string {
	return canonicalizePath(resolve(cwd));
}

function parseTrustFile(raw: string): TrustFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	const decisions: Record<string, boolean> = {};
	if (typeof record.decisions === "object" && record.decisions !== null && !Array.isArray(record.decisions)) {
		for (const [key, value] of Object.entries(record.decisions)) {
			// A corrupted entry is dropped, not trusted: the safe direction.
			if (value === true || value === false) {
				decisions[key] = value;
			}
		}
	}
	if (typeof record.createdAt !== "string") {
		// A file without a creation stamp cannot prove an upgrade window; treat it
		// as a plain decision store and never grandfather from it.
		return { version: 1, createdAt: "", decisions };
	}
	return { version: 1, createdAt: record.createdAt, decisions };
}

function readTrustFile(path: string): TrustFile | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return parseTrustFile(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function serializeTrustFile(data: TrustFile): string {
	const sortedDecisions: Record<string, boolean> = {};
	for (const key of Object.keys(data.decisions).sort()) {
		sortedDecisions[key] = data.decisions[key];
	}
	return `${JSON.stringify({ version: 1, createdAt: data.createdAt, decisions: sortedDecisions }, null, 2)}\n`;
}

function withTrustLock<T>(path: string, fn: () => T): T {
	// Same lock discipline as the settings store: the lock directory is the agent
	// dir, which the caller's process already owns; contention is client/worker
	// pairs writing different keys at the same moment.
	let release: (() => void) | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		release = lockfile.lockSync(dirname(path), { realpath: false, lockfilePath: `${path}.lock` });
	} catch {
		// An uncontended lock should never fail; if locking is unavailable the
		// read-modify-write still runs, worst case losing a concurrent key. The
		// store degrades to "ask again", never to "trust without asking".
		release = undefined;
	}
	try {
		return fn();
	} finally {
		try {
			release?.();
		} catch {
			// Releasing a lock that died with a stale pidfile is best-effort.
		}
	}
}

export class ProjectTrustStore {
	private readonly trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolve(agentDir), PROJECT_TRUST_FILE_NAME);
	}

	/** Path of the backing file, for notices that tell the user where to edit. */
	filePath(): string {
		return this.trustPath;
	}

	/** The saved decision for a cwd, or null when this cwd has never decided. */
	get(cwd: string): boolean | null {
		const data = readTrustFile(this.trustPath);
		if (!data) {
			return null;
		}
		const value = data.decisions[projectTrustKey(cwd)];
		return value === true || value === false ? value : null;
	}

	set(cwd: string, trusted: boolean): void {
		withTrustLock(this.trustPath, () => {
			const existing = readTrustFile(this.trustPath);
			const data: TrustFile = {
				version: 1,
				createdAt: existing?.createdAt || new Date().toISOString(),
				decisions: { ...(existing?.decisions ?? {}) },
			};
			data.decisions[projectTrustKey(cwd)] = trusted;
			try {
				mkdirSync(dirname(this.trustPath), { recursive: true, mode: 0o700 });
				writeFileSync(this.trustPath, serializeTrustFile(data), { encoding: "utf-8", mode: 0o600 });
			} catch {
				// A read-only agent dir cannot persist the answer; the caller has the
				// resolution in memory for this run and the next run will ask again.
			}
		});
	}

	/** Epoch milliseconds at which the gate landed on this machine, or null. */
	createdAt(): number | null {
		const data = readTrustFile(this.trustPath);
		if (!data || !data.createdAt) {
			return null;
		}
		const createdAt = Date.parse(data.createdAt);
		return Number.isFinite(createdAt) ? createdAt : null;
	}

	/**
	 * Create the store on first gated run so the upgrade timestamp is pinned at
	 * the moment the gate landed, not at the first prompt. Idempotent; an
	 * existing file (even a malformed one) is never rewritten here.
	 */
	ensureCreated(): void {
		if (existsSync(this.trustPath)) {
			return;
		}
		withTrustLock(this.trustPath, () => {
			if (existsSync(this.trustPath)) {
				return;
			}
			try {
				mkdirSync(dirname(this.trustPath), { recursive: true, mode: 0o700 });
				writeFileSync(this.trustPath, serializeTrustFile(EMPTY_TRUST_FILE()), {
					encoding: "utf-8",
					mode: 0o600,
				});
			} catch {
				// No store file -> no grandfathering and no saved decisions: every
				// directory fails closed until the fs is writable. Safe direction.
			}
		});
	}
}

function EMPTY_TRUST_FILE(): TrustFile {
	return { version: 1, createdAt: new Date().toISOString(), decisions: {} };
}

/**
 * Does this working directory carry project-scoped extension sources that the
 * gate would hold back? Mirrors what the package manager tags as project
 * scope: auto-discovered `<cwd>/.prime/agent/extensions` entries, plus
 * `extensions`/`packages` declared by the project's own settings.
 */
export function hasProjectExtensionInputs(cwd: string, projectSettings: ProjectTrustSettingsInputs): boolean {
	const extensionsDir = join(resolve(cwd), ".prime/agent", "extensions");
	if (collectAutoExtensionEntries(extensionsDir).length > 0) {
		return true;
	}
	if ((projectSettings.extensions ?? []).length > 0) {
		return true;
	}
	if ((projectSettings.packages ?? []).length > 0) {
		return true;
	}
	return false;
}

export function projectExtensionsDir(cwd: string): string {
	return join(resolve(cwd), ".prime/agent", "extensions");
}

export interface ResolveProjectTrustOptions {
	cwd: string;
	store: ProjectTrustStore;
	/** Run-wide CLI override from --approve (true) / --no-approve (false). */
	override?: boolean;
	/** Whether a human can be asked (interactive startup). */
	interactive: boolean;
	/** Project-scope settings for the cwd; used only to detect gate inputs. */
	projectSettings: ProjectTrustSettingsInputs;
	/**
	 * Evidence this cwd was already in use before the gate existed (a prior
	 * session transcript). Drives the one-time upgrade grandfathering.
	 */
	hasPriorSession?: () => boolean;
	/** Terminal-backed interactive prompt; absent in machine modes. */
	prompt?: ProjectTrustPrompt;
	/** Receiver for the non-silent refusal/grandfather notices. */
	notify?: (message: string) => void;
	/** Injectable clock for the grandfather window test. */
	now?: () => number;
}

function refusalNotice(cwd: string, cause: string): string {
	return (
		`Project extensions were not loaded from ${projectExtensionsDir(cwd)}: ${cause}. ` +
		"Non-interactive runs never prompt, so the directory is treated as not trusted. " +
		"Run prime-agent interactively in this directory once to decide, or pass --approve for this run."
	);
}

/**
 * Resolve whether project-scoped extensions may load for this run. Resolution
 * order: CLI override, no gate inputs, saved decision, upgrade grandfather,
 * interactive prompt, machine-mode refusal. Only the prompt and the grandfather
 * write to the store; a machine run never persists anything.
 */
export async function resolveProjectTrust(options: ResolveProjectTrustOptions): Promise<ProjectTrustResolution> {
	const { cwd, store, projectSettings } = options;
	const now = options.now ?? Date.now;

	if (options.override !== undefined) {
		if (options.override === false && hasProjectExtensionInputs(cwd, projectSettings)) {
			options.notify?.(refusalNotice(cwd, "this run passed --no-approve"));
		}
		return { trusted: options.override, reason: "override" };
	}

	if (!hasProjectExtensionInputs(cwd, projectSettings)) {
		// Nothing repository-controlled would be gated; keep pre-gate behavior.
		return { trusted: true, reason: "no-inputs" };
	}

	const saved = store.get(cwd);
	if (saved !== null) {
		if (!saved) {
			options.notify?.(refusalNotice(cwd, "this directory is marked not trusted"));
		}
		return { trusted: saved, reason: "saved" };
	}

	// Upgrade grandfather: a directory already in use when the gate landed keeps
	// working (including for unattended runs that cannot answer a prompt), but
	// only while the upgrade window is still open and only once per directory.
	// A clock reading before the store was created (skew, manual fiddling) is
	// outside the window, not before it.
	const createdAt = store.createdAt();
	const elapsed = createdAt === null ? Number.POSITIVE_INFINITY : now() - createdAt;
	const windowOpen = elapsed >= 0 && elapsed <= PROJECT_TRUST_GRANDFATHER_WINDOW_MS;
	if (windowOpen && options.hasPriorSession?.()) {
		store.set(cwd, true);
		options.notify?.(
			`Project extensions in ${cwd} were trusted automatically once for this upgrade: the directory was ` +
				`already in use before the extension trust gate existed, so it is treated as if you had answered the ` +
				`trust prompt once. Review ${projectExtensionsDir(cwd)} and edit ${store.filePath()} to change the decision.`,
		);
		return { trusted: true, reason: "grandfathered" };
	}

	if (options.interactive && options.prompt) {
		const choice = await options.prompt(cwd, projectExtensionsDir(cwd));
		if (choice === undefined) {
			// A dismissed prompt decides nothing: untrusted for this run, ask again next time.
			options.notify?.(refusalNotice(cwd, "the trust prompt was dismissed"));
			return { trusted: false, reason: "prompt-cancelled" };
		}
		if (choice.remember) {
			store.set(cwd, choice.trusted);
		}
		if (!choice.trusted) {
			options.notify?.(refusalNotice(cwd, "this directory is marked not trusted"));
		}
		return { trusted: choice.trusted, reason: "prompt" };
	}

	options.notify?.(refusalNotice(cwd, "no trust decision is saved for this directory and this run cannot prompt"));
	return { trusted: false, reason: "machine-default" };
}
