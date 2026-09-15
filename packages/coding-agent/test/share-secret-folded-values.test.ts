import { describe, expect, it } from "vitest";
import type { ShareSecretValue } from "../src/core/share-secret-values.js";
import {
	findShareSecretFindings,
	findShareUploadSecretFindings,
	redactShareSecrets,
} from "../src/core/share-session.js";

/**
 * QW-R1 fold: a configured credential whose value a terminal wrapped (or a copy-paste
 * re-wrapped) reaches the upload as two halves with a `\n` or `\r\n` inside the value.
 * The exact comparison is the check no unknown shape can slip past, so a value it cannot
 * see is a live key leaving the machine with the preflight green.
 */

/** No prefix, no structure: only the exact comparison can ever see it. */
const FOLD_VALUE = "zQ4vN8pR2mL6xT1wK7yB3cF5dH9jS0aG4eZ5uJ2";
const FOLD_SECRET: ShareSecretValue = { value: FOLD_VALUE, source: "models.json (dashscope.apiKey)" };
const SECRETS = { secretValues: [FOLD_SECRET] } as const;

/** Fold the value at `at`, wrapping with the separator real terminals emit. */
function fold(value: string, at: number, separator: string): string {
	return `${value.slice(0, at)}${separator}${value.slice(at)}`;
}

/** The uploaded artifact of the production shape: session content base64 inside the document. */
function shareDocument(payloadText: string): string {
	const payload = JSON.stringify({
		header: { version: 1 },
		entries: [{ type: "message", message: { role: "user", content: payloadText } }],
	});
	return `<html><body><script id="session-data" type="application/json">${Buffer.from(payload).toString("base64")}</script></body></html>`;
}

describe("a line-wrapped configured value is still compared exactly (QW-R1 fold)", () => {
	it("catches a value a terminal wrapped with a newline in the middle", () => {
		const content = `the runner printed ${fold(FOLD_VALUE, 12, "\n")} into its log`;
		const findings = findShareSecretFindings(content, SECRETS);
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
		expect(findings.some((finding) => finding.name === "models.json (dashscope.apiKey)")).toBe(true);
		// The report still never carries the value, in either half.
		expect(JSON.stringify(findings)).not.toContain(FOLD_VALUE.slice(0, 16));
		expect(JSON.stringify(findings)).not.toContain(FOLD_VALUE.slice(-16));
	});

	it("catches a value wrapped with CRLF, twice", () => {
		const content = fold(fold(FOLD_VALUE, 20, "\r\n"), 31, "\r\n");
		const findings = findShareSecretFindings(content, SECRETS);
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
	});

	it("catches a wrapped value inside the exported payload, where the wrap is a JSON escape", () => {
		// `shareDocument` stringifies the content, so the fold's real newline travels as a
		// `\n` escape inside the payload: the unescaped scan view is where the folded halves
		// become one run of text again.
		const html = shareDocument(`wrapped key: ${fold(FOLD_VALUE, 12, "\n")} end`);
		const findings = findShareUploadSecretFindings(html, SECRETS);
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
		expect(findings.every((finding) => finding.view.includes("payload"))).toBe(true);
	});

	it("redacts the whole wrapped span, newline included, from a trace upload body", () => {
		const content = `before ${fold(FOLD_VALUE, 12, "\n")} after`;
		const redaction = redactShareSecrets(content, SECRETS);
		expect(redaction.count).toBe(1);
		expect(redaction.text).toContain("***redacted***");
		// Both halves of the value are gone; only the marker spans the fold.
		expect(redaction.text).not.toContain(FOLD_VALUE.slice(0, 12));
		expect(redaction.text).not.toContain(FOLD_VALUE.slice(12));
	});

	it("stays silent when the configured value is not in the text", () => {
		const findings = findShareSecretFindings("the runner printed nothing interesting", SECRETS);
		expect(findings).toEqual([]);
	});
});

describe("known boundaries the fold fix does not cover (documented misses, QW-R1)", () => {
	it("KNOWN MISS: a value re-encoded beyond the compared forms (percent, base64) is not caught", () => {
		// Hex HTML entities re-encode every character of the value. The comparison covers the
		// raw, percent-encoded and base64 forms only; anything else is a documented boundary:
		// this test asserts the miss so nobody mistakes the preflight for covering it.
		const entityEncoded = [...FOLD_VALUE].map((char) => `&#x${char.codePointAt(0)!.toString(16)};`).join("");
		const findings = findShareSecretFindings(`the runner printed ${entityEncoded} into its log`, SECRETS);
		expect(findings).toEqual([]);
	});

	it("KNOWN MISS: a shapeless value nobody configured is not caught", () => {
		// A foreign credential (somebody else's project, pasted into the chat with no
		// credential name in front of it): no session value to compare against and no shape
		// to recognize, so both halves of the check are blind to it. Only values this
		// session loaded can be compared exactly; with an anchor in front (`their key:`)
		// the entropy detector would catch it, which is why this text carries none.
		const foreignValue = "wK9mX2vR5tL8bQ4nY7cJ1fH6gD3sP0aUeZ5iO2rT";
		const findings = findShareSecretFindings(`the runner printed ${foreignValue} into its log`, {
			secretValues: [],
		});
		expect(findings).toEqual([]);
	});
});
