import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const templateJs = read("../src/core/export-html/template.js");
const markedJs = read("../src/core/export-html/vendor/marked.min.js");
const hljsJs = read("../src/core/export-html/vendor/highlight.min.js");

const PLACEHOLDERS = [
	"{{CSS}}",
	"{{JS}}",
	"{{SESSION_DATA}}",
	"{{MARKED_JS}}",
	"{{HIGHLIGHT_JS}}",
	"{{THEME_VARS}}",
	"{{BODY_BG}}",
	"{{CONTAINER_BG}}",
	"{{INFO_BG}}",
];

const DOLLAR_CONTENT = "dollar patterns: $& $' $` $$ $1";

interface DecodedSessionData {
	entries?: Array<{ type: string; message?: { content?: unknown } }>;
}

function collectMessageTexts(sessionData: DecodedSessionData): string[] {
	const texts: string[] = [];
	for (const entry of sessionData.entries ?? []) {
		if (entry.type !== "message" || !entry.message) continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			texts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
					texts.push(block.text);
				}
			}
		}
	}
	return texts;
}

describe("export HTML $-pattern embedding integrity", () => {
	it("embedded assets contain $ sequences that are hazardous to string replacement", () => {
		// Guards the export assertions below: if these sequences ever disappear from
		// the assets, the verbatim-embedding checks would silently prove nothing.
		expect(templateJs).toContain("$${totalCost.toFixed(3)}");
		expect(hljsJs).toContain("$&");
		expect(hljsJs).toContain("$$");
	});

	it("embeds all assets verbatim and round-trips $-pattern session content", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "prime-export-dollar-"));
		try {
			const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
			manager.appendMessage({ role: "user", content: DOLLAR_CONTENT, timestamp: Date.now() });
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing test session file");
			const output = join(tempRoot, "session.html");
			await exportFromFile(sessionFile, output);
			const html = readFileSync(output, "utf8");

			// With string-pattern replacement, `$` sequences inside the replacement
			// strings get expanded: `$$` in the template.js cost display collapses to
			// `$`, `$&` in an hljs operator grammar becomes the literal placeholder
			// text, and `$$` in an hljs interpolation grammar loses its literal `$`.
			expect(html).toContain(templateJs);
			expect(html).toContain(markedJs);
			expect(html).toContain(hljsJs);
			expect(html).toContain("$${totalCost.toFixed(3)}");

			expect(PLACEHOLDERS.length).toBe(9);
			for (const placeholder of PLACEHOLDERS) {
				expect(html).not.toContain(placeholder);
			}

			// Session content containing $&, $', $` must survive the base64 blob byte-exact.
			const blob = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
			if (!blob) throw new Error("session-data script blob not found in export");
			const decoded = JSON.parse(Buffer.from(blob[1], "base64").toString("utf-8")) as DecodedSessionData;
			const texts = collectMessageTexts(decoded);
			expect(texts.length).toBeGreaterThan(0);
			expect(texts).toContain(DOLLAR_CONTENT);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
