import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const PRIVATE_FILE_MODE = 0o600;

/** O_NOFOLLOW is undefined on win32; degrade to 0 so private writes still work there. */
function withNoFollow(flags: number): number {
	return flags | (constants.O_NOFOLLOW ?? 0);
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

function assertRegularFileNoSymlink(path: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${path}`);
	}
}

function setPrivateFileMode(fd: number, path: string): void {
	if (process.platform === "win32") {
		chmodSync(path, PRIVATE_FILE_MODE);
	} else {
		fchmodSync(fd, PRIVATE_FILE_MODE);
	}
}

/**
 * Atomic private write for credential files.
 *
 * Mirrors @earendil-works/pi-coding-agent's utils/private-files.ts
 * writePrivateFileAtomic contract (this package cannot import across that
 * dependency direction): the file lands 0600, a symlink already sitting at
 * `path` is refused instead of followed, and the content is written to a
 * private temp file and renamed into place so a crash never leaves a
 * half-written credentials file behind.
 */
export function writePrivateFileAtomic(path: string, content: string | Uint8Array): void {
	if (pathExistsLexical(path)) {
		assertRegularFileNoSymlink(path);
	}
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			withNoFollow(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
			PRIVATE_FILE_MODE,
		);
		writeFileSync(fd, content);
		// open's mode is umask-masked; enforce the exact private bits before the
		// temp file is renamed into place.
		setPrivateFileMode(fd, tempPath);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}
