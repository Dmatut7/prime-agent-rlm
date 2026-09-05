import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createShareTempHtmlFile } from "../src/core/share-session.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0 })),
	spawn: vi.fn(),
}));
vi.mock("../src/core/share-session.js", () => ({
	createShareTempHtmlFile: vi.fn(),
	confirmShareIfSecrets: vi.fn(async () => true),
}));
vi.mock("../src/utils/private-files.js", () => ({
	readPrivateFile: vi.fn(() => "<html></html>"),
	createPrivateTempFile: vi.fn(),
	writePrivateFileAtomic: vi.fn(),
}));
// The loader is what fails here: constructing and mounting it runs outside the export/read/confirm
// guards, so this is the edge that used to leave the temp directory behind.
vi.mock("../src/modes/interactive/components/bordered-loader.js", () => ({
	// A function expression, not an arrow: the source constructs it with `new`, and vitest
	// warns when a mock that gets constructed has an arrow implementation.
	BorderedLoader: vi.fn(function (this: unknown) {
		throw new Error("loader mount blew up");
	}),
}));

type ShareThis = {
	agentConnection: { exportToHtml: (file: string) => Promise<void> };
	editorContainer: { clear(): void; addChild(component: unknown): void };
	ui: { setFocus(component: unknown): void; requestRender(): void };
	editor: unknown;
	showError(message: string): void;
	showStatus(message: string): void;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
};

function fakeShareThis(): ShareThis {
	return {
		agentConnection: { exportToHtml: vi.fn(async () => {}) },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editor: { __editor: true },
		showError: vi.fn(),
		showStatus: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
	};
}

describe("handleShareCommand cleans up the export when the loader cannot be mounted", () => {
	const made: string[] = [];

	afterEach(() => {
		while (made.length > 0) {
			const dir = made.pop();
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.clearAllMocks();
	});

	test("removes the temp directory, reports, and puts the editor back", async () => {
		// A real directory, so the assertion is a filesystem fact rather than a spy count.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-cleanup-"));
		made.push(dir);
		fs.writeFileSync(path.join(dir, "export.html"), "<html></html>", { mode: 0o600 });
		vi.mocked(createShareTempHtmlFile).mockReturnValue({
			directory: dir,
			path: path.join(dir, "export.html"),
		} as unknown as ReturnType<typeof createShareTempHtmlFile>);

		const fakeThis = fakeShareThis();
		const proto = InteractiveMode as unknown as {
			prototype: { handleShareCommand(): Promise<void> };
		};
		await proto.prototype.handleShareCommand.call(fakeThis);

		// The whole point: the 0700 directory and its 0600 export are gone.
		expect(fs.existsSync(dir)).toBe(false);
		expect(fakeThis.showError).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(fakeThis.showError).mock.calls[0]?.[0])).toContain("loader mount blew up");
		// clear() already ran before the throw, so the editor has to come back or the prompt is
		// left unmounted and the session unusable.
		expect(fakeThis.editorContainer.addChild).toHaveBeenLastCalledWith(fakeThis.editor);
		expect(fakeThis.ui.setFocus).toHaveBeenLastCalledWith(fakeThis.editor);
	});
});
