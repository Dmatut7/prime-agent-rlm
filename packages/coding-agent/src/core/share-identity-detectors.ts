/**
 * Identity detectors behind the /share preflight and the /export notice (round-27 SEC-5).
 *
 * The export embeds the whole session — header cwd, usernames, email addresses — inside
 * one base64 blob, so the uploaded file shows none of it at a plain-text glance. The
 * credential detectors already scan the recovered payload; these cover the data that
 * identifies the user rather than authenticates them. A hit is never a block: sharing is
 * the user's decision, and the warning exists so that decision is made knowing what the
 * file carries.
 *
 * Two shapes, deliberately narrow:
 *
 * 1. `HOME_PATH` — an absolute path under `/Users/<name>` or `/home/<name>`: the
 *    username and the working directory in one match. The audit that produced this
 *    found 12 of them in one real export, none visible in the HTML itself.
 * 2. `EMAIL` — an address-shaped run. `@` is not a base64 character, so the encoded
 *    container cannot produce one by chance.
 */

import { maskSecretValue } from "./share-secret-detectors.js";

/** One category of identity-bearing text found in bytes that would leave the machine. */
export interface ShareIdentityFinding {
	/** Category label, e.g. `Absolute path under /Users/alice`. Must not carry secret text. */
	type: string;
	/** Which of the scanned views the hits are in, e.g. `the exported session payload`. */
	view: string;
	/** How many occurrences the view carries. */
	count: number;
	/** Front/back-masked preview of one occurrence. */
	example: string;
}

/** A text view of an export document, with the label a warning names it by. */
export interface ShareIdentityView {
	label: string;
	text: string;
}

/**
 * `/Users/<name>` or `/home/<name>`, with the username at least two characters. The
 * lookbehind keeps a base64 run (whose alphabet contains `/`) from matching by chance
 * and keeps `src/Users/…` — a repository directory, not a home directory — out.
 */
const HOME_PATH = /(?<![A-Za-z0-9])\/(?:Users|home)\/([A-Za-z0-9._-]{2,})/g;

/** An email-shaped run; the domain must have at least one dot. */
const EMAIL =
	/(?<![A-Za-z0-9._%+-])(?:[A-Za-z0-9_%+-]+\.)*[A-Za-z0-9_%+-]{2,}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![A-Za-z0-9])/g;

/** Map a matched value to the non-secret identity context a warning names it by. */
function homePathType(path: string): string {
	const homeRoot = /\/(?:Users|home)\/([A-Za-z0-9._-]{2,})/.exec(path);
	const root = homeRoot?.[0] ?? "/Users/<name>";
	return `Absolute path under ${root}`;
}

/**
 * Identity data in the given views of an export document: one finding per category and
 * view, with the occurrence count and a masked example. Callers pass the views they
 * want scanned — the /share preflight builds the document view plus the recovered
 * session payload — so an escaped form and its resolution are never counted twice.
 */
export function findShareIdentityFindings(views: readonly ShareIdentityView[]): ShareIdentityFinding[] {
	const findings: ShareIdentityFinding[] = [];
	const record = (view: ShareIdentityView, type: string, value: string): void => {
		const existing = findings.find((finding) => finding.type === type && finding.view === view.label);
		if (existing) {
			existing.count += 1;
			return;
		}
		findings.push({ type, view: view.label, count: 1, example: maskSecretValue(value) });
	};

	for (const view of views) {
		for (const match of view.text.matchAll(HOME_PATH)) {
			record(view, homePathType(match[0]), match[0]);
		}
		for (const match of view.text.matchAll(EMAIL)) {
			record(view, "Email address", match[0]);
		}
	}
	return findings;
}

/**
 * The one-line form of the same findings, for surfaces that are not asking anything:
 * the /export command and the CLI `--export` flag print it next to the file they just
 * wrote. Undefined when the document carries no identity data.
 */
export function formatShareIdentityHint(findings: readonly ShareIdentityFinding[]): string | undefined {
	if (findings.length === 0) return undefined;
	const counts = findings.map((finding) => identityPhrase(finding.type, finding.count)).join(", ");
	return `Note: this file embeds the full session as base64, recoverable by anyone holding it — including ${counts}.`;
}

/** `1 absolute path under /Users/alice`, `2 email addresses`. */
function identityPhrase(type: string, count: number): string {
	const lower = type[0].toLowerCase() + type.slice(1);
	if (count === 1) return `1 ${lower}`;
	if (type === "Email address") return `${count} email addresses`;
	if (type.startsWith("Absolute path")) return `${count} absolute paths${type.slice("Absolute path".length)}`;
	return `${count} ${lower}s`;
}
