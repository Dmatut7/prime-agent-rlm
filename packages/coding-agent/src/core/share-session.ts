/**
 * /share preflight: find the credentials a session would leak, then create a private temp
 * HTML file.
 *
 * Reports shape, location and a front/back mask — never the matched secret text.
 */

import { readFileSync } from "node:fs";
import { createPrivateTempFile, type PrivateTempFile } from "../utils/private-files.js";
import { decodeEmbeddedSessionData } from "./export-html/session-data-embedding.js";
import {
	findShareIdentityFindings,
	formatShareIdentityHint,
	type ShareIdentityFinding,
	type ShareIdentityView,
} from "./share-identity-detectors.js";
import { maskSecretValue, SHARE_SECRET_DETECTORS, type ShareSecretMatch } from "./share-secret-detectors.js";
import { collectConfiguredShareSecretValues, type ShareSecretValue } from "./share-secret-values.js";

export type { ShareIdentityFinding } from "./share-identity-detectors.js";
export { formatShareIdentityHint } from "./share-identity-detectors.js";
export type { ShareSecretPattern } from "./share-secret-detectors.js";
export { SHARE_SECRET_PATTERNS } from "./share-secret-detectors.js";

/** One credential found in the bytes that would be uploaded. Carries no secret text. */
export interface ShareSecretFinding {
	/** Shape label, e.g. `API key (sk-)` or `Credential assignment`. */
	type: string;
	/** Which of the scanned views the hit is in, e.g. `the exported session payload`. */
	view: string;
	/** Offset of the value inside that view. */
	offset: number;
	/** 1-based line number of the value inside that view. */
	line: number;
	/** Front/back mask of the value, or a hidden-length marker for very short values. */
	masked: string;
	/** Non-secret identifier: the environment variable name or the config path it came from. */
	name?: string;
}

export interface ShareSecretScanOptions {
	/**
	 * Exact values that must not appear in the upload, usually the credentials this session
	 * has loaded. Omit it to use the value comparison only in `confirmShareIfSecrets`, which
	 * collects them; pass `[]` for a pure shape scan (tests do this for determinism).
	 */
	secretValues?: readonly ShareSecretValue[];
}

type ShareScanViewKind = "document" | "content";

interface ShareScanView {
	label: string;
	/**
	 * `document` is the export file itself (a fixed template around a base64 payload, so
	 * entropy scanning it would only match its own container); `content` is decoded text.
	 */
	kind: ShareScanViewKind;
	text: string;
}

const DOCUMENT_VIEW = "the export document";
const PAYLOAD_VIEW = "the exported session payload";
const CONTENT_VIEW = "the session text";

/** Detector order decides the order of the warning, and `SHARE_SECRET_PATTERNS` reads first. */
export function findShareSecretHits(content: string): string[] {
	return [...new Set(findShareSecretFindings(content).map((finding) => finding.type))];
}

/** Every credential in plain text, with shape, position and mask. */
export function findShareSecretFindings(content: string, options?: ShareSecretScanOptions): ShareSecretFinding[] {
	return scanShareSecretViews([{ label: CONTENT_VIEW, kind: "content", text: content }], options).findings;
}

/** Where one occurrence of a secret sits in a scanned view, and how long it is. */
interface ShareSecretOccurrence {
	offset: number;
	length: number;
}

/** Shortest value whose base64 form is distinctive enough to compare against. */
const MIN_BASE64_COMPARISON_LENGTH = 8;

/**
 * Every form one configured value can be written in. Exact comparison is the check that "no
 * unknown shape slips past", so comparing only the raw form gives the same secret a free pass
 * the moment it is escaped: `tok+/=abc` pasted into a URL query is `tok%2B%2F%3Dabc`,
 * and an `Authorization: Bearer`-style token is often carried base64. Each form is compared as a
 * substring of the original bytes, so a hit is also removable at the offset it was found at.
 *
 * Percent forms are only built when the value actually has a character worth escaping: for an
 * alphanumeric value they would be the value itself and every form would cost a scan of the
 * whole upload for nothing.
 */
function secretComparisonForms(value: string): string[] {
	const forms = [value];
	if (value.length === 0) return forms;
	const push = (form: string): void => {
		if (form.length > 0 && !forms.includes(form)) forms.push(form);
	};
	const percentEncoded = encodeURIComponent(value);
	if (percentEncoded !== value) {
		push(percentEncoded);
		// Hand-written and non-JS encoders emit lower-case hex.
		push(percentEncoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
		// Every character escaped (`%74%6F%6B…`), which is what some log scrubbers and URL
		// canonicalizers produce.
		const fullyEncoded = [...value].map((char) => encodeURIComponent(char)).join("");
		push(fullyEncoded);
		push(fullyEncoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
	}
	if (value.length >= MIN_BASE64_COMPARISON_LENGTH) {
		push(Buffer.from(value, "utf8").toString("base64"));
		push(Buffer.from(value, "utf8").toString("base64url"));
	}
	return forms;
}

/**
 * Line-wrap fold: a terminal wraps a pasted value (or a copy-paste re-wraps it), so the
 * value reaches the uploaded text as two halves with `\r\n`/`\n`/`\r` inside it. The exact
 * comparison is the check no unknown shape can slip past, so it also compares with every
 * line wrap removed - the same fold applied to the value and to the scanned text, so the
 * only difference folding can bridge is wrapping itself. Scan-only normalization: an
 * occurrence found in the folded text is mapped back to the span it occupies in the bytes
 * that will actually be uploaded, and the shape detectors' sensitivity is untouched.
 */
function foldLineWraps(text: string): string {
	return text.replace(/\r\n|\r|\n/g, "");
}

/** One view with its wraps removed, and where each surviving character sits in the original. */
interface FoldedView {
	text: string;
	offsets: number[];
}

/** Nothing to fold (no wrap in the text): the raw comparison already covers this view. */
function foldViewText(text: string): FoldedView | undefined {
	if (!text.includes("\n") && !text.includes("\r")) return undefined;
	const offsets: number[] = [];
	let folded = "";
	for (let position = 0; position < text.length; position += 1) {
		const char = text[position];
		if (char === "\r" || char === "\n") continue;
		offsets.push(position);
		folded += char;
	}
	return { text: folded, offsets };
}

interface ShareSecretScan {
	findings: ShareSecretFinding[];
	/**
	 * Every occurrence, including repeats of one value: a warning lists a value once, while
	 * `redactShareSecrets` has to remove it everywhere it appears.
	 */
	occurrences: ShareSecretOccurrence[];
}

function scanShareSecretViews(views: readonly ShareScanView[], options?: ShareSecretScanOptions): ShareSecretScan {
	const findings: ShareSecretFinding[] = [];
	const occurrences: ShareSecretOccurrence[] = [];
	// One line per distinct value: the same secret is present twice in an export payload
	// (raw and with its JSON escapes resolved), and a value caught by two detectors - an
	// `sk-` key is also a high-entropy token, and it also sits in a `NAME=value` assignment -
	// is one secret, not two.
	const seen = new Map<string, ShareSecretFinding>();

	const record = (view: ShareScanView, type: string, match: ShareSecretMatch, name?: string): void => {
		const masked = maskSecretValue(match.value);
		const existing = seen.get(masked);
		if (existing !== undefined) {
			// The first detector to find a value labels its shape; a later one can still know
			// the non-secret identifier that goes with it (the environment variable name).
			if (existing.name === undefined && name !== undefined) {
				existing.name = name;
			}
			return;
		}
		const finding: ShareSecretFinding = {
			type,
			view: view.label,
			offset: match.index,
			line: lineNumberAt(view.text, match.index),
			masked,
			...(name !== undefined ? { name } : {}),
		};
		seen.set(masked, finding);
		findings.push(finding);
	};

	for (const detector of SHARE_SECRET_DETECTORS) {
		for (const view of views) {
			if (view.kind === "document" && !detector.scansDocumentBytes) continue;
			for (const match of detector.detect(view.text)) {
				occurrences.push({ offset: match.index, length: match.value.length });
				record(view, detector.type, match, match.name);
			}
		}
	}

	// The folded pass is computed once per view, only when a view actually carries a wrap.
	const foldedViews = new Map<ShareScanView, FoldedView | undefined>();
	const foldedViewOf = (view: ShareScanView): FoldedView | undefined => {
		if (!foldedViews.has(view)) {
			foldedViews.set(view, foldViewText(view.text));
		}
		return foldedViews.get(view);
	};

	for (const secret of options?.secretValues ?? []) {
		// Every loaded value is compared against every view, with no shape and no plausibility in
		// the way. A `compareOnly` value is compared and then not reported *on its own*: it names
		// a location (`GOOGLE_APPLICATION_CREDENTIALS`), such a path appears in ordinary
		// transcripts, and a warning on each of those stops the warning being read. Dropping such
		// a value from the set is the mistake this check exists to avoid, so it is compared here;
		// bytes a shape detector recognizes are still reported by that detector.
		if (secret.compareOnly === true) continue;
		let reported = false;
		// Every form of the value is compared in every view, raw and encoded. The warning names
		// the value once (masked from the value itself, not from the form it was found in), while
		// the occurrences are what removal walks: a secret present in two encodings is two spans.
		for (const form of secretComparisonForms(secret.value)) {
			for (const view of views) {
				let index = view.text.indexOf(form);
				while (index >= 0) {
					occurrences.push({ offset: index, length: form.length });
					if (!reported) {
						record(
							view,
							"Configured credential",
							{ value: secret.value, index, name: secret.source },
							secret.source,
						);
						reported = true;
					}
					index = view.text.indexOf(form, index + form.length);
				}
			}
			// The folded pass: the form with its wraps removed, compared against each view
			// with its wraps removed, mapped back to the original span - wrap included, so a
			// removal replaces the value exactly as it appears in the uploaded bytes. A value
			// present intact is found by both passes at the same span; the removal half
			// already skips spans it has replaced.
			const foldedForm = foldLineWraps(form);
			if (foldedForm.length === 0) continue;
			for (const view of views) {
				const folded = foldedViewOf(view);
				if (folded === undefined) continue;
				let index = folded.text.indexOf(foldedForm);
				while (index >= 0) {
					const start = folded.offsets[index] ?? 0;
					const end = (folded.offsets[index + foldedForm.length - 1] ?? start) + 1;
					occurrences.push({ offset: start, length: end - start });
					if (!reported) {
						record(
							view,
							"Configured credential",
							{ value: secret.value, index: start, name: secret.source },
							secret.source,
						);
						reported = true;
					}
					index = folded.text.indexOf(foldedForm, index + foldedForm.length);
				}
			}
		}
	}

	return { findings, occurrences };
}

function lineNumberAt(text: string, index: number): number {
	let line = 1;
	for (let position = 0; position < index && position < text.length; position += 1) {
		if (text[position] === "\n") line += 1;
	}
	return line;
}

/**
 * JSON string escapes hide the separators a secret shape is delimited by: in the exported
 * payload `...\nAKIA...` puts a literal `n` in front of the key, so a `\b`-anchored pattern
 * never fires there. Unescape the two-character forms before scanning. Scan-only
 * normalization: the result is never stored, shown or returned, and it can only widen what
 * the preflight sees.
 */
const SCAN_JSON_ESCAPES = /\\(?:([nrtbf"\\/])|u([0-9a-fA-F]{4}))/g;

function unescapeForScan(text: string): string {
	return text.replace(SCAN_JSON_ESCAPES, (_match, single?: string, hex?: string) => {
		if (hex !== undefined) {
			return String.fromCharCode(Number.parseInt(hex, 16));
		}
		switch (single) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "b":
				return "\b";
			case "f":
				return "\f";
			default:
				return single ?? "";
		}
	});
}

/**
 * Every text view of the uploaded artifact that can carry a secret: the bytes as
 * uploaded (plaintext the exporter adds around the payload), the payload recovered
 * from the base64 container, and that payload with its JSON escapes resolved.
 */
function shareUploadScanViews(uploadedContent: string): ShareScanView[] {
	const views: ShareScanView[] = [{ label: DOCUMENT_VIEW, kind: "document", text: uploadedContent }];
	const payload = decodeEmbeddedSessionData(uploadedContent);
	if (payload !== undefined) {
		// The unescaped view is listed first so that positions and the non-secret names in a
		// warning refer to the session text a reader can find; the escaped view is still
		// scanned, because a shape can be hidden by an escape the unescaping does not cover.
		const unescaped = unescapeForScan(payload);
		if (unescaped !== payload) {
			views.push({ label: PAYLOAD_VIEW, kind: "content", text: unescaped });
		}
		views.push({ label: PAYLOAD_VIEW, kind: "content", text: payload });
	}
	return views;
}

/**
 * What a credential is replaced with before bytes leave the machine. Plain ASCII with no
 * quote, backslash or whitespace in it: a marker has to survive inside a JSON string, an
 * NDJSON line and a URL fragment without turning a parseable record into an unparseable one.
 */
export const REDACTED_SECRET_MARKER = "***redacted***";

export interface ShareSecretRedaction {
	/** The text with every detected credential replaced by `REDACTED_SECRET_MARKER`. */
	text: string;
	/** Shape labels of what was replaced, in detector order, deduplicated. Carries no secret text. */
	types: string[];
	/** How many values were replaced; a value that appears twice counts twice. */
	count: number;
}

/**
 * The removal half of the same scan `findShareSecretFindings` performs: every credential the
 * preflight would warn about - by shape, and by exact comparison with the values this session
 * is configured with - is replaced by a fixed marker.
 *
 * Used by upload paths that cannot ask a human (/traces sends the session on its own). The
 * warning path reports one line per distinct value; this one has to remove the value at every
 * offset it appears at, or the second copy of a key stays in the payload.
 */
export function redactShareSecrets(content: string, options?: ShareSecretScanOptions): ShareSecretRedaction {
	const scan = scanShareSecretViews([{ label: CONTENT_VIEW, kind: "content", text: content }], options);
	if (scan.occurrences.length === 0) {
		return { text: content, types: [], count: 0 };
	}
	const ordered = [...scan.occurrences].sort((left, right) => left.offset - right.offset);
	let text = "";
	let cursor = 0;
	let count = 0;
	for (const occurrence of ordered) {
		// Two detectors can recognize overlapping spans of the same value; the first replacement
		// already removed those bytes.
		if (occurrence.offset < cursor) continue;
		text += content.slice(cursor, occurrence.offset) + REDACTED_SECRET_MARKER;
		cursor = occurrence.offset + occurrence.length;
		count += 1;
	}
	return {
		text: text + content.slice(cursor),
		types: [...new Set(scan.findings.map((finding) => finding.type))],
		count,
	};
}

/** Credentials reachable from the bytes that will actually be uploaded, in detector order. */
export function findShareUploadSecretHits(uploadedContent: string, options?: ShareSecretScanOptions): string[] {
	return [...new Set(findShareUploadSecretFindings(uploadedContent, options).map((finding) => finding.type))];
}

/**
 * Credentials reachable from the bytes that will actually be uploaded, with the position
 * and shape of each one. The exported session travels as base64 inside the document, so
 * scanning the uploaded text alone scans an encoding of the session and passes every
 * secret it contains.
 */
export function findShareUploadSecretFindings(
	uploadedContent: string,
	options?: ShareSecretScanOptions,
): ShareSecretFinding[] {
	return scanShareSecretViews(shareUploadScanViews(uploadedContent), options).findings;
}

/**
 * Identity data reachable from the bytes that would actually be uploaded: absolute
 * paths under the user's home directory (the session cwd among them) and email-shaped
 * addresses. The same container logic as the secret scan: the document plus the
 * recovered payload, with its JSON escapes resolved. Only the resolved payload view of
 * the session is scanned - the escaped form cannot contain a hit its resolution does
 * not - so one occurrence is counted once, not once per view form.
 */
export function findShareUploadIdentityFindings(uploadedContent: string): ShareIdentityFinding[] {
	const payload = decodeEmbeddedSessionData(uploadedContent);
	const views: ShareIdentityView[] = [{ label: DOCUMENT_VIEW, text: uploadedContent }];
	if (payload !== undefined) {
		views.push({ label: PAYLOAD_VIEW, text: unescapeForScan(payload) });
	}
	return findShareIdentityFindings(views);
}

/**
 * The /export notice (round-27 SEC-5): the export surface that does not ask anything
 * still has to say what the file it just wrote carries. Reading the file back can fail
 * for reasons that do not invalidate the export - a path the writer resolved
 * differently, a file already moved on - and the notice is then simply omitted.
 */
export function shareExportIdentityHintFromFile(path: string): string | undefined {
	try {
		return formatShareIdentityHint(findShareUploadIdentityFindings(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

/** A confirm dialog is a decision, not a report: list the first few and count the rest. */
const MAX_LISTED_FINDINGS = 8;

/**
 * The confirm dialog: one line per credential with its shape, the non-secret name it was
 * assigned from, its position in the scanned text and a front/back mask, plus what the
 * upload would actually carry and what cancelling means. Identity findings are listed
 * the same way: they do not authenticate anyone, but they are exactly what the base64
 * container hides from a plain-text glance at the file (round-27 SEC-5), so the decision
 * to upload has to be made knowing they are in there.
 */
export function formatShareSecretWarning(
	findings: readonly ShareSecretFinding[],
	identityFindings: readonly ShareIdentityFinding[] = [],
): { title: string; message: string } {
	const listed = findings
		.slice(0, MAX_LISTED_FINDINGS)
		.map(
			(finding) =>
				`- ${finding.type}${finding.name ? ` ${finding.name}` : ""} — ${finding.view}, ${finding.masked} at line ${finding.line} (offset ${finding.offset})`,
		);
	if (findings.length > MAX_LISTED_FINDINGS) {
		listed.push(`- ...and ${findings.length - MAX_LISTED_FINDINGS} more`);
	}
	const identityListed = identityFindings.map(
		(finding) =>
			`- ${finding.type} — ${finding.view}, ${finding.count} ${finding.count === 1 ? "occurrence" : "occurrences"}`,
	);
	const sections: string[] = [];
	if (findings.length > 0) {
		sections.push(`This session looks like it contains secrets:\n${listed.join("\n")}`);
		if (identityListed.length > 0) {
			sections.push(`It also embeds data that identifies you:\n${identityListed.join("\n")}`);
		}
	} else {
		sections.push(`This session export embeds data that identifies you:\n${identityListed.join("\n")}`);
	}
	return {
		title: "Share session",
		message:
			`${sections.join("\n\n")}\n\n` +
			"Nothing is uploaded yet: cancel and the session is not shared.\n" +
			"/share uploads the exported session (messages, system prompt, tools, and the\n" +
			"working-directory context the exporter adds) as a private GitHub gist, and a secret\n" +
			"gist is readable by anyone who has the link. The session travels base64-encoded\n" +
			"inside the export, so none of the above is visible at a plain-text glance at the\n" +
			"file, and all of it is recoverable by anyone holding it.\n\n" +
			"Upload anyway?",
	};
}

/**
 * Gate an upload on a scan of `content`. Callers must pass the bytes that will actually be
 * uploaded, not a proxy for them: a narrower shape silently passes every secret that lives
 * outside it. Everything a viewer can recover from those bytes is scanned too (see
 * findShareUploadSecretFindings), and the values this session has loaded are compared
 * exactly, which is the only check an unknown credential shape cannot slip past.
 */
export async function confirmShareIfSecrets(
	content: string,
	confirm: (title: string, message: string) => Promise<boolean>,
	options?: ShareSecretScanOptions,
): Promise<boolean> {
	const secretValues = options?.secretValues ?? collectConfiguredShareSecretValues();
	const findings = findShareUploadSecretFindings(content, { secretValues });
	const identityFindings = findShareUploadIdentityFindings(content);
	if (findings.length === 0 && identityFindings.length === 0) {
		return true;
	}
	const warning = formatShareSecretWarning(findings, identityFindings);
	return confirm(warning.title, warning.message);
}

/**
 * Upper bound on one `gh gist create` upload. A lower bound on how long the
 * preflight waits, not a target: it has to sit above a large session export on a
 * slow link, because cutting a working upload off is worse than waiting. The
 * loader stays cancellable the whole time, so this only catches an upload whose
 * process stops reporting anything at all.
 */
export const SHARE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export function createShareTempHtmlFile(): PrivateTempFile {
	return createPrivateTempFile("prime-agent-share-", ".html");
}
