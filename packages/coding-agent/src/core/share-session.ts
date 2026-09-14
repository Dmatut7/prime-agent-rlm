/**
 * /share preflight: find the credentials a session would leak, then create a private temp
 * HTML file.
 *
 * Reports shape, location and a front/back mask — never the matched secret text.
 */

import { createPrivateTempFile, type PrivateTempFile } from "../utils/private-files.js";
import { decodeEmbeddedSessionData } from "./export-html/session-data-embedding.js";
import { maskSecretValue, SHARE_SECRET_DETECTORS, type ShareSecretMatch } from "./share-secret-detectors.js";
import { collectConfiguredShareSecretValues, type ShareSecretValue } from "./share-secret-values.js";

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
	return scanShareSecretViews([{ label: CONTENT_VIEW, kind: "content", text: content }], options);
}

function scanShareSecretViews(views: readonly ShareScanView[], options?: ShareSecretScanOptions): ShareSecretFinding[] {
	const findings: ShareSecretFinding[] = [];
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
				record(view, detector.type, match, match.name);
			}
		}
	}

	for (const secret of options?.secretValues ?? []) {
		// Every loaded value is compared against every view, with no shape and no plausibility in
		// the way. A `compareOnly` value is compared and then not reported *on its own*: it names
		// a location (`GOOGLE_APPLICATION_CREDENTIALS`), such a path appears in ordinary
		// transcripts, and a warning on each of those stops the warning being read. Dropping such
		// a value from the set is the mistake this check exists to avoid, so it is compared here;
		// bytes a shape detector recognizes are still reported by that detector.
		const match = views
			.map((view) => ({ view, index: view.text.indexOf(secret.value) }))
			.find((candidate) => candidate.index >= 0);
		if (match === undefined || secret.compareOnly === true) continue;
		record(
			match.view,
			"Configured credential",
			{ value: secret.value, index: match.index, name: secret.source },
			secret.source,
		);
	}

	return findings;
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
	return scanShareSecretViews(shareUploadScanViews(uploadedContent), options);
}

/** A confirm dialog is a decision, not a report: list the first few and count the rest. */
const MAX_LISTED_FINDINGS = 8;

/**
 * The confirm dialog: one line per credential with its shape, the non-secret name it was
 * assigned from, its position in the scanned text and a front/back mask, plus what the
 * upload would actually carry and what cancelling means.
 */
export function formatShareSecretWarning(findings: readonly ShareSecretFinding[]): { title: string; message: string } {
	const listed = findings
		.slice(0, MAX_LISTED_FINDINGS)
		.map(
			(finding) =>
				`- ${finding.type}${finding.name ? ` ${finding.name}` : ""} — ${finding.view}, ${finding.masked} at line ${finding.line} (offset ${finding.offset})`,
		);
	if (findings.length > MAX_LISTED_FINDINGS) {
		listed.push(`- ...and ${findings.length - MAX_LISTED_FINDINGS} more`);
	}
	return {
		title: "Share session",
		message:
			`This session looks like it contains secrets:\n${listed.join("\n")}\n\n` +
			"Nothing is uploaded yet: cancel and the session is not shared.\n" +
			"/share uploads the exported session (messages, system prompt, tools, and the\n" +
			"working-directory context the exporter adds) as a private GitHub gist, and a secret\n" +
			"gist is readable by anyone who has the link.\n\n" +
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
	if (findings.length === 0) {
		return true;
	}
	const warning = formatShareSecretWarning(findings);
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
