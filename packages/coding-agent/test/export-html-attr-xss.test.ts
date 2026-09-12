import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

/**
 * Extract the escapeHtml function from the export template (or from an exported
 * HTML document with the template embedded) and evaluate it. The escaper is pure
 * string manipulation, so it runs without a DOM.
 */
function loadEscapeHtml(source: string): (text: unknown) => string {
	const match = source.match(/function escapeHtml\(text\) \{[\s\S]*?\n {6}\}/);
	if (!match) throw new Error("escapeHtml function not found in template source");
	const factory = new Function(`${match[0]}\nreturn escapeHtml;`);
	return factory() as (text: unknown) => string;
}

describe("export HTML attribute-injection escaping", () => {
	it("escapes quotes with the same entity set as the ansi-to-html.ts escaper", () => {
		const escapeHtml = loadEscapeHtml(templateJs);
		expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#039;");
	});

	it("neutralizes a double-quote attribute breakout payload", () => {
		const escapeHtml = loadEscapeHtml(templateJs);
		const payload = `" onmouseover="alert(1)`;
		const escaped = escapeHtml(payload);
		expect(escaped).toBe("&quot; onmouseover=&quot;alert(1)");
		// Mirrors template.js `data-entry-id="${escapeHtml(entryId)}"` interpolation:
		// the only raw quotes left are the attribute delimiters.
		const button = `<button class="copy-link-btn" data-entry-id="${escaped}">`;
		expect(button.match(/"/g)).toHaveLength(4);
		expect(button).not.toContain(' onmouseover="');
	});

	it("neutralizes a single-quote attribute breakout payload", () => {
		const escapeHtml = loadEscapeHtml(templateJs);
		expect(escapeHtml("' onfocus='alert(1)")).toBe("&#039; onfocus=&#039;alert(1)");
	});

	it("neutralizes a payload breaking out of an img src data attribute", () => {
		const escapeHtml = loadEscapeHtml(templateJs);
		const mime = `image/png" onerror="alert(1)`;
		// Mirrors template.js `<img src="data:${escapeHtml(mime)};base64,${escapeHtml(data)}" ...>`.
		const img = `<img src="data:${escapeHtml(mime)};base64,${escapeHtml("QUJD")}=" class="tool-image" />`;
		expect(img.match(/"/g)).toHaveLength(4);
		expect(img).not.toContain('onerror="');
	});

	it("preserves the DOM escaper's null/undefined rendering", () => {
		const escapeHtml = loadEscapeHtml(templateJs);
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("undefined");
	});

	it("exports a malicious session with the payload confined to the base64 blob", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "prime-export-attr-xss-"));
		try {
			const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
			const payload = `" onmouseover="alert(1)`;
			manager.appendMessage({ role: "user", content: payload, timestamp: Date.now() });
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing test session file");
			const output = join(tempRoot, "session.html");
			await exportFromFile(sessionFile, output);
			const html = readFileSync(output, "utf8");

			// Session content reaches the document only through the base64 blob.
			expect(html).not.toContain(payload);

			// The escaper shipped inside the export neutralizes the payload at render time.
			const escapeHtml = loadEscapeHtml(html);
			const div = `<div class="user-message" id="entry-${escapeHtml(payload)}">`;
			expect(div.match(/"/g)).toHaveLength(4);
			expect(div).toContain("&quot; onmouseover=&quot;");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
