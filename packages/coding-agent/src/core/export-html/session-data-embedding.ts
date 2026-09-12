/**
 * Container format for the session payload embedded in an exported HTML document.
 *
 * The export hides every message, tool result, system prompt and tool definition
 * inside one base64 blob, so the uploaded file contains no plaintext session
 * content. Both sides of that container live here: the exporter encodes through
 * it, and the /share secret preflight decodes through it, because a preflight
 * that only reads the uploaded bytes as text would scan an encoding of the
 * session rather than the session.
 */

/** Element id the viewer script reads the payload from. */
export const SESSION_DATA_ELEMENT_ID = "session-data";

const SESSION_DATA_SCRIPT_PATTERN = new RegExp(
	`<script[^>]*\\bid=["']?${SESSION_DATA_ELEMENT_ID}["']?[^>]*>([\\s\\S]*?)</script>`,
	"i",
);

/** Encode a session payload for embedding in the export document. */
export function encodeEmbeddedSessionData(sessionData: unknown): string {
	return Buffer.from(JSON.stringify(sessionData)).toString("base64");
}

/**
 * Recover the plaintext session payload from an exported document. Returns
 * undefined when the document carries no such script element; never throws on a
 * malformed payload, because the caller still has the rest of the document to scan.
 */
export function decodeEmbeddedSessionData(document: string): string | undefined {
	const match = SESSION_DATA_SCRIPT_PATTERN.exec(document);
	const encoded = match?.[1]?.trim();
	if (!encoded) {
		return undefined;
	}
	try {
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		return decoded.length > 0 ? decoded : undefined;
	} catch {
		return undefined;
	}
}
