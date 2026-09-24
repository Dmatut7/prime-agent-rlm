import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

/**
 * Dropping a screenshot from Finder into the prompt pastes its path. The editor's paste
 * hook turns it into an image attachment like Ctrl+V, so the image reaches a model that
 * can see it without the session model having to notice the path and load it.
 */
describe("InteractiveMode paste of an image file path", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-paste-path-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function modeWithEditor() {
		const pastedImages = new Map<number, ImageContent>();
		const defaultEditor: { onAction: () => void; transformPaste?: (text: string) => string } = {
			onAction: vi.fn(),
		};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			ui: { requestRender: vi.fn() },
			connectionState: { cwd: dir, model: getModel("anthropic", "claude-opus-4-7") },
			nextImageMarkerId: 4,
			rememberPastedImage: (markerId: number, image: ImageContent) => pastedImages.set(markerId, image),
		}) as { setupKeyHandlers(): void };
		fakeThis.setupKeyHandlers();
		return { defaultEditor, pastedImages };
	}

	test("attaches a dropped image path as [image #N] and keeps the path visible", async () => {
		const shot = join(dir, "Screen Shot.png");
		writeFileSync(shot, PNG);
		const { defaultEditor, pastedImages } = modeWithEditor();

		const inserted = defaultEditor.transformPaste?.(`${shot.replace(/ /g, "\\ ")} `);

		expect(inserted).toBe(`${shot.replace(/ /g, "\\ ")} [image #4]`);
		await vi.waitFor(() => expect(pastedImages.get(4)).toMatchObject({ type: "image", mimeType: "image/png" }));
	});

	test("leaves a path that is not an image file as plain text", () => {
		const notes = join(dir, "notes.txt");
		writeFileSync(notes, "text");
		const { defaultEditor, pastedImages } = modeWithEditor();

		expect(defaultEditor.transformPaste?.(notes)).toBe(notes);
		expect(pastedImages.size).toBe(0);
	});
});

describe("InteractiveMode notices about who reads a pasted image", () => {
	const textOnly = { ...getModel("anthropic", "claude-opus-4-7"), id: "glm-text", input: ["text" as const] };
	const vision = getModel("anthropic", "claude-haiku-4-5");

	type NoticeHarness = {
		noticeImageModelServing(message: { provider: string; model: string }): void;
		warnIfPastedImageUnseen(): Promise<void>;
	};

	function mode(settings: { imageModel?: string; blockImages?: boolean }) {
		const statuses: string[] = [];
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			connectionState: { cwd: "/tmp", model: textOnly, thinkingLevel: "off", serviceTier: "default" },
			connectionModelCatalog: [textOnly, vision],
			connectionConfiguredProviders: new Set(["anthropic"]),
			getConnectionAvailableModels: async () => [textOnly, vision],
			uiServices: {
				modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
				settingsManager: {
					getImageModel: () => settings.imageModel,
					getBlockImages: () => settings.blockImages ?? false,
				},
			},
			showStatus: (message: string) => statuses.push(message),
		}) as NoticeHarness;
		return { fakeThis, statuses };
	}

	test("names the image model once when it serves a turn of a text-only session model", () => {
		const { fakeThis, statuses } = mode({ imageModel: "anthropic/claude-haiku-4-5" });
		fakeThis.noticeImageModelServing({ provider: "anthropic", model: "claude-haiku-4-5" });
		fakeThis.noticeImageModelServing({ provider: "anthropic", model: "claude-haiku-4-5" });
		fakeThis.noticeImageModelServing({ provider: "anthropic", model: "glm-text" });
		fakeThis.noticeImageModelServing({ provider: "anthropic", model: "claude-haiku-4-5" });
		expect(statuses).toEqual([
			"这张图交给 anthropic/claude-haiku-4-5 看",
			"这张图交给 anthropic/claude-haiku-4-5 看",
		]);
	});

	test.each([
		["imageModel is unset", {}, "也没设看图模型"],
		["imageModel is mistyped", { imageModel: "anthropic/claude-haiku-4-6" }, "「anthropic/claude-haiku-4-6」用不了"],
		["images are turned off", { imageModel: "anthropic/claude-haiku-4-5", blockImages: true }, "blockImages"],
	])("warns in Chinese at paste time when %s", async (_name, settings, text) => {
		const { fakeThis, statuses } = mode(settings);
		await fakeThis.warnIfPastedImageUnseen();
		expect(statuses).toEqual([expect.stringContaining(text)]);
	});

	test("stays quiet when the configured image model can read the paste", async () => {
		const { fakeThis, statuses } = mode({ imageModel: "anthropic/claude-haiku-4-5" });
		await fakeThis.warnIfPastedImageUnseen();
		expect(statuses).toEqual([]);
	});
});
