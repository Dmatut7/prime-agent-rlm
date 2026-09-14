import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ShareSecretValue } from "../src/core/share-secret-values.js";
import { collectConfiguredShareSecretValues } from "../src/core/share-secret-values.js";
import {
	confirmShareIfSecrets,
	findShareUploadSecretFindings,
	findShareUploadSecretHits,
	formatShareSecretWarning,
} from "../src/core/share-session.js";

/**
 * Real shapes, not invented ones. The audit that produced this file ran the shipped
 * preflight against the credentials this machine actually holds:
 *
 * - the bailian/DashScope key is `sk-ws-` plus 110 characters that contain dots, so the
 *   shipped `\bsk-[A-Za-z0-9_-]{8,}` stopped at the first dot after four characters and
 *   never reached its own length floor;
 * - the grok credential resolved from `~/.grok/auth.json` is an 882-character JWT;
 * - a `ps eww` dump captured in a real transcript carries `DASHSCOPE_API_KEY=<value>`,
 *   a shape no prefix table lists;
 *
 * `/share` uploads to `gh gist create --public=false`, and a secret gist is readable by
 * anyone holding the link, so a miss here is a live key leaving the machine.
 */

/** Shape of the live key: prefix, then a dot inside the first few characters, then 110 more. */
const DASHSCOPE_KEY = `sk-ws-H.ELM7q2Zk1Vx9Rt4Bn6Pw8Yc3Uf5Jd0Sg2Ae7Hm1Lq4Zb6Xr8Nv3Tx5Cd9Kf2Wp7Ya4Rg6Bj1Qe8Hz3Mn5Uv0Tb2Ls7Fd`;
const JSON_HEADER = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6ImExYjJjM2Q0In0";
const JWT_PAYLOAD =
	"eyJpc3MiOiJodHRwczovL2F1dGgueC5haSIsInN1YiI6InVzZXItOWY4ZTdkNmM1YjRhMzIxMCIsImF1ZCI6Imdyb2stY2xpIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjE3OTAwMDAwMDB9";
const LONG_JWT = `${JSON_HEADER}.${JWT_PAYLOAD}.${"R2x5Y0ZhbHNlU2lnbmF0dXJlVmFsdWVGb3JUZXN0aW5nT25seQ".repeat(7)}`;
/** A value with no prefix, no structure and no recognizable shape at all. */
const SHAPELESS_VALUE = "zQ4vN8pR2mL6xT1wK7yB3cF5dH9jS0aG4eZ5uJ2";
const AUTH_JSON_VALUE = "Nq7Ls2Xv9Td4Gm1Rp6Kw3Bz8Yc5Hj0Ua2Fe7Iu4On1";
const MCP_TOKEN_VALUE = "Rt3Wm8Zx2Qp7Lv1Kd5Bn9Yc4Hs6Ju0Ae2Gf7Io3Ur8";
const ENV_ASSIGNMENT = `DASHSCOPE_API_KEY=${DASHSCOPE_KEY}`;

/** An uploaded artifact of the production shape: session content base64 inside the document. */
function shareDocument(payloadText: string): string {
	const payload = JSON.stringify({
		header: { version: 1 },
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

describe("share preflight covers the credential shapes a real session carries", () => {
	it("flags the live sk-ws-… key shape, which the shipped prefix pattern never reached", () => {
		const html = shareDocument(`DASHSCOPE_API_KEY=${DASHSCOPE_KEY}`);

		// The document itself carries no plaintext key: the session is base64 inside it.
		expect(html).not.toContain(DASHSCOPE_KEY);
		expect(findShareUploadSecretHits(html)).toContain("API key (sk-)");
	});

	it("flags a long JWT, a shape no prefix table lists", () => {
		// The shape `~/.grok/auth.json` holds: a bare 882-character three-segment token.
		const html = shareDocument(`X-XAI-Token-Auth: ${LONG_JWT}`);
		const types = findShareUploadSecretHits(html);
		expect(types).toContain("JWT (three base64url segments)");
		// The value must not be reachable from the warning text either.
		expect(types.join(" ")).not.toContain(LONG_JWT.slice(0, 24));
	});

	it("flags credential-name assignment shapes, the `ps eww` dump case", () => {
		// Values with no prefix and no structure: the name in front of them is the only clue.
		const shapeFree = new Map<string, string>([
			["GITHUB_TOKEN", `GITHUB_TOKEN=${SHAPELESS_VALUE}`],
			["MYSQL_PASSWORD", "MYSQL_PASSWORD=hunter2secretvalue"],
			["CLIENT_SECRET", `CLIENT_SECRET: "${SHAPELESS_VALUE}"`],
			["EXA_API_KEY", `"EXA_API_KEY": "${SHAPELESS_VALUE}"`],
		]);
		expect(shapeFree.size).toBeGreaterThan(0);

		for (const [name, text] of shapeFree) {
			const findings = findShareUploadSecretFindings(shareDocument(text));
			expect(findings.map((finding) => finding.type).join(" ")).toContain("assignment");
			// The name is not a secret, so the finding may name it; the value may not appear.
			expect(findings.some((finding) => finding.name === name)).toBe(true);
			expect(JSON.stringify(findings)).not.toContain(SHAPELESS_VALUE);
		}
	});

	it("still names the variable a shape-known key was assigned from", () => {
		// The prefix detector labels the shape first; the assignment detector knows the name.
		const findings = findShareUploadSecretFindings(shareDocument(ENV_ASSIGNMENT));
		const named = findings.filter((finding) => finding.name === "DASHSCOPE_API_KEY");
		expect(named).toHaveLength(1);
		expect(named[0]?.type).toBe("API key (sk-)");
		expect(JSON.stringify(findings)).not.toContain(DASHSCOPE_KEY);
	});
});

describe("share preflight reports shape and position, never the value", () => {
	it("warns with the shape, the location and a front/back mask", async () => {
		const html = shareDocument(`line one\nline two\n${ENV_ASSIGNMENT}`);
		const { result, messages } = await confirmWithMessage(html, false);

		expect(result).toBe(false);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		expect(message).toContain("looks like it contains secrets");
		expect(message).toContain("API key (sk-)");
		expect(message).toMatch(/line \d+/);
		expect(message).toMatch(/offset \d+/);
		// Front/back mask only: a preview is present, the value is not.
		expect(message).toMatch(/sk-w….{0,4}/);
		expect(message).not.toContain(DASHSCOPE_KEY);
		expect(message).not.toContain(SHAPELESS_VALUE);
		// Long values are still not recoverable from the mask.
		for (const slice of [DASHSCOPE_KEY.slice(4, -4), DASHSCOPE_KEY.slice(10, 40)]) {
			expect(message).not.toContain(slice);
		}
	});

	it("says the session is not shared unless the user confirms", async () => {
		const { messages } = await confirmWithMessage(shareDocument(ENV_ASSIGNMENT), false);
		expect(messages[0]).toContain("not shared");
		expect(messages[0]).toContain("exported session");
	});

	it("does not prompt when the session carries no credential", async () => {
		const confirm = vi.fn(async () => false);
		await expect(confirmShareIfSecrets(shareDocument("hello, how are you today?"), confirm)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("formats a warning from findings without inventing values", () => {
		const warning = formatShareSecretWarning([
			{
				type: "API key (sk-)",
				view: "the exported session payload",
				offset: 42,
				line: 3,
				masked: "sk-w…0b2L",
			},
		]);
		expect(warning.title).toBe("Share session");
		expect(warning.message).toContain("- API key (sk-)");
		expect(warning.message).toContain("offset 42");
		expect(warning.message).toContain("line 3");
		expect(warning.message).toContain("tools");
		expect(warning.message).toContain("working-directory context");
	});
});

describe("credentials loaded by this session are treated as secrets regardless of shape", () => {
	function withAgentDir(run: (agentDir: string) => void): void {
		const root = mkdtempSync(join(tmpdir(), "prime-share-values-"));
		try {
			mkdirSync(join(root, "agent"), { recursive: true, mode: 0o700 });
			run(join(root, "agent"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("collects environment, auth.json (including `!cat` commands), models.json and settings.json values", () => {
		withAgentDir((agentDir) => {
			const secretFile = join(agentDir, "bailian.key");
			writeFileSync(secretFile, `${AUTH_JSON_VALUE}\n`, { mode: 0o600 });
			writeFileSync(
				join(agentDir, "auth.json"),
				JSON.stringify({ bailian: { type: "api_key", key: `!cat ${secretFile}` } }),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({ providers: { dashscope: { apiKey: SHAPELESS_VALUE } } }),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ mcpServers: { exa: { headers: { "x-api-key": MCP_TOKEN_VALUE } } } }),
				{ mode: 0o600 },
			);

			const collected = collectConfiguredShareSecretValues({
				agentDir,
				env: { DASHSCOPE_API_KEY: DASHSCOPE_KEY, MYSQL_PASSWORD: "password", EDITOR: "vim" },
				argv: [],
			});
			const values = collected.map((entry) => entry.value);
			const sources = collected.map((entry) => entry.source).join(" | ");
			expect(values).toContain(DASHSCOPE_KEY);
			expect(values).toContain(SHAPELESS_VALUE);
			// `!cat` config commands are resolved to the credential they print, not collected raw.
			expect(values).toContain(AUTH_JSON_VALUE);
			expect(values).toContain(MCP_TOKEN_VALUE);
			expect(sources).toContain("env DASHSCOPE_API_KEY");
			expect(sources).toContain("auth.json");
			expect(sources).toContain("models.json");
			expect(sources).toContain("settings.json");
			// Placeholders and non-credential environment are not secrets.
			expect(values).not.toContain("password");
			expect(values).not.toContain("vim");
			expect(sources).not.toContain("!cat");
		});
	});

	it("takes the value from a --api-key runtime override", () => {
		const collected = collectConfiguredShareSecretValues({
			agentDir: mkdtempSync(join(tmpdir(), "prime-share-argv-")),
			env: {},
			argv: ["node", "prime-agent", "--api-key", SHAPELESS_VALUE],
		});
		expect(collected).toEqual([{ value: SHAPELESS_VALUE, source: "cli --api-key" }]);
	});

	it("blocks a share of a value that has no recognizable shape at all", async () => {
		const html = shareDocument(`the runner printed ${SHAPELESS_VALUE} into its log`);
		// Shape scanning alone cannot see this, which is the whole point of the comparison.
		expect(findShareUploadSecretHits(html)).toEqual([]);

		const secretValues: ShareSecretValue[] = [{ value: SHAPELESS_VALUE, source: "models.json (dashscope.apiKey)" }];
		const messages: string[] = [];
		const confirm = vi.fn(async (_title: string, message: string) => {
			messages.push(message);
			return false;
		});
		await expect(confirmShareIfSecrets(html, confirm, { secretValues })).resolves.toBe(false);
		expect(messages[0]).toContain("Configured credential");
		expect(messages[0]).toContain("models.json (dashscope.apiKey)");
		expect(messages[0]).not.toContain(SHAPELESS_VALUE);
	});

	it("stays silent when no configured value appears in the export", async () => {
		const html = shareDocument("the runner printed nothing interesting");
		const confirm = vi.fn(async () => false);
		const secretValues: ShareSecretValue[] = [{ value: SHAPELESS_VALUE, source: "models.json" }];
		await expect(confirmShareIfSecrets(html, confirm, { secretValues })).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("loaded credentials are compared whatever their shape (ADV-2)", () => {
	/** Loaded values are compared verbatim, so a credential's shape cannot hide it from the check. */
	function collectedFromEnv(env: Record<string, string>): ShareSecretValue[] {
		return collectConfiguredShareSecretValues({ agentDir: "/nonexistent-agent-dir", env, argv: [] });
	}

	/** All-digit credentials exist (older IoT/vendor keys). */
	const DIGIT_KEY = "39284756102394857610";
	/** A slug someone generated rather than wrote: lower case, digits-free, under the length floor. */
	const SLUG_KEY = "payment-gateway-webhook-signing";
	/** An AWS-style secret with two slashes, the shape that reads as a path. */
	const SLASH_KEY = "fAkE9xQ2mZ7pL4wR/tY8uI3oP6sD1fG/hJ5kLzXcVb";

	it("compares an all-digit credential loaded by this session", () => {
		const collected = collectedFromEnv({ NUMERIC_PROVIDER_KEY: DIGIT_KEY });
		expect(collected.map((entry) => entry.value)).toContain(DIGIT_KEY);

		const findings = findShareUploadSecretFindings(shareDocument(`the key is ${DIGIT_KEY} ok`), {
			secretValues: collected,
		});
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
		expect(JSON.stringify(findings)).not.toContain(DIGIT_KEY);
	});

	it("compares a lowercase slug credential loaded by this session", () => {
		const collected = collectedFromEnv({ WEBHOOK_SECRET: SLUG_KEY });
		expect(collected.map((entry) => entry.value)).toContain(SLUG_KEY);

		const findings = findShareUploadSecretFindings(shareDocument(`secret: ${SLUG_KEY}`), {
			secretValues: collected,
		});
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
	});

	it("compares a slash-heavy secret loaded by this session", () => {
		const collected = collectedFromEnv({ CUSTOMER_API_KEY: SLASH_KEY });
		expect(collected.map((entry) => entry.value)).toContain(SLASH_KEY);

		const findings = findShareUploadSecretFindings(shareDocument(`token is ${SLASH_KEY} ok`), {
			secretValues: collected,
		});
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
	});

	it("flags a bare slash-heavy secret that no session loaded", () => {
		// Read out of somebody else's project and pasted into the chat: no session value to
		// compare against, so only the shape scan can see it - and it must not read as a path.
		const findings = findShareUploadSecretFindings(shareDocument(`customer pasted their key: ${SLASH_KEY}`), {
			secretValues: [],
		});
		expect(findings.length).toBeGreaterThan(0);
		expect(JSON.stringify(findings)).not.toContain(SLASH_KEY);
	});

	it("collects a passphrase-named credential", () => {
		const collected = collectedFromEnv({ BACKUP_PASSPHRASE: "correct horse battery staple" });
		expect(collected.map((entry) => entry.value)).toContain("correct horse battery staple");

		const findings = findShareUploadSecretFindings(shareDocument("passphrase is correct horse battery staple ok"), {
			secretValues: collected,
		});
		expect(findings.map((finding) => finding.type)).toContain("Configured credential");
	});

	it("keeps a value too short to be a credential out of the report but not out of the set", () => {
		// `KEY=1` type values are compared (nothing loaded is dropped) and not reported: a
		// one-character value is inside almost any export, and a warning on every share is a
		// warning nobody reads.
		const collected = collectedFromEnv({ SERVICE_KEY: "1" });
		expect(collected.map((entry) => entry.value)).toContain("1");

		const findings = findShareUploadSecretFindings(shareDocument("const answer = 1;"), {
			secretValues: collected,
		});
		expect(findings).toEqual([]);
	});

	it("keeps a location-valued credential in the comparison set without reporting it on its own", () => {
		// `GOOGLE_APPLICATION_CREDENTIALS` holds a path, and that path is all over an ordinary
		// transcript. It stays in the compared set (a loaded value is never dropped) but is not
		// reported by the exact comparison, so a share does not warn about a file name.
		const path = "/etc/gcp/service-account.json";
		const collected = collectedFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: path });
		expect(collected.map((entry) => entry.value)).toContain(path);

		const findings = findShareUploadSecretFindings(shareDocument(`read ${path} first`), {
			secretValues: collected,
		});
		expect(findings).toEqual([]);
	});
});

describe("share preflight false positives stay under control", () => {
	it("does not flag hashes, UUIDs, paths, identifiers or encapsulated blobs", () => {
		const clean = [
			"commit 3f2a1b9c8d7e6f504132537495867890abcdef12 fixed the encoder",
			"session 01a09ee1-d584-7027-a016-d4df41b14ce4 resumed",
			"read /tmp/prime-agent/packages/coding-agent/src/core/share-session.ts",
			"dumped /data/app/~~TX-DBmZa9KQk3Lm2Pq8Rw==/base.apk",
			"const DEFAULT_MAX_ACTIVITY_BUDGET_FOR_LONG_RUNNING_OPERATIONS = 24.0;",
			`"encrypted_content": "${"J9xQmT4vLpR8sKd2WnYb6Zc1FgH3Ja5Ue7Io0Bx9Vt".repeat(4)}"`,
			`data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(24)}`,
		].join("\n");
		expect(findShareUploadSecretFindings(clean)).toEqual([]);
	});

	it("does not flag a names-only dump, the incident session's `grep -E` shape", () => {
		// `cat .env | cut -d= -f1` and `grep -E "^MYSQL_USER=|^MYSQL_PASSWORD="` both print name
		// after name with empty values; the separator swallows the whitespace and the next name
		// lands in the value slot. Both shapes were real false positives on this machine.
		const namesOnly = [
			"MYSQL_ROOT_PASSWORD= MYSQL_DATABASE= MYSQL_USER= REDIS_HOST= MINIO_ROOT_PASSWORD=",
			`'grep -E "^MYSQL_USER=|^MYSQL_PASSWORD=|^MYSQL_DATABASE=" /opt/app/config/.env.prod'`,
		].join("\n");
		expect(findShareUploadSecretFindings(namesOnly)).toEqual([]);
	});

	it("does not flag prose, slugs, locations or code references", () => {
		const prose = [
			"ensure server AI_ENCRYPT_KEY = local baseline key.",
			"KEY: daemon-access-token-for-remote-supervisor",
			"GOOGLE_APPLICATION_CREDENTIALS=/etc/gcp/service-account.json",
			'TOKEN = os.environ.get("TOKEN")',
			"SET @@FOREIGN_KEY_CHECKS=0;",
		].join("\n");
		expect(findShareUploadSecretFindings(prose)).toEqual([]);
	});

	it("does not treat the export template's own storage-key line as a credential", () => {
		// The uploaded document is a fixed template, and the template assigns a localStorage
		// key. Reading it as a credential would warn on every share of every session.
		const template = "  const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';";
		expect(findShareUploadSecretFindings(template)).toEqual([]);
	});

	it("does not flag placeholder assignments", () => {
		const placeholders = [
			"OPENAI_API_KEY=<your-key-here>",
			// Assembled so the placeholder never looks like a template to the linter.
			`ANTHROPIC_API_KEY=$${"{ANTHROPIC_API_KEY}"}`,
			"SECRET_KEY=changeme",
			"GITHUB_TOKEN=REDACTED",
			"DATABASE_PASSWORD=your-password-goes-here",
		].join("\n");
		expect(findShareUploadSecretFindings(placeholders)).toEqual([]);
	});
});

describe("share preflight on a real exported session", () => {
	it("finds the live key shapes inside the exported payload and keeps them out of the report", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "prime-share-real-"));
		try {
			const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
			manager.appendMessage({
				role: "user",
				content: `ps eww output:\n${ENV_ASSIGNMENT}\nX-XAI-Token-Auth: ${LONG_JWT}\nthe runner printed ${SHAPELESS_VALUE} into its log`,
				timestamp: Date.now(),
			});
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing test session file");
			const output = join(tempRoot, "session.html");
			await exportFromFile(sessionFile, output);
			const html = readFileSync(output, "utf8");

			// The uploaded document carries no plaintext credential at all.
			expect(html).not.toContain(DASHSCOPE_KEY);
			expect(html).not.toContain(LONG_JWT);

			const findings = findShareUploadSecretFindings(html);
			const types = findings.map((finding) => finding.type);
			expect(types).toContain("API key (sk-)");
			expect(types).toContain("JWT (three base64url segments)");
			for (const finding of findings) {
				expect(finding.view).toContain("payload");
				expect(finding.offset).toBeGreaterThan(0);
				expect(finding.line).toBeGreaterThan(0);
				expect(finding.masked.length).toBeLessThan(DASHSCOPE_KEY.length);
			}
			const report = JSON.stringify(findings);
			expect(report).not.toContain(DASHSCOPE_KEY);
			expect(report).not.toContain(LONG_JWT);
			expect(report).not.toContain(SHAPELESS_VALUE.slice(0, 20));

			// End to end: the preflight blocks the upload unless the user confirms.
			const { result, messages } = await confirmWithMessage(html, false);
			expect(result).toBe(false);
			expect(messages[0]).toContain("API key (sk-)");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
