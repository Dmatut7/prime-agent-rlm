import { constants, copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { writePrivateFileAtomic } from "../utils/private-files.js";
import { createSessionId, isValidSessionId, readSessionHeaderId } from "./session-manager.js";

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
	/**
	 * The session id the copy must carry, when it may not keep the one in its own header:
	 * another transcript in the directory already declares that id. A copy that kept it would
	 * make `--resume <id>` ambiguous for both transcripts and would have them write into one
	 * artifact directory, so the copy gets the id of the file it lands in instead.
	 */
	sessionId?: string;
}

/**
 * Session ids declared by the headers of the transcripts in a directory.
 *
 * A file name is not an identity: an exported transcript renamed on the way in, or one that an
 * older build imported without re-iding it, declares its id only in its header. `--resume <id>`
 * and every artifact directory are keyed on that header id, so an import has to ask the same
 * question the resolver does - which ids are already taken here - and not only whether the name
 * it wants is free. A file whose header cannot be read claims nothing: it is not listable, and
 * the transcript that lands on its name replaces it.
 */
function claimedSessionIds(sessionDir: string): Set<string> {
	const claimed = new Set<string>();
	let names: string[];
	try {
		names = readdirSync(sessionDir);
	} catch {
		return claimed;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const id = readSessionHeaderId(join(sessionDir, name));
		if (id !== undefined) claimed.add(id);
	}
	return claimed;
}

/** A session id the copy may own: its file stem when that is legal and free, else a fresh one. */
function pickFreeSessionId(stem: string, claimed: Set<string>): string {
	if (isValidSessionId(stem) && !claimed.has(stem)) return stem;
	for (let attempt = 0; attempt < 100; attempt++) {
		const sessionId = createSessionId();
		if (!claimed.has(sessionId)) return sessionId;
	}
	throw new Error(`Unable to pick a free session id for ${stem}.jsonl`);
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
 *
 * A free name is still not enough. Two transcripts in one directory may not declare
 * one session id, so a copy whose header id is already claimed by a different
 * transcript is given the id of the file it lands in; a copy that claims an id
 * nobody else has keeps its bytes - and its id - unchanged.
 */
export function resolveImportDestination(sourcePath: string, requestedPath: string): ImportDestination {
	const dir = dirname(requestedPath);
	const ext = extname(requestedPath);
	const stem = basename(requestedPath, ext);
	const sourceSessionId = readSessionHeaderId(sourcePath);
	if (!existsSync(requestedPath)) {
		if (sourceSessionId === undefined) return { path: requestedPath, renamed: false, reusedExisting: false };
		const claimed = claimedSessionIds(dir);
		if (!claimed.has(sourceSessionId)) return { path: requestedPath, renamed: false, reusedExisting: false };
		return {
			path: requestedPath,
			renamed: false,
			reusedExisting: false,
			sessionId: pickFreeSessionId(stem, claimed),
		};
	}
	if (holdsIdenticalContent(sourcePath, requestedPath)) {
		// Reuse the registered file instead of rewriting it: the destination may be
		// the live session's own transcript, and a copy would race its next append.
		return { path: requestedPath, renamed: false, reusedExisting: true };
	}
	const claimed = claimedSessionIds(dir);
	for (let suffix = 2; suffix <= IMPORT_SUFFIX_LIMIT; suffix++) {
		const candidateStem = `${stem}-${suffix}`;
		const candidate = join(dir, `${candidateStem}${ext}`);
		if (existsSync(candidate)) continue;
		// The copy is a distinct session sitting next to the one that already holds
		// this name, so it gets an id of its own - the new stem when that is a legal
		// and unclaimed session id, otherwise a generated one.
		return {
			path: candidate,
			renamed: true,
			reusedExisting: false,
			sessionId: pickFreeSessionId(candidateStem, claimed),
		};
	}
	throw new Error(`Unable to find a free import destination next to ${requestedPath}`);
}

/**
 * Copy an imported transcript into the session directory.
 *
 * A copy that must not keep the source's session id - because the name was taken, or
 * because `options.sessionId` says another transcript in the directory already
 * declares it - lands with that id instead, so no two files share one session id.
 * Only the header line is rewritten; the transcript body is copied byte for byte.
 */
export function copyImportedSession(
	sourcePath: string,
	destinationPath: string,
	options: { renamed: boolean; sessionId?: string },
): void {
	// Both branches must never land on an occupied path: the caller picked this
	// destination because it was free, so a file appearing in between fails the
	// import instead of replacing a registered transcript.
	if (existsSync(destinationPath)) {
		throw new Error(`Refusing to overwrite an existing session file: ${destinationPath}`);
	}
	if (!options.renamed && !options.sessionId) {
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
	const sessionId = options.sessionId ?? pickFreeSessionId(stem, claimedSessionIds(dirname(destinationPath)));
	if (sessionId === header.id) {
		copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
		return;
	}
	const head = Buffer.from(`${JSON.stringify({ ...header, id: sessionId })}\n`, "utf8");
	const body = headEnd === -1 ? content.subarray(content.length) : content.subarray(headEnd + 1);
	writePrivateFileAtomic(destinationPath, Buffer.concat([head, body]));
}
