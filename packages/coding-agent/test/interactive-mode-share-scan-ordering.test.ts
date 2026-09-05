import { EventEmitter } from "node:events";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The source imports from "child_process" (no node: prefix), so mock that exact specifier.
// spawnSync answers the `gh auth status` preflight; spawn has to emit close, because a
// pre-fix red path reaches gist creation and would otherwise fail as a 30s timeout rather
// than as the assertion it is meant to fail.
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	type FakeChild = EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: () => void;
	};
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 0 })),
		spawn: vi.fn(() => {
			const child = new EventEmitter() as FakeChild;
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			setTimeout(() => {
				child.stdout.emit("data", Buffer.from("https://gist.github.com/u/abc123\n"));
				child.emit("close", 0);
			}, 10);
			return child;
		}),
	};
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ShareThis = {
	agentConnection: {
		exportToHtml: (path: string) => Promise<string>;
		getMessages: () => Promise<unknown[]>;
		getSystemPrompt: () => Promise<string>;
	};
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	ui: { setFocus: (component: unknown) => void; requestRender: () => void };
	editorContainer: { clear: () => void; addChild: (component: unknown) => void };
	editor: object;
};

const proto = InteractiveMode.prototype as unknown as {
	handleShareCommand(this: ShareThis): Promise<void>;
};

const shareDirNames = (): Set<string> =>
	new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("prime-agent-share-")));

/**
 * The ordering claim is "the secret preflight must scan the bytes that are actually
 * uploaded". The export carries the tool definitions and working-directory context the
 * exporter adds, so a scanner fed a messages/systemPrompt proxy instead would pass a
 * secret it never looks at. The secret below exists only in the export bytes and the
 * proxy shape is clean, so whether the dialog fires tells the two apart.
 */
describe("handleShareCommand scans the exported bytes", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("asks for confirmation on a secret that only the export carries, and cleans up on cancel", async () => {
		const exportBytes = "<html>session export with tools and cwd: sk-LIVEKEYONLYINEXPORT123</html>";
		const confirmMessages: string[] = [];
		const fakeThis: ShareThis = {
			agentConnection: {
				exportToHtml: async (path: string) => {
					writeFileSync(path, exportBytes);
					return path;
				},
				// Both clean: a scanner reading these instead of the export sees no secret.
				getMessages: async () => [{ role: "user", content: "clean hello" }],
				getSystemPrompt: async () => "clean system prompt",
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			showExtensionConfirm: vi.fn(async (_title: string, message: string) => {
				confirmMessages.push(message);
				return false;
			}),
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
		};

		// This nail depends on the child_process mock. The real `gh auth status` succeeds on
		// a logged-in machine, so a mock that silently failed to apply would still pass here
		// and the test would quietly become environment-dependent. Assert the interception
		// rather than assuming it; the specifier must match the source import exactly.
		expect(vi.isMockFunction(spawnSync)).toBe(true);

		const before = shareDirNames();
		await proto.handleShareCommand.call(fakeThis);
		expect(vi.mocked(spawnSync)).toHaveBeenCalled();

		// The dialog fired, so the scanner saw the export bytes. Scanning the proxy would
		// have found nothing and never asked.
		expect(confirmMessages).toHaveLength(1);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Share cancelled");
		// Cancelling after the export exists has to remove it. Compared as a name set rather
		// than a count: another suite creating and removing a directory with the same prefix
		// concurrently would move the count without this test having leaked anything.
		expect([...shareDirNames()].filter((name) => !before.has(name))).toEqual([]);
	});
});
