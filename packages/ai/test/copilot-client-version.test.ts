/**
 * Pins the single owner of the impersonated GitHub Copilot client identity, and
 * the OpenRouter peak-tariff pricing rule that came with it upstream
 * (a062ed221 / #2069).
 *
 * Both the OAuth flow (src/utils/oauth/github-copilot.ts) and the catalog
 * generator (scripts/generate-models.ts) used to carry their own copy of the
 * headers, and both had drifted to GitHub Copilot Chat 0.35.0 on VS Code
 * 1.107.0 - old enough for the gateway to stop accepting the client. The
 * generator cannot be imported for a unit test (it calls generateModels() at
 * import time: four live endpoints plus a rewrite of the committed catalog), so
 * the ownership and pricing rules are read from source, in the style of
 * build-catalog-determinism.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPILOT_CLIENT_HEADERS, COPILOT_CLIENT_USER_AGENT } from "../src/copilot-client-version.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Floors from upstream a062ed221; anything older is a regression, not a choice. */
const MINIMUM_COPILOT_CHAT_VERSION = "0.48.1";
const MINIMUM_VSCODE_VERSION = "1.136.1";

const COPILOT_CLIENT_OWNERS = ["src/utils/oauth/github-copilot.ts", "scripts/generate-models.ts"] as const;

function compareDottedVersions(left: string, right: string): number {
	const a = left.split(".").map((part) => Number.parseInt(part, 10));
	const b = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function versionFrom(pattern: RegExp, value: string): string {
	const match = pattern.exec(value);
	expect(match, `${pattern} against ${JSON.stringify(value)}`).toBeTruthy();
	return match![1];
}

describe("GitHub Copilot client identity", () => {
	it("publishes current, self-consistent impersonated versions", () => {
		const chatVersion = versionFrom(/^GitHubCopilotChat\/(\d+\.\d+\.\d+)$/, COPILOT_CLIENT_USER_AGENT);
		const pluginVersion = versionFrom(
			/^copilot-chat\/(\d+\.\d+\.\d+)$/,
			COPILOT_CLIENT_HEADERS["Editor-Plugin-Version"],
		);
		const vscodeVersion = versionFrom(/^vscode\/(\d+\.\d+\.\d+)$/, COPILOT_CLIENT_HEADERS["Editor-Version"]);

		expect(COPILOT_CLIENT_HEADERS["User-Agent"]).toBe(COPILOT_CLIENT_USER_AGENT);
		expect(compareDottedVersions(chatVersion, MINIMUM_COPILOT_CHAT_VERSION)).toBeGreaterThanOrEqual(0);
		expect(compareDottedVersions(vscodeVersion, MINIMUM_VSCODE_VERSION)).toBeGreaterThanOrEqual(0);
		// One identity: the plugin version is the chat version, not a second copy.
		expect(pluginVersion).toBe(chatVersion);
		expect(COPILOT_CLIENT_HEADERS["Copilot-Integration-Id"]).toBe("vscode-chat");
	});

	it("is read from one module by every consumer", () => {
		expect(COPILOT_CLIENT_OWNERS.length).toBeGreaterThan(0);
		for (const relativePath of COPILOT_CLIENT_OWNERS) {
			const source = readFileSync(join(packageRoot, relativePath), "utf8");
			expect(source, `${relativePath} imports the shared identity`).toContain("copilot-client-version.js");
			expect(source, `${relativePath} hardcodes a client version`).not.toMatch(/GitHubCopilotChat\/\d/);
		}
	});

	it("prices OpenRouter models from the peak of any time-windowed tariff", () => {
		const generator = readFileSync(join(packageRoot, "scripts", "generate-models.ts"), "utf8");

		// Time-windowed overrides (utc_start/utc_end) make the top-level price
		// clock-dependent; committing the peak keeps regens hour-independent and
		// cost accounting from undercounting.
		expect(generator).toContain("pricing?.overrides");
		expect(generator).toContain("utc_start");
		const peakPrice = generator.match(/const peakPrice = \(field: string\): number =>[\s\S]*?\n\t\t\t\};/);
		expect(peakPrice, "peakPrice helper").toBeTruthy();
		for (const field of ["prompt", "completion", "input_cache_read", "input_cache_write"]) {
			expect(generator, `${field} cost`).toContain(`peakPrice("${field}")`);
		}
	});
});
