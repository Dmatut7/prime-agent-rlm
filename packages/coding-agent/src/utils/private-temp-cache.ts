import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Private cache roots for code the agent is about to import and run.
 *
 * The temporary extension cache used to live at `tmpdir()/pi-extensions/...`, where
 * every component was computable by any local account (the npm entry hashed the
 * constant string `"npm-"`), and the loader reused a directory because it existed.
 * A second account could therefore pre-create the tree, drop an extension file into
 * it, and have the victim's agent import that file with the victim's own
 * permissions - or, for a git source, get `git` to run inside the planted tree,
 * where `.git/config`'s `core.sshCommand` is executed by the fetch.
 *
 * Two properties replace that:
 * - The root is private: `tmpdir()/pi-extensions-<uid>`, created 0700 with the mode
 *   forced, owner-checked, symlink-refused (the shape of `defaultDaemonSocketDir()`).
 *   When that name is already held by somebody else the claim is refused and a fresh
 *   unpredictable `mkdtemp` root is used instead: squatting the predictable name
 *   costs an attacker nothing and costs the victim only a cold cache.
 * - Reuse requires provenance: a record under the root's `.provenance/` directory,
 *   keyed by the entry path and carrying a random token only this root's installer
 *   writes. "The directory exists" is never evidence that we installed it.
 */

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROVENANCE_DIR_NAME = ".provenance";
const TOKEN_FILE_NAME = "token";
/** Group or other write access: any of these bits makes a directory somebody else's input. */
const WRITABLE_BY_OTHERS = 0o022;
const PROVENANCE_RECORD_VERSION = 1;
const PROVENANCE_NAME_LENGTH = 32;

/** Why a cache entry cannot be reused. `"missing"` is the ordinary "install it" case. */
export type TempEntryRejectReason =
	| "missing"
	| "symlink"
	| "not-a-directory"
	| "not-owned"
	| "writable-by-others"
	| "outside-root"
	| "unprovenanced";

export interface TempEntryCheck {
	trusted: boolean;
	reason: TempEntryRejectReason;
	/** The component that failed, when the failure is about a path on the chain. */
	path?: string;
	message?: string;
}

export interface PrivateTempCache {
	/** Private root directory: 0700, owned by the current user, never a symlink. */
	root: string;
	/** Random secret persisted inside the root; provenance records must carry it. */
	token: string;
	/** True when the per-uid root could not be claimed and a one-off private root is in use. */
	fellBack: boolean;
	/** Why the per-uid root could not be claimed, when `fellBack` is set. */
	notice?: string;
}

const TRUSTED: TempEntryCheck = { trusted: true, reason: "missing" };

function reject(path: string, reason: TempEntryRejectReason, message: string): TempEntryCheck {
	return { trusted: false, reason, path, message };
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function uidSuffix(): string {
	const uid = currentUid();
	return uid === undefined ? "user" : String(uid);
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function modeOf(stats: { mode: number }): number {
	return stats.mode & 0o777;
}

function lstatOrNull(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

/** A directory we are willing to keep using: real, ours, and not writable by anybody else. */
function directoryProblem(path: string, stats: Stats): TempEntryCheck {
	if (stats.isSymbolicLink()) {
		return reject(path, "symlink", "a symlink stands where a private directory is required");
	}
	if (!stats.isDirectory()) {
		return reject(path, "not-a-directory", "the path is not a directory");
	}
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== uid) {
		return reject(path, "not-owned", `owned by uid ${stats.uid}, not ${uid}`);
	}
	if (process.platform !== "win32" && (modeOf(stats) & WRITABLE_BY_OTHERS) !== 0) {
		return reject(path, "writable-by-others", `mode ${(modeOf(stats)).toString(8)} is writable by group or other`);
	}
	return TRUSTED;
}

function chmodDirectory(path: string, mode: number): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(path, mode);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw new Error(`Cannot set mode ${mode.toString(8)} on ${path}: ${errorMessage(error)}`);
	}
}

/** Every component from `root` down to `path`, both ends included; empty when `path` escapes. */
function chainFromRoot(root: string, path: string): string[] {
	const resolvedRoot = resolve(root);
	const resolved = resolve(path);
	const rel = relative(resolvedRoot, resolved);
	if (resolved === resolvedRoot) return [resolvedRoot];
	if (!rel || rel.startsWith("..") || resolve(resolvedRoot, rel) !== resolved) return [];
	const chain: string[] = [resolvedRoot];
	let current = resolvedRoot;
	for (const component of rel.split(sep).filter(Boolean)) {
		current = join(current, component);
		chain.push(current);
	}
	return chain;
}

/**
 * Verify that `path` sits inside the private root on a chain of directories we own
 * and no other account can write into. Does not consult the provenance record.
 */
export function verifyPrivateEntryChain(root: string, path: string): TempEntryCheck {
	const chain = chainFromRoot(root, path);
	if (chain.length === 0) {
		return reject(path, "outside-root", "the path is not inside the private cache root");
	}
	for (const component of chain) {
		const stats = lstatOrNull(component);
		if (!stats) return reject(component, "missing", "the path does not exist yet");
		const problem = directoryProblem(component, stats);
		if (!problem.trusted) return problem;
	}
	return TRUSTED;
}

/**
 * Create every missing component between `boundary` (exclusive) and `path`
 * (inclusive) as a private directory owned by us, refusing to continue when an
 * existing component of the chain is not ours, is a symlink, or lets another account
 * write into it. Existing components are tightened rather than trusted as found:
 * `mkdir`'s mode is umask-masked, and a loosened directory of ours is still ours.
 */
export function ensurePrivateDirectoryPath(path: string, boundary: string): void {
	const resolvedBoundary = resolve(boundary);
	const boundaryStats = lstatOrNull(resolvedBoundary);
	if (!boundaryStats) throw new Error(`The private cache root disappeared: ${resolvedBoundary}`);
	const boundaryProblem = directoryProblem(resolvedBoundary, boundaryStats);
	if (!boundaryProblem.trusted) {
		throw new Error(`Refusing to use an unverified cache root at ${resolvedBoundary} (${boundaryProblem.message})`);
	}
	const chain = chainFromRoot(resolvedBoundary, path);
	if (chain.length === 0) {
		throw new Error(`Refusing to create ${path} outside the private cache root ${resolvedBoundary}`);
	}
	for (const component of chain.slice(1)) {
		const stats = lstatOrNull(component);
		if (!stats) {
			try {
				mkdirSync(component, { mode: PRIVATE_DIRECTORY_MODE });
			} catch (error) {
				if (!isErrorCode(error, "EEXIST")) {
					throw new Error(`Cannot create the private cache directory ${component}: ${errorMessage(error)}`);
				}
			}
			chmodDirectory(component, PRIVATE_DIRECTORY_MODE);
			const created = lstatOrNull(component);
			if (!created) throw new Error(`The cache directory ${component} disappeared after creation`);
			const createdProblem = directoryProblem(component, created);
			if (!createdProblem.trusted) {
				throw new Error(`Refusing to use the cache directory ${component} (${createdProblem.message})`);
			}
			continue;
		}
		const problem = directoryProblem(component, stats);
		if (!problem.trusted) {
			throw new Error(`Refusing to use an unverified cache directory at ${component} (${problem.message})`);
		}
		chmodDirectory(component, modeOf(stats) & ~WRITABLE_BY_OTHERS);
	}
}

function entryKey(root: string, path: string): string {
	const rel = relative(resolve(root), resolve(path));
	return rel.split(sep).join("/");
}

function provenanceRecordPath(root: string, key: string): string {
	const digest = createHash("sha256").update(`${root}\u0000${key}`).digest("hex").slice(0, PROVENANCE_NAME_LENGTH);
	return join(root, PROVENANCE_DIR_NAME, `${digest}.json`);
}

function readToken(tokenPath: string): string | undefined {
	const stats = lstatOrNull(tokenPath);
	if (!stats) return undefined;
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to use a non-regular cache token at ${tokenPath}`);
	}
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`Refusing to use a cache token owned by another user: ${tokenPath}`);
	}
	if (process.platform !== "win32" && (modeOf(stats) & 0o077) !== 0) chmodSync(tokenPath, PRIVATE_FILE_MODE);
	const token = readFileSync(tokenPath, "utf-8").trim();
	return token.length > 0 ? token : undefined;
}

/** Exclusive create, so a planted token file is never quietly adopted: `EEXIST` propagates. */
function writeNewToken(tokenPath: string): string {
	const token = randomBytes(16).toString("hex");
	const fd = openSync(tokenPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE);
	try {
		writeFileSync(fd, `${token}\n`, "utf-8");
		if (process.platform !== "win32") chmodSync(tokenPath, PRIVATE_FILE_MODE);
	} finally {
		closeSync(fd);
	}
	return token;
}

/** Claim `root` as our private cache, or say why it cannot be claimed. */
function claimRoot(root: string, fellBack: boolean): { cache?: PrivateTempCache; error?: string } {
	let stats: Stats | undefined;
	try {
		stats = lstatOrNull(root);
	} catch (error) {
		return { error: errorMessage(error) };
	}
	if (!stats) return { error: "the directory does not exist" };
	const problem = directoryProblem(root, stats);
	if (!problem.trusted) return { error: problem.message ?? problem.reason };
	try {
		// The root itself is exactly 0700: nothing under it is reachable by another
		// account, so an entry name that used to be computable is inert now.
		chmodDirectory(root, PRIVATE_DIRECTORY_MODE);
		const provenanceDir = join(root, PROVENANCE_DIR_NAME);
		ensurePrivateDirectoryPath(provenanceDir, root);
		chmodDirectory(provenanceDir, PRIVATE_DIRECTORY_MODE);
		const tokenPath = join(provenanceDir, TOKEN_FILE_NAME);
		let token: string | undefined;
		try {
			token = writeNewToken(tokenPath);
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
			token = readToken(tokenPath);
		}
		if (!token) throw new Error(`no usable cache token at ${tokenPath}`);
		return { cache: { root, token, fellBack } };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

/**
 * Claim the per-user private cache root for `namespace` (today: `pi-extensions`).
 *
 * `tmpdir()` is read on every call rather than cached at import time so a process
 * that changes `TMPDIR` (tests, sandboxed launches, systemd PrivateTmp) does not
 * keep using the old location.
 */
export function ensurePrivateTempCache(namespace: string): PrivateTempCache {
	const predictable = join(tmpdir(), `${namespace}-${uidSuffix()}`);
	if (!existsSync(predictable)) {
		// Only created when the name is free: an existing entry we cannot claim belongs
		// to somebody else, and it is neither chmod-ed nor deleted.
		try {
			mkdirSync(predictable, { mode: PRIVATE_DIRECTORY_MODE });
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) {
				throw new Error(`Cannot create the private extension cache root ${predictable}: ${errorMessage(error)}`);
			}
		}
	}
	const claimed = claimRoot(predictable, false);
	if (claimed.cache) return claimed.cache;
	return claimFallbackRoot(predictable, claimed.error ?? "unknown", namespace);
}

/** Age after which one of our own one-off cache roots counts as abandoned. */
const FALLBACK_ROOT_TTL_MS = 60 * 60 * 1000;
/** How many recent one-off roots stay on disk, so a live sibling process keeps its cache. */
const FALLBACK_ROOT_KEEP = 3;

/**
 * Bound the number of one-off roots this namespace leaves behind. A process that
 * cannot claim the per-uid root installs into a fresh `mkdtemp` directory, so an
 * unbounded run of launches under a squat would become a disk leak that amplifies
 * the attack. Only our own `pi-extensions-<uid>-*` directories are candidates, and
 * the newest `FALLBACK_ROOT_KEEP` of them are kept so a sibling process that is
 * still using one does not lose it.
 */
function pruneFallbackRoots(prefix: string, keep: string): void {
	const marker = `${prefix}-`;
	let names: string[];
	try {
		names = readdirSync(tmpdir());
	} catch {
		return;
	}
	const candidates: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!name.startsWith(marker)) continue;
		const path = join(tmpdir(), name);
		if (resolve(path) === resolve(keep)) continue;
		let stats: Stats;
		try {
			stats = lstatSync(path);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
		const uid = currentUid();
		if (uid !== undefined && stats.uid !== uid) continue;
		candidates.push({ path, mtimeMs: stats.mtimeMs });
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const now = Date.now();
	for (const candidate of candidates.slice(FALLBACK_ROOT_KEEP)) {
		if (now - candidate.mtimeMs < FALLBACK_ROOT_TTL_MS) continue;
		try {
			rmSync(candidate.path, { recursive: true, force: true });
		} catch {
			// Housekeeping never outranks the cache: a root that cannot be removed now is
			// left for the next launch rather than failing the install.
		}
	}
}

function claimFallbackRoot(predictable: string, error: string, namespace: string): PrivateTempCache {
	const notice =
		`The private extension cache root ${predictable} is not usable (${error}). ` +
		"prime-agent switched to a one-off private directory, so cached extensions will be installed again.";
	const prefix = `${namespace}-${uidSuffix()}`;
	let fresh: string;
	try {
		fresh = mkdtempSync(join(tmpdir(), `${prefix}-`));
	} catch (mkdtempError) {
		throw new Error(`${notice} And no replacement directory could be created: ${errorMessage(mkdtempError)}`);
	}
	const fallback = claimRoot(fresh, true);
	if (!fallback.cache) {
		throw new Error(`${notice} And the replacement directory was refused: ${fallback.error}`);
	}
	try {
		pruneFallbackRoots(prefix, fresh);
	} catch {
		// Never let cleanup decide whether the cache works.
	}
	return { ...fallback.cache, notice };
}

/**
 * Claim the entry chain right after a successful install: strip group/other write
 * bits from every directory between the root and the entry, then vouch for it.
 *
 * The tightening happens here rather than at verification time because a loosened
 * entry may already have been written to by another account, and then the answer is
 * "reinstall", not "keep it and fix the mode". Right after the install, the contents
 * are known to be the installer's own.
 */
export function markTempEntryInstalled(cache: PrivateTempCache, path: string): void {
	for (const component of chainFromRoot(cache.root, path)) {
		const stats = lstatOrNull(component);
		if (stats && process.platform !== "win32" && (modeOf(stats) & WRITABLE_BY_OTHERS) !== 0) {
			chmodDirectory(component, modeOf(stats) & ~WRITABLE_BY_OTHERS);
		}
	}
	const check = verifyPrivateEntryChain(cache.root, path);
	if (!check.trusted) {
		throw new Error(
			`Refusing to record provenance for an unverified cache entry ${path} (${check.message ?? check.reason})`,
		);
	}
	const key = entryKey(cache.root, path);
	const recordPath = provenanceRecordPath(cache.root, key);
	const payload = `${JSON.stringify({ version: PROVENANCE_RECORD_VERSION, token: cache.token, key })}\n`;
	const fd = openSync(recordPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, PRIVATE_FILE_MODE);
	try {
		const stats = lstatSync(recordPath);
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw new Error(`Refusing to write cache provenance through ${recordPath}`);
		}
		writeFileSync(fd, payload, "utf-8");
		if (process.platform !== "win32") chmodSync(recordPath, PRIVATE_FILE_MODE);
	} finally {
		closeSync(fd);
	}
}

/** The install record for `path`, if this cache root wrote one. */
function provenanceCheck(cache: PrivateTempCache, path: string): TempEntryCheck {
	const key = entryKey(cache.root, path);
	const recordPath = provenanceRecordPath(cache.root, key);
	let stats: Stats;
	try {
		stats = lstatSync(recordPath);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) {
			return reject(path, "unprovenanced", "no install record: this directory was not installed by prime-agent");
		}
		return reject(path, "unprovenanced", errorMessage(error));
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		return reject(path, "unprovenanced", `the install record ${recordPath} is not a regular file`);
	}
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== uid) {
		return reject(path, "unprovenanced", `the install record ${recordPath} is owned by another user`);
	}
	let parsed: { version?: number; token?: string; key?: string };
	try {
		parsed = JSON.parse(readFileSync(recordPath, "utf-8")) as { version?: number; token?: string; key?: string };
	} catch (error) {
		return reject(path, "unprovenanced", `the install record is unreadable: ${errorMessage(error)}`);
	}
	if (parsed.version !== PROVENANCE_RECORD_VERSION || parsed.key !== key || parsed.token !== cache.token) {
		return reject(path, "unprovenanced", "the install record does not belong to this cache root");
	}
	return TRUSTED;
}

/**
 * Decide whether `path` may be loaded from, or used as the working directory of an
 * installer: the chain must be private and ours, and the entry must carry this
 * root's install record.
 */
export function verifyTempEntry(cache: PrivateTempCache, path: string): TempEntryCheck {
	const chain = verifyPrivateEntryChain(cache.root, path);
	if (!chain.trusted) return chain;
	return provenanceCheck(cache, path);
}

function forgetTempEntry(cache: PrivateTempCache, path: string): void {
	const recordPath = provenanceRecordPath(cache.root, entryKey(cache.root, path));
	try {
		unlinkSync(recordPath);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

/**
 * Delete a cache entry that failed verification, together with its install record.
 *
 * Only reachable for paths under a root this process claimed: the parent chain is
 * re-verified with the same rules first, a symlink is unlinked rather than followed,
 * and a directory owned by another account is refused (which is also what the sticky
 * bit on `/tmp` enforces). Somebody else's pre-existing directory is never deleted.
 */
export function removeTempEntry(cache: PrivateTempCache, path: string): void {
	const resolved = resolve(path);
	const parentCheck = verifyPrivateEntryChain(cache.root, dirname(resolved));
	if (!parentCheck.trusted && parentCheck.reason !== "missing") {
		throw new Error(`Refusing to remove ${resolved}: its parent chain is unverified (${parentCheck.message})`);
	}
	const stats = lstatOrNull(resolved);
	if (!stats) {
		forgetTempEntry(cache, resolved);
		return;
	}
	if (stats.isSymbolicLink()) {
		unlinkSync(resolved);
		forgetTempEntry(cache, resolved);
		return;
	}
	if (!stats.isDirectory()) {
		throw new Error(`Refusing to remove the non-directory cache entry ${resolved}`);
	}
	const uid = currentUid();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`Refusing to remove ${resolved}: it is owned by uid ${stats.uid}, not ${uid}`);
	}
	rmSync(resolved, { recursive: true, force: true });
	forgetTempEntry(cache, resolved);
}
