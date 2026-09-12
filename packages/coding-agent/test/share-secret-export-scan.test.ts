import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { decodeEmbeddedSessionData } from "../src/core/export-html/session-data-embedding.js";
import { SessionManager } from "../src/core/session-manager.js";
import { confirmShareIfSecrets, findShareSecretHits, findShareUploadSecretHits } from "../src/core/share-session.js";

const SECRETS = {
	openai: "sk-LIVEKEY1234567890abcdef",
	aws: "AKIAIOSFODNN7EXAMPLE",
	github: "ghp_abcdefghijklmnopqrstuvwxyz1234",
	bearer: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	pem: "-----BEGIN RSA PRIVATE KEY-----",
} as const;

const SECRET_TEXT = [SECRETS.openai, SECRETS.aws, SECRETS.github, SECRETS.bearer, SECRETS.pem].join("\n");

/**
 * Export a real session whose user message carries every secret shape the preflight
 * knows, through the production exporter (no mocks): the uploaded artifact is the
 * HTML file, and the session reaches it only as base64 inside <script id="session-data">.
 */
async function exportSessionWithSecrets(text: string): Promise<{ html: string; cleanup: () => void }> {
	const tempRoot = mkdtempSync(join(tmpdir(), "prime-share-scan-"));
	const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	manager.flushNow();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Missing test session file");
	const output = join(tempRoot, "session.html");
	await exportFromFile(sessionFile, output);
	const html = readFileSync(output, "utf8");
	return { html, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
}

describe("share preflight scans the exported session payload", () => {
	it("recovers the plaintext session from an exported document", async () => {
		const { html, cleanup } = await exportSessionWithSecrets(SECRET_TEXT);
		try {
			// The document itself carries no plaintext secret: this is the shape that made
			// a scan of the uploaded bytes alone always miss.
			expect(html).not.toContain(SECRETS.openai);
			expect(findShareSecretHits(html)).toEqual([]);

			const decoded = decodeEmbeddedSessionData(html);
			expect(decoded).toBeDefined();
			expect(decoded).toContain(SECRETS.openai);

			// Inside the payload the line separators are JSON escapes, so the `\b` anchored
			// shapes that follow a `\n` are only visible once those escapes are resolved:
			// a plain scan of the decoded text sees the first key and the unanchored PEM
			// header, and nothing else.
			expect(findShareSecretHits(decoded ?? "")).toEqual(["API key (sk-)", "PEM private key"]);
			expect(findShareUploadSecretHits(html)).toEqual([
				"API key (sk-)",
				"AWS access key (AKIA)",
				"GitHub token (ghp_)",
				"Bearer token",
				"PEM private key",
			]);
		} finally {
			cleanup();
		}
	});

	it("warns before uploading a session that carries secrets in the export payload", async () => {
		const { html, cleanup } = await exportSessionWithSecrets(SECRET_TEXT);
		try {
			const confirm = vi.fn(async (_title: string, message: string) => {
				expect(message).toContain("API key (sk-)");
				expect(message).toContain("AWS access key (AKIA)");
				expect(message).toContain("GitHub token (ghp_)");
				expect(message).toContain("Bearer token");
				expect(message).toContain("PEM private key");
				for (const secret of Object.values(SECRETS)) {
					expect(message).not.toContain(secret);
				}
				return false;
			});

			await expect(confirmShareIfSecrets(html, confirm)).resolves.toBe(false);
			expect(confirm).toHaveBeenCalledOnce();
		} finally {
			cleanup();
		}
	});

	it("still catches a plaintext secret outside the embedded payload", async () => {
		const { html, cleanup } = await exportSessionWithSecrets("nothing to see here");
		try {
			const withPlaintextFooter = `${html}\n<!-- cwd: /work env: ${SECRETS.openai} -->\n`;
			expect(findShareUploadSecretHits(withPlaintextFooter)).toEqual(["API key (sk-)"]);
		} finally {
			cleanup();
		}
	});

	it("does not warn for a clean session export", async () => {
		const { html, cleanup } = await exportSessionWithSecrets("hello, how are you today?");
		try {
			const confirm = vi.fn(async () => false);
			await expect(confirmShareIfSecrets(html, confirm)).resolves.toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("treats a document without the embedded payload as plaintext-only", () => {
		expect(decodeEmbeddedSessionData("<html><body>no session data here</body></html>")).toBeUndefined();
		expect(findShareUploadSecretHits(`<pre>${SECRETS.aws}</pre>`)).toEqual(["AWS access key (AKIA)"]);
	});

	it("decodes a payload written by a hand-rolled exporter that keeps the same container", () => {
		const payload = JSON.stringify({ entries: [{ secret: SECRETS.github }] });
		const document = `<script id="session-data" type="application/json">${Buffer.from(payload).toString(
			"base64",
		)}</script>`;
		expect(decodeEmbeddedSessionData(document)).toBe(payload);
	});

	it("survives a corrupt payload instead of throwing away the scan", () => {
		const document = `<script id="session-data" type="application/json">!!!!not base64!!!!</script>
${SECRETS.openai}`;
		expect(() => findShareUploadSecretHits(document)).not.toThrow();
		expect(findShareUploadSecretHits(document)).toEqual(["API key (sk-)"]);
	});
});
