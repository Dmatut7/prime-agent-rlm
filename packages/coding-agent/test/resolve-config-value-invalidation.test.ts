import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { resolveConfigValue, resolveConfigValueUncached } from "../src/core/resolve-config-value.js";
import { SERPER_CREDENTIAL_ID } from "../src/core/websearch-credential.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

/**
 * A `!command` credential is cached by command text for the process lifetime, so the
 * cached value outlives the secret it was read from. Both consumers of the websearch key
 * (`AuthStorage.getApiKey` for models, `AgentSession._addWebsearchKeyEnv` for the kernel
 * environment) go through AuthStorage, so the invalidation surface lives there: a reload
 * or a credential write drops the cache and the next call re-runs the command.
 */
describePosix("resolveConfigValue invalidation via AuthStorage", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), `prime-cfg-${prefix}-`));
		dirs.push(dir);
		return dir;
	}

	it("re-resolves a cached command credential after AuthStorage.reload()", () => {
		const dir = makeDir("reload");
		const tokenPath = join(dir, "token.txt");
		const authPath = join(dir, "auth.json");
		writeFileSync(tokenPath, "OLD-KEY\n", { mode: 0o600 });
		const command = `!cat ${tokenPath}`;
		writeFileSync(authPath, JSON.stringify({ [SERPER_CREDENTIAL_ID]: { type: "api_key", key: command } }), {
			mode: 0o600,
		});
		const authStorage = AuthStorage.create(authPath);

		const serperKey = (): string => {
			const credential = authStorage.get(SERPER_CREDENTIAL_ID);
			return credential?.type === "api_key" ? credential.key : "";
		};
		// The agent-session write site resolves exactly this way.
		expect(resolveConfigValue(serperKey())).toBe("OLD-KEY");

		writeFileSync(tokenPath, "NEW-KEY\n", { mode: 0o600 });
		// Positive control: the command itself does produce the new value.
		expect(resolveConfigValueUncached(command)).toBe("NEW-KEY");
		// ...and what the cached call site served before the reload was the old one.
		expect(resolveConfigValue(serperKey())).toBe("OLD-KEY");

		authStorage.reload();

		expect(resolveConfigValue(serperKey())).toBe("NEW-KEY");
	});

	it("drops a cached command failure when a credential is written", () => {
		const dir = makeDir("write");
		const tokenPath = join(dir, "late-token.txt");
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "{}", { mode: 0o600 });
		const authStorage = AuthStorage.create(authPath);
		const command = `!cat ${tokenPath}`;

		// A missing token file caches a failure for COMMAND_FAILURE_RETRY_AFTER_MS.
		expect(resolveConfigValue(command)).toBeUndefined();

		writeFileSync(tokenPath, "LATE-KEY\n", { mode: 0o600 });
		// Positive control: the command now succeeds.
		expect(resolveConfigValueUncached(command)).toBe("LATE-KEY");
		// The cached failure is still what a call site sees before any invalidation.
		expect(resolveConfigValue(command)).toBeUndefined();

		authStorage.set(SERPER_CREDENTIAL_ID, { type: "api_key", key: command });

		const credential = authStorage.get(SERPER_CREDENTIAL_ID);
		expect(credential?.type).toBe("api_key");
		expect(resolveConfigValue(credential?.type === "api_key" ? credential.key : "")).toBe("LATE-KEY");
	});

	it("keeps serving a resolved credential when nothing invalidates it", () => {
		const dir = makeDir("control");
		const authPath = join(dir, "auth.json");
		expect(existsSync(authPath)).toBe(false);
		const command = `!printf '${"stable-credential"}'`;
		writeFileSync(authPath, "{}", { mode: 0o600 });
		const authStorage = AuthStorage.create(authPath);

		expect(resolveConfigValue(command)).toBe("stable-credential");
		authStorage.reload();
		expect(resolveConfigValue(command)).toBe("stable-credential");
	});
});
