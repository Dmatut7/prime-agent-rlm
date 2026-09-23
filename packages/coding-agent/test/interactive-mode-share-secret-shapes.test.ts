import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The source imports from "child_process" (no node: prefix), so mock that exact specifier.
// spawnSync answers the `gh auth status` preflight; spawn would be the upload itself, which
// every assertion here expects NOT to happen while the preflight is asking the user.
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 0 })),
		spawn: vi.fn(() => {
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				kill: () => void;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			setTimeout(() => {
				child.stdout.emit("data", Buffer.from("https://gist.github.com/u/leaked1234\n"));
				child.emit("close", 0);
			}, 10);
			return child;
		}),
	};
});

// Distinct temp-dir prefix: a sibling suite (interactive-mode-share-scan-ordering) asserts on
// the live set of `prime-agent-share-*` directories in tmpdir, and a directory this suite holds
// open across the confirm dialog would move that set. The factory uses only node builtins,
// which are evaluated before any relative import, so the hoisted mock never reaches for a
// binding that is still in its TDZ.
vi.mock("../src/core/share-session.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/share-session.js")>();
	type ShareTempFile = ReturnType<typeof actual.createShareTempHtmlFile>;
	return {
		...actual,
		createShareTempHtmlFile: (): ShareTempFile => {
			const directory = join(tmpdir(), `share-secret-shapes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			return { directory, path: join(directory, "export.html") } as ShareTempFile;
		},
	};
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** Shape of the live bailian key, which the shipped prefix pattern never reached. */
const DASHSCOPE_KEY = `sk-ws-H.ELM7q2Zk1Vx9Rt4Bn6Pw8Yc3Uf5Jd0Sg2Ae7Hm1Lq4Zb6Xr8Nv3Tx5Cd9Kf2Wp7Ya4Rg6Bj1Qe8Hz3Mn5Uv0Tb2Ls7Fd`;

/** The uploaded artifact of the production shape, carrying a real-world credential dump. */
function exportBytesWithKeyDump(): string {
	const payload = JSON.stringify({
		header: { version: 1 },
		entries: [
			{
				type: "message",
				message: { role: "toolResult", content: `ps eww output:\nDASHSCOPE_API_KEY=${DASHSCOPE_KEY}` },
			},
		],
	});
	return `<html><body><script id="session-data" type="application/json">${Buffer.from(payload).toString("base64")}</script></body></html>`;
}

type ShareThis = {
	agentConnection: { exportToHtml: (path: string) => Promise<string> };
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showExtensionConfirm: ReturnType<typeof vi.fn>;
	ui: { setFocus: (component: unknown) => void; requestRender: () => void };
	editorContainer: { clear: () => void; addChild: (component: unknown) => void };
	editor: object;
};

const proto = InteractiveMode.prototype as unknown as {
	handleShareCommand(this: ShareThis): Promise<void>;
};

function fakeShareThis(exportBytes: string, answer: boolean): ShareThis {
	return {
		agentConnection: {
			exportToHtml: async (path: string) => {
				// The temp directory the mocked factory named is not created for us, and the
				// reader that loads the export back checks the private modes.
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				writeFileSync(path, exportBytes, { mode: 0o600 });
				return path;
			},
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		showExtensionConfirm: vi.fn(async (_title: string, _message: string) => answer),
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
	};
}

const shareDirNames = (): Set<string> =>
	new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("prime-agent-share-")));

describe("handleShareCommand blocks an upload the preflight flagged", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Without the interception the real `gh` on a logged-in machine would make these
		// assertions environment-dependent; the mock specifier must match the source import.
		expect(vi.isMockFunction(spawnSync)).toBe(true);
		expect(vi.isMockFunction(spawn)).toBe(true);
		vi.clearAllMocks();
	});

	it("never reaches the gist upload when the user cancels the secret warning", async () => {
		const fakeThis = fakeShareThis(exportBytesWithKeyDump(), false);
		const before = shareDirNames();

		const share = proto.handleShareCommand.call(fakeThis);
		// Only advance while the upload has not been reached: the preflight runs before the
		// gist process exists, so waiting for a call that must never happen would hang.
		await Promise.race([vi.waitFor(() => expect(fakeThis.showExtensionConfirm).toHaveBeenCalled()), share]);
		await share;

		expect(vi.mocked(spawnSync)).toHaveBeenCalled();
		expect(fakeThis.showExtensionConfirm).toHaveBeenCalledTimes(1);
		const message = vi.mocked(fakeThis.showExtensionConfirm).mock.calls[0][1] as string;
		expect(message).toContain("API key (sk-)");
		expect(message).not.toContain(DASHSCOPE_KEY);
		// The upload itself must not have been spawned at all.
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("已取消分享");
		expect([...shareDirNames()].filter((name) => !before.has(name))).toEqual([]);
	});

	it("uploads only after the user confirms the flagged session", async () => {
		const fakeThis = fakeShareThis(exportBytesWithKeyDump(), true);

		await proto.handleShareCommand.call(fakeThis);

		expect(fakeThis.showExtensionConfirm).toHaveBeenCalledTimes(1);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});
});
