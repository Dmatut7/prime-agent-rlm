import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Round-27 SEC-5: the /export command writes an HTML file whose base64 payload embeds
 * the whole session (header cwd, usernames, emails). The bytes are invisible at a
 * plain-text glance, so the command itself has to say what the file carries next to
 * the path it just reported — the user decides who receives that file.
 */

function exportHtml(payloadText: string, cwd?: string): string {
	const payload = JSON.stringify({
		header: { version: 1, ...(cwd !== undefined ? { cwd } : {}) },
		entries: [{ type: "message", message: { role: "user", content: payloadText } }],
	});
	return `<html><body><script id="session-data" type="application/json">${Buffer.from(payload).toString("base64")}</script></body></html>`;
}

type ExportThis = {
	getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined;
	agentConnection: { exportToHtml: (path: string) => Promise<string> };
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
};

const proto = InteractiveMode.prototype as unknown as {
	handleExportCommand(this: ExportThis, text: string): Promise<void>;
};

function fakeExportThis(html: string): ExportThis {
	const outputPath = join(tmpdir(), `pi-export-identity-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
	return {
		getPathCommandArgument: () => outputPath,
		agentConnection: {
			exportToHtml: async (path: string) => {
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, html, { mode: 0o600 });
				return path;
			},
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
}

describe("/export reports identity data embedded in the written file", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("warns next to the export path when the file embeds the session cwd", async () => {
		const fakeThis = fakeExportThis(exportHtml("built the feature", "/Users/alice/projects/app"));

		await proto.handleExportCommand.call(fakeThis, "/export /tmp/out.html");

		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledTimes(1);
		const message = vi.mocked(fakeThis.showStatus).mock.calls[0][0] as string;
		expect(message).toContain("会话已导出到：");
		expect(message).toContain("absolute path");
		expect(message).toContain("/Users/alice");
	});

	it("keeps the plain success line for a code-only export (positive control)", async () => {
		const fakeThis = fakeExportThis(exportHtml("function add(a, b) { return a + b; }"));

		await proto.handleExportCommand.call(fakeThis, "/export /tmp/out.html");

		expect(fakeThis.showError).not.toHaveBeenCalled();
		const message = vi.mocked(fakeThis.showStatus).mock.calls[0][0] as string;
		expect(message).toContain("会话已导出到：");
		expect(message).not.toContain("absolute path");
		expect(message).not.toContain("identifies");
	});
});
