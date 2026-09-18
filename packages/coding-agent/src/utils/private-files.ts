import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * `O_NOFOLLOW` is undefined on win32. Degrade to 0 so private writes still work;
 * lstat-before-open and fstat-after-open keep rejecting symlinks. The remaining
 * unprotected window is open→fstat on platforms without the flag.
 */
export function requireNoFollow(flag: number | undefined): number {
	return flag ?? 0;
}

const NONBLOCK_FLAG = constants.O_NONBLOCK ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

const VALIDATED_DIRECTORY_LIMIT = 256;
/** Approximates a 64KiB write batch; log lines are close enough to ASCII that chars do. */
const WRITE_BATCH_CHARS = 64 * 1024;
/**
 * Private directories already validated in this process. Re-walking every
 * ancestor on each append costs dozens of syscalls on paths that run per log
 * line and per session entry. A hit still lstat's the directory, so a deleted
 * one is recreated, a swap for a symlink or a non-directory is refused, and a
 * loosened mode is re-tightened; the checks on the file being written stay per
 * call. What a hit skips is the ancestor walk only.
 */
const validatedDirectories = new Set<string>();

function rememberValidatedDirectory(resolvedPath: string): void {
	if (validatedDirectories.size >= VALIDATED_DIRECTORY_LIMIT) {
		// FIFO, not LRU: insertion order is cheap to evict and this is a bound, not a
		// cache-hit optimisation.
		const oldest = validatedDirectories.values().next().value;
		if (oldest !== undefined) validatedDirectories.delete(oldest);
	}
	validatedDirectories.add(resolvedPath);
}

function pathExistsLexical(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function ensureNoSymlinkPath(path: string, mode: number): void {
	const target = resolve(path);
	const root = parse(target).root;
	const components = target.slice(root.length).split(/[/\\]/).filter(Boolean);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		if (!pathExistsLexical(current)) {
			try {
				mkdirSync(current, { mode });
				// mkdir's mode is umask-masked; enforce the exact private bits.
				chmodSync(current, mode);
			} catch (error) {
				if (!isAlreadyExistsError(error)) throw error;
			}
		}
		const stats = lstatSync(current);
		if (stats.isSymbolicLink()) {
			// Intermediate symlinks (e.g. a symlinked ~/.prime) are followed after
			// resolution; only the final component keeps the O_NOFOLLOW refusal so the
			// private target itself is never swapped through a link.
			if (index === components.length - 1) {
				throw new Error(`Refusing to use non-directory private path: ${current}`);
			}
			current = realpathSync(current);
			continue;
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to use non-directory private path: ${current}`);
		}
	}
}

function setPrivateFileMode(fd: number, path: string, mode: number): void {
	if (process.platform === "win32") {
		chmodSync(path, mode);
	} else {
		fchmodSync(fd, mode);
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * Write the whole payload, looping on short counts. A single fd write may
 * return a short count without throwing (ENOSPC or a file-size limit does
 * exactly that), and writeFileSync does not loop: a short write here would
 * leave a torn line that the atomic-rename writers then promote to the target
 * file, exactly the torn-tail corruption the open-time repair tolerates by
 * dropping the line. A zero or negative count is a stall, not progress, so it
 * throws instead of spinning (same discipline as event-log's writeAllSync).
 */
function writeAllSync(fd: number, data: string | Uint8Array, path: string): void {
	const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) {
			throw new Error(`Short write persisting ${path}`);
		}
		offset += written;
	}
}

function openRegularFileNoSymlink(path: string, flags: number): number {
	assertRegularFileNoSymlink(path);
	const fd = openSync(path, flags | requireNoFollow(constants.O_NOFOLLOW) | NONBLOCK_FLAG);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Refusing to use non-regular private file: ${path}`);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function assertRegularFileNoSymlink(path: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${path}`);
	}
}

export function ensurePrivateDirectory(path: string): void {
	const resolved = resolve(path);
	// Check the resolved path, not the caller's spelling: a trailing slash or "/."
	// makes POSIX lstat follow a symlinked final component, so an unnormalized check
	// would see the link's 0700 target and accept the link.
	if (validatedDirectories.has(resolved) && stillUsablePrivateDirectory(resolved)) return;
	validatedDirectories.delete(resolved);
	// Validate the resolved spelling too, so the key and the checked object are the
	// same string everywhere in this function. resolve() is idempotent, so this does
	// not change behaviour.
	validatePrivateDirectory(resolved);
	rememberValidatedDirectory(resolved);
}

/**
 * One lstat on the memo fast path. It keeps the properties a hit must not lose:
 * a directory that disappeared is recreated by the full validation, a directory
 * swapped for a symlink or a non-directory is refused by it, and a directory
 * whose mode was loosened externally is re-tightened by it. The mode comes from
 * the same lstat, so re-checking it costs nothing. Only the ancestor walk is
 * skipped, which needs write access to an ancestor to subvert.
 *
 * On win32 a directory's mode bits do not report 0700, so the hit condition
 * `(stats.mode & 0o777) === PRIVATE_DIRECTORY_MODE` is not satisfied and every call
 * takes the full path: same behaviour as before the memo, at the cost of one extra
 * lstat. Nothing here depends on a platform this test suite cannot observe.
 */
function stillUsablePrivateDirectory(resolvedPath: string): boolean {
	try {
		const stats = lstatSync(resolvedPath);
		// !isSymbolicLink() is redundant under lstat semantics (a link to a directory
		// reports isDirectory() false), and is kept as explicit defence in depth rather
		// than nailed by its own test. The other two conditions each have one.
		return !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 0o777) === PRIVATE_DIRECTORY_MODE;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function validatePrivateDirectory(path: string): void {
	ensureNoSymlinkPath(path, PRIVATE_DIRECTORY_MODE);
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`Refusing to use non-directory private path: ${path}`);
	}
	if (process.platform === "win32") {
		if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) chmodSync(path, PRIVATE_DIRECTORY_MODE);
		return;
	}
	const fd = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG | requireNoFollow(constants.O_NOFOLLOW));
	try {
		const openedStats = fstatSync(fd);
		if (!openedStats.isDirectory()) throw new Error(`Refusing to use non-directory private path: ${path}`);
		if ((openedStats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
			setPrivateFileMode(fd, path, PRIVATE_DIRECTORY_MODE);
		}
	} finally {
		closeSync(fd);
	}
}

export function ensurePrivateFile(path: string, initialContent = ""): void {
	ensurePrivateDirectory(dirname(path));
	if (!pathExistsLexical(path)) {
		let fd: number | undefined;
		try {
			fd = openSync(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
				PRIVATE_FILE_MODE,
			);
			writeAllSync(fd, initialContent, path);
			// open's mode is umask-masked; fix it while the writable fd is still open,
			// before the O_RDONLY reopen below can EACCES on a mode-000 file.
			setPrivateFileMode(fd, path, PRIVATE_FILE_MODE);
		} catch (error) {
			// Another process may have won the exclusive-create race. The regular-file
			// check below validates its result without ever following a symlink.
			if (!isAlreadyExistsError(error)) {
				if (fd !== undefined) {
					const created = fstatSync(fd);
					closeSync(fd);
					fd = undefined;
					try {
						const current = lstatSync(path);
						if (current.dev === created.dev && current.ino === created.ino) rmSync(path, { force: true });
					} catch (cleanupError) {
						if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
							throw cleanupError;
						}
					}
				}
				throw error;
			}
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	const privateFd = openRegularFileNoSymlink(path, constants.O_RDONLY);
	try {
		setPrivateFileMode(privateFd, path, PRIVATE_FILE_MODE);
	} finally {
		closeSync(privateFd);
	}
}

/**
 * Tighten an existing private file to 0600 without rewriting it. Used for files a
 * migration keeps on purpose: the copy is not a healthy private store (so the
 * helpers above would refuse it), but it must not stay readable by other accounts
 * on the machine while it sits there.
 */
export function tightenPrivateFileMode(path: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) return;
	if ((stats.mode & 0o777) === PRIVATE_FILE_MODE) return;
	chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * Delete a private file and verify it is gone. A symlink at `path` is unlinked as a
 * link (its target is never opened, read or deleted), a directory is refused rather
 * than recursively removed, and a path that survives the removal throws: a cleanup
 * that cannot delete a credential copy must not look like it succeeded. Returns
 * false when there was nothing to delete.
 */
export function removePrivateFile(path: string): boolean {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
	if (stats.isDirectory()) {
		throw new Error(`Refusing to remove non-regular private file: ${path}`);
	}
	rmSync(path, { force: true });
	if (pathExistsLexical(path)) {
		throw new Error(`Private file still present after removal: ${path}`);
	}
	return true;
}

export function readPrivateFile(path: string, encoding: BufferEncoding): string {
	const fd = openRegularFileNoSymlink(path, constants.O_RDONLY);
	try {
		setPrivateFileMode(fd, path, PRIVATE_FILE_MODE);
		return readFileSync(fd, encoding);
	} finally {
		closeSync(fd);
	}
}

function ensureParentDirectory(path: string, privateParent: boolean): void {
	const parent = dirname(path);
	if (privateParent) {
		ensurePrivateDirectory(parent);
		return;
	}
	// User-chosen output parent (e.g. an HTML export path): no private-store
	// hardening here — macOS /tmp is a symlink, and refusing it would break
	// legitimate output paths. The file write itself still goes through
	// O_NOFOLLOW + atomic rename with private modes.
	mkdirSync(parent, { recursive: true });
}

export function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: { privateParent?: boolean } = {},
): void {
	ensureParentDirectory(path, options.privateParent !== false);
	if (pathExistsLexical(path)) {
		assertRegularFileNoSymlink(path);
	}
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
			PRIVATE_FILE_MODE,
		);
		writeAllSync(fd, content, path);
		// open's mode is umask-masked; enforce the exact private bits before the
		// temp file can be renamed into place.
		setPrivateFileMode(fd, tempPath, PRIVATE_FILE_MODE);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

export function writePrivateFileAtomicLines(
	path: string,
	lines: Iterable<string>,
	options: { preserveOwnership?: boolean; privateParent?: boolean } = {},
): void {
	ensureParentDirectory(path, options.privateParent !== false);
	if (pathExistsLexical(path)) assertRegularFileNoSymlink(path);
	const metadata = options.preserveOwnership && pathExistsLexical(path) ? statSync(path) : undefined;
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
			PRIVATE_FILE_MODE,
		);
		// Batch the writes: callers pass a per-entry generator, so one syscall per
		// line turns a 5000-entry session into 5000 syscalls. Atomicity is unchanged
		// - the temp file is still fsynced and renamed, and a failure mid-batch leaves
		// the finally block to remove the temp without renaming.
		let batch = "";
		for (const line of lines) {
			batch += line;
			if (batch.length >= WRITE_BATCH_CHARS) {
				writeAllSync(fd, batch, path);
				batch = "";
			}
		}
		if (batch.length > 0) writeAllSync(fd, batch, path);
		// open's mode is umask-masked; enforce the exact private bits before the
		// temp file can be renamed into place.
		setPrivateFileMode(fd, tempPath, PRIVATE_FILE_MODE);
		fsyncSync(fd);
		if (metadata && process.platform !== "win32") fchownSync(fd, metadata.uid, metadata.gid);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

/** Thrown when an append is refused because the file's last byte is not a newline. */
export class UnterminatedTailError extends Error {
	constructor(readonly path: string) {
		super(`refusing to append onto an unterminated tail: ${path}`);
		this.name = "UnterminatedTailError";
	}
}

/** Whether the byte at `size - 1` on this descriptor is a newline (same rule as endsWithNewlineSync). */
function fdEndsWithNewline(fd: number, size: number): boolean {
	const lastByte = Buffer.allocUnsafe(1);
	return readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] === 0x0a;
}

export function appendPrivateFile(
	path: string,
	content: string,
	options: { privateParent?: boolean; requireTerminatedTail?: boolean } = {},
): void {
	ensureParentDirectory(path, options.privateParent !== false);
	// requireTerminatedTail reads the tail from the same descriptor it appends
	// through, so that variant opens read-write (a private 0600 file the caller
	// owns) - the check and the write share one fd and one fstat.
	let flags =
		(options.requireTerminatedTail === true ? constants.O_RDWR : constants.O_WRONLY) |
		constants.O_APPEND |
		requireNoFollow(constants.O_NOFOLLOW) |
		NONBLOCK_FLAG;
	const exists = pathExistsLexical(path);
	if (exists) {
		assertRegularFileNoSymlink(path);
	} else {
		flags |= constants.O_CREAT | constants.O_EXCL;
	}
	let fd: number;
	try {
		fd = openSync(path, flags, PRIVATE_FILE_MODE);
	} catch (error) {
		if (!isAlreadyExistsError(error) || exists) throw error;
		fd = openRegularFileNoSymlink(
			path,
			(options.requireTerminatedTail === true ? constants.O_RDWR : constants.O_WRONLY) | constants.O_APPEND,
		);
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) throw new Error(`Refusing to use non-regular private file: ${path}`);
		// K3P-45 on the append descriptor: one pread of the last byte on the fd we
		// are about to append through, instead of a separate stat/open/read/close
		// pass (3 fewer syscalls) and without a window between the check and the
		// write (perfB③).
		if (options.requireTerminatedTail === true && stats.size > 0 && !fdEndsWithNewline(fd, stats.size)) {
			throw new UnterminatedTailError(path);
		}

		// The fstat is already paid for, so only chmod when the mode actually drifted.
		// win32 keeps the unconditional chmod: its mode bits do not report 0600.
		if (process.platform === "win32" || (stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
			setPrivateFileMode(fd, path, PRIVATE_FILE_MODE);
		}
		writeAllSync(fd, content, path);
	} finally {
		closeSync(fd);
	}
}

export interface PrivateTempFile {
	path: string;
	directory: string;
}

export function createPrivateTempFile(prefix: string, suffix: string, content = ""): PrivateTempFile {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(directory, PRIVATE_DIRECTORY_MODE);
	const path = join(directory, `${randomUUID()}${suffix}`);
	try {
		ensurePrivateFile(path, content);
		return { path, directory };
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
