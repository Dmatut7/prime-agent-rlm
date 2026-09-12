import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { writePrivateFileAtomic } from "../utils/private-files.js";
import { createSessionId, isValidSessionId } from "./session-manager.js";

/** Suffixes tried before giving up on a free sibling of the requested name. */
const IMPORT_SUFFIX_LIMIT = 1000;

/**
 * Whether both paths hold the same bytes (or are the same file). An unreadable
 * destination counts as "not identical" so the caller's copy surfaces the real
 * filesystem error instead of being skipped.
 */
function holdsIdenticalContent(leftPath: string, rightPath: string): boolean {
	try {
		const left = statSync(leftPath);
		const right = statSync(rightPath);
		if (left.dev === right.dev && left.ino === right.ino) return true;
		if (left.size !== right.size) return false;
		return readFileSync(leftPath).equals(readFileSync(rightPath));
	} catch {
		return false;
	}
}

function parseSessionHeaderLine(head: Buffer): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(head.toString("utf8"));
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			(parsed as { type?: unknown }).type === "session"
		) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// A headerless or damaged import keeps its bytes verbatim.
	}
	return undefined;
}

export interface ImportDestination {
	/** Where the imported transcript will live. */
	path: string;
	/** True when a different session already holds the requested name. */
	renamed: boolean;
	/** True when an existing file already holds these exact bytes, so no copy is needed. */
	reusedExisting: boolean;
}

/**
 * Pick where an imported transcript lands.
 *
 * `importFromJsonl` used to copy onto `join(sessionDir, basename(source))`
 * unconditionally, so importing a file whose basename matched a *different*
 * registered session replaced that session's transcript on disk and then reopened
 * its sessionId over the new content. An import must never overwrite: identical
 * content reuses the file that is already there (re-importing a copy of the same
 * transcript stays idempotent), different content moves to a free sibling name.
 */
export function resolveImportDestination(sourcePath: string, requestedPath: string): ImportDestination {
	if (!existsSync(requestedPath)) return { path: requestedPath, renamed: false, reusedExisting: false };
	if (holdsIdenticalContent(sourcePath, requestedPath)) {
		// Reuse the registered file instead of rewriting it: the destination may be
		// the live session's own transcript, and a copy would race its next append.
		return { path: requestedPath, renamed: false, reusedExisting: true };
	}
	const dir = dirname(requestedPath);
	const ext = extname(requestedPath);
	const stem = basename(requestedPath, ext);
	for (let suffix = 2; suffix <= IMPORT_SUFFIX_LIMIT; suffix++) {
		const candidate = join(dir, `${stem}-${suffix}${ext}`);
		if (!existsSync(candidate)) return { path: candidate, renamed: true, reusedExisting: false };
	}
	throw new Error(`Unable to find a free import destination next to ${requestedPath}`);
}

/**
 * Copy an imported transcript into the session directory.
 *
 * A renamed copy is a distinct session sitting next to the one that already holds
 * the source's session id, so it gets an id of its own - the new stem when that is
 * a legal session id, otherwise a generated one. Two files sharing one session id
 * make `--resume <id>` ambiguous and make both sessions write into one artifact
 * directory. Only the header line is rewritten; the transcript body is copied byte
 * for byte.
 */
export function copyImportedSession(sourcePath: string, destinationPath: string, options: { renamed: boolean }): void {
	// Both branches must never land on an occupied path: the caller picked this
	// destination because it was free, so a file appearing in between fails the
	// import instead of replacing a registered transcript.
	if (existsSync(destinationPath)) {
		throw new Error(`Refusing to overwrite an existing session file: ${destinationPath}`);
	}
	if (!options.renamed) {
		// COPYFILE_EXCL: the destination was chosen because it is free, so a file
		// appearing in between must fail the import instead of being overwritten.
		copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
		return;
	}
	const content = readFileSync(sourcePath);
	const headEnd = content.indexOf(0x0a);
	const header = parseSessionHeaderLine(headEnd === -1 ? content : content.subarray(0, headEnd));
	if (!header) {
		copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
		return;
	}
	const stem = basename(destinationPath, extname(destinationPath));
	const sessionId = isValidSessionId(stem) ? stem : createSessionId();
	const head = Buffer.from(`${JSON.stringify({ ...header, id: sessionId })}\n`, "utf8");
	const body = headEnd === -1 ? content.subarray(content.length) : content.subarray(headEnd + 1);
	writePrivateFileAtomic(destinationPath, Buffer.concat([head, body]));
}
