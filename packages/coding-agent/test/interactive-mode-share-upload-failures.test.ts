import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The source imports from "child_process" (no node: prefix), so mock that exact specifier.
// spawnSync answers the `gh auth status` preflight; spawn is shaped per test below.
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 0 })),
		spawn: vi.fn(),
	};
});

// Distinct temp-dir prefix: a sibling suite asserts on the live set of
// `prime-agent-share-*` directories in tmpdir, and a parallel worker must not move it.
// The factory uses only node builtins, which are evaluated before any relative import,
// so the hoisted mock never reaches for a binding that is still in its TDZ.
vi.mock("../src/core/share-session.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/share-session.js")>();
	type ShareTempFile = ReturnType<typeof actual.createShareTempHtmlFile>;
	return {
		...actual,
		createShareTempHtmlFile: (): ShareTempFile => {
			const directory = join(tmpdir(), `share-upload-failures-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			return { directory, path: join(directory, "export.html") } as ShareTempFile;
		},
	};
});

import { SHARE_UPLOAD_TIMEOUT_MS } from "../src/core/share-session.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type FakeChild = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
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

const madeDirs: string[] = [];

function fakeShareThis(): ShareThis {
	return {
		agentConnection: {
			exportToHtml: async (path: string) => {
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				madeDirs.push(dirname(path));
				writeFileSync(path, "<html>clean session export</html>", { mode: 0o600 });
				return path;
			},
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
	};
}

const shareDirNames = (): Set<string> =>
	new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("prime-agent-share-")));

describe("handleShareCommand survives a failing gist upload", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// The mock must be in effect, or the real `gh` on a logged-in machine would
		// quietly turn these nails into environment-dependent passes.
		expect(vi.isMockFunction(spawnSync)).toBe(true);
		expect(vi.isMockFunction(spawn)).toBe(true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		while (madeDirs.length > 0) {
			const dir = madeDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a spawn failure instead of awaiting an event that never comes", async () => {
		// gh disappears between the auth preflight and the upload (PATH race, EMFILE,
		// EACCES): Node emits 'error' and never 'close'. Only an 'error' listener can
		// settle the upload promise, so without one this await hangs forever.
		const child = fakeChild();
		vi.mocked(spawn).mockImplementation(() => child as unknown as ReturnType<typeof spawn>);
		const fakeThis = fakeShareThis();
		const before = shareDirNames();

		const upload = proto.handleShareCommand.call(fakeThis);
		// The command awaits the export and the secret preflight before it spawns, so wait
		// for the child to be wired up. Pre-fix nothing ever listens for 'error', and this
		// is what times out; post-fix the listener is there and the emit settles the await.
		await vi.waitFor(() => expect(child.listenerCount("error")).toBeGreaterThan(0));
		child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
		await upload;

		expect(fakeThis.showError).toHaveBeenCalledOnce();
		expect(String(fakeThis.showError.mock.calls[0]?.[0])).toContain("spawn gh ENOENT");
		// The 0700 export directory must not survive a failed upload.
		expect(madeDirs.length).toBeGreaterThan(0);
		for (const dir of madeDirs) {
			expect(existsSync(dir), dir).toBe(false);
		}
		expect([...shareDirNames()].filter((name) => !before.has(name))).toEqual([]);
		// The editor has to come back, or the prompt is left unmounted.
		expect(fakeThis.editorContainer.addChild).toHaveBeenLastCalledWith(fakeThis.editor);
	}, 10_000);

	it("bounds a gist upload that never settles", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		vi.mocked(spawn).mockImplementation(() => child as unknown as ReturnType<typeof spawn>);
		const fakeThis = fakeShareThis();

		const upload = proto.handleShareCommand.call(fakeThis);
		await vi.advanceTimersByTimeAsync(SHARE_UPLOAD_TIMEOUT_MS + 1000);
		await upload;

		expect(child.kill).toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledOnce();
		expect(String(fakeThis.showError.mock.calls[0]?.[0])).toMatch(/timed out|timeout/i);
		expect(fakeThis.editorContainer.addChild).toHaveBeenLastCalledWith(fakeThis.editor);
		expect(madeDirs.length).toBeGreaterThan(0);
		for (const dir of madeDirs) {
			expect(existsSync(dir), dir).toBe(false);
		}
		// Explicit bound: this test fails by hanging when the upload bound is missing.
	}, 8_000);

	it("keeps a slow but successful upload working", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		vi.mocked(spawn).mockImplementation(() => child as unknown as ReturnType<typeof spawn>);
		const fakeThis = fakeShareThis();

		const upload = proto.handleShareCommand.call(fakeThis);
		// Just under the bound: the upload must still be allowed to finish.
		await vi.advanceTimersByTimeAsync(SHARE_UPLOAD_TIMEOUT_MS - 1000);
		child.stdout.emit("data", Buffer.from("https://gist.github.com/u/abc123\n"));
		child.emit("close", 0);
		await upload;

		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(String(fakeThis.showStatus.mock.calls[0]?.[0])).toContain("https://gist.github.com/u/abc123");
	}, 8_000);
});
