import { describe, expect, it, vi } from "vitest";
import { confirmShareIfSecrets } from "../src/core/share-session.js";

/**
 * Round-27 SEC-5: the HTML export embeds the entire session — header cwd, usernames,
 * email addresses — as one base64 blob, so a plain-text glance at the file shows
 * nothing, and the /share preflight scanned only credential shapes. Sharing is the
 * user's decision, so a hit is a warning plus an explicit confirmation, never a
 * block. The payloads below mirror the production shape: the session travels
 * base64-encoded inside `<script id="session-data">`.
 */

const PURE_CODE = [
	"function add(a, b) {",
	"  return a + b;",
	"}",
	"import { readFileSync } from 'node:fs';",
	"const config = JSON.parse(readFileSync('config.json', 'utf-8'));",
	"if (config.debug) console.log('src/index.ts loaded');",
].join("\n");

/** An uploaded artifact of the production shape: session content base64 inside the document. */
function shareDocument(payloadText: string, cwd?: string): string {
	const payload = JSON.stringify({
		header: { version: 1, ...(cwd !== undefined ? { cwd } : {}) },
		entries: [{ type: "message", message: { role: "user", content: payloadText } }],
	});
	return `<html><body><script id="session-data" type="application/json">${Buffer.from(payload).toString("base64")}</script></body></html>`;
}

async function confirmWithMessage(html: string, answer: boolean) {
	const messages: string[] = [];
	const confirm = vi.fn(async (_title: string, message: string) => {
		messages.push(message);
		return answer;
	});
	const result = await confirmShareIfSecrets(html, confirm);
	return { result, confirm, messages };
}

describe("/share preflight flags identity data embedded in the export", () => {
	it("warns and asks for confirmation when the payload carries the session cwd", async () => {
		const html = shareDocument("please review my project", "/Users/alice/projects/app");
		const { result, confirm, messages } = await confirmWithMessage(html, false);

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result).toBe(false);
		const message = messages[0];
		expect(message).toContain("identifies you");
		// The username is the identity signal, so the warning names the root it sits under.
		expect(message).toContain("/Users/alice");
		expect(message).toContain("session payload");
		expect(message).toContain("Upload anyway?");
	});

	it("counts the home-directory paths a real export carries", async () => {
		const html = shareDocument(
			"ran `ls /Users/alice/Desktop` and `/Users/alice/Documents/report.md`\nalso saw /home/bob/shared/data",
			"/Users/alice/projects/app",
		);
		const { messages } = await confirmWithMessage(html, false);

		const message = messages[0];
		// One finding per home root: three paths under /Users/alice (two quoted in the
		// message plus the header cwd), one under /home/bob.
		expect(message).toContain("3 occurrences");
		expect(message).toContain("1 occurrence");
		expect(message).toContain("/Users/alice");
		expect(message).toContain("/home/bob");
	});

	it("warns on email-shaped identity data in the payload", async () => {
		const html = shareDocument("my contact is alice@example.com, reply there");
		const { confirm, result, messages } = await confirmWithMessage(html, false);

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(result).toBe(false);
		expect(messages[0]).toContain("Email address");
		// The address itself stays masked in the warning text.
		expect(messages[0]).not.toContain("alice@example.com");
	});

	it("keeps the full mask discipline when secrets and identity data are both present", async () => {
		const key =
			"sk-ws-H.ELM7q2Zk1Vx9Rt4Bn6Pw8Yc3Uf5Jd0Sg2Ae7Hm1Lq4Zb6Xr8Nv3Tx5Cd9Kf2Wp7Ya4Rg6Bj1Qe8Hz3Mn5Uv0Tb2Ls7Fd";
		const html = shareDocument(`DASHSCOPE_API_KEY=${key}\ncwd was /Users/alice/projects/app`, "/Users/alice/app");

		const { messages } = await confirmWithMessage(html, false);
		const message = messages[0];
		expect(message).toContain("looks like it contains secrets");
		expect(message).toContain("API key (sk-)");
		expect(message).toContain("identifies you");
		expect(message).toContain("/Users/alice");
		expect(message).not.toContain(key);
	});
});

describe("/share preflight does not flag a code-only session (positive control)", () => {
	it("uploads a pure-code session without a confirmation dialog", async () => {
		const html = shareDocument(PURE_CODE);
		const { result, confirm } = await confirmWithMessage(html, false);

		expect(result).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("does not mistake repository-relative paths for identity data", async () => {
		const html = shareDocument("edit packages/coding-agent/src/core/share-session.ts, then run the suite");
		const { result, confirm } = await confirmWithMessage(html, false);

		expect(result).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});
});
