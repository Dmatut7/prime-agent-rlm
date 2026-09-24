import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { annotateImageMarkerPaths } from "../src/modes/interactive/image-markers.js";
import { PastedImageFiles, pastedImageProblemNotice } from "../src/modes/interactive/pasted-image-files.js";
import { imageFilesInPaste } from "../src/modes/interactive/pasted-image-paths.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");
const NNBSP = " ";

describe("image file paths pasted or dropped into the editor", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-pasted-paths-"));
		mkdirSync(join(dir, "My Shots"));
		writeFileSync(join(dir, "shot.png"), PNG);
		writeFileSync(join(dir, "My Shots", "login page.png"), PNG);
		writeFileSync(join(dir, "My Shots", `Screenshot 2026-09-25 at 10.00.00${NNBSP}AM.png`), PNG);
		writeFileSync(join(dir, "notes.txt"), "just text");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const paths = (text: string) => imageFilesInPaste(text, dir)?.map((file) => file.path);

	test("a single path, bare or with trailing whitespace", () => {
		expect(paths(`${join(dir, "shot.png")} `)).toEqual([join(dir, "shot.png")]);
		expect(imageFilesInPaste(join(dir, "shot.png"), dir)?.[0]?.mimeType).toBe("image/png");
	});

	test("a Finder drop with backslash-escaped spaces, quotes, or raw spaces", () => {
		const target = join(dir, "My Shots", "login page.png");
		expect(paths(target.replace(/ /g, "\\ "))).toEqual([target]);
		expect(paths(`'${target}'`)).toEqual([target]);
		expect(paths(`"${target}"`)).toEqual([target]);
		expect(paths(target)).toEqual([target]);
	});

	test("a macOS screenshot name typed or dropped with a plain space before AM", () => {
		const onDisk = join(dir, "My Shots", `Screenshot 2026-09-25 at 10.00.00${NNBSP}AM.png`);
		const typed = join(dir, "My Shots", "Screenshot 2026-09-25 at 10.00.00 AM.png");
		expect(paths(typed.replace(/ /g, "\\ "))).toEqual([onDisk]);
		expect(paths(`'${typed}'`)).toEqual([onDisk]);
	});

	test("several dropped files, space or newline separated, and file:// URLs", () => {
		const first = join(dir, "shot.png");
		const second = join(dir, "My Shots", "login page.png");
		expect(paths(`${first} ${second.replace(/ /g, "\\ ")}`)).toEqual([first, second]);
		expect(paths(`${first}\n${second}\n`)).toEqual([first, second]);
		expect(paths(`file://${encodeURI(second)}`)).toEqual([second]);
	});

	test("anything that is not purely existing image files stays text", () => {
		expect(imageFilesInPaste(join(dir, "notes.txt"), dir)).toBeUndefined();
		expect(imageFilesInPaste(join(dir, "missing.png"), dir)).toBeUndefined();
		expect(imageFilesInPaste(`看看 ${join(dir, "shot.png")}`, dir)).toBeUndefined();
		expect(imageFilesInPaste(`${join(dir, "shot.png")} ${join(dir, "notes.txt")}`, dir)).toBeUndefined();
		expect(imageFilesInPaste("shot.png", dir)).toBeUndefined();
		expect(imageFilesInPaste(`'${join(dir, "shot.png")}`, dir)).toBeUndefined();
	});
});

describe("files behind pasted images", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-pasted-files-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function files() {
		const remembered = new Map<number, ImageContent>();
		const warnings: string[] = [];
		const store = new PastedImageFiles({
			remember: (markerId, image) => remembered.set(markerId, image),
			warn: (message) => warnings.push(message),
		});
		return { store, remembered, warnings };
	}

	test("saves a Ctrl+V image under the session and names the file next to its marker", async () => {
		const { store } = files();
		const imageDir = join(dir, "pasted-images");
		store.save(3, { type: "image", data: PNG_BASE64, mimeType: "image/png" }, imageDir);
		const sent = store.annotate("看 [image #3] 右下角");
		await store.settle("[image #3]");

		const saved = /\[image #3\]\((.+?)\)/.exec(sent)?.[1];
		expect(saved).toBeDefined();
		expect(sent).toBe(`看 [image #3](${saved}) 右下角`);
		expect(existsSync(saved ?? "")).toBe(true);
		expect(readFileSync(saved ?? "")).toEqual(PNG);
		// Resending an already annotated message does not stack paths.
		expect(store.annotate(sent)).toBe(sent);
	});

	test("an unsaved session keeps the marker bare", () => {
		const { store } = files();
		store.save(1, { type: "image", data: PNG_BASE64, mimeType: "image/png" }, undefined);
		expect(store.annotate("[image #1]")).toBe("[image #1]");
	});

	test("loads a pasted image path as an attachment, and waits for it before sending", async () => {
		const { store, remembered } = files();
		const file = join(dir, "shot.png");
		writeFileSync(file, PNG);
		store.load(5, { path: file, mimeType: "image/png" });
		expect(store.hasPending("see [image #5]")).toBe(true);
		await store.settle("see [image #5]");
		expect(store.hasPending("see [image #5]")).toBe(false);
		expect(remembered.get(5)).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(remembered.get(5)?.data.length).toBeGreaterThan(0);
	});

	test("says in Chinese when a pasted file cannot be read", async () => {
		const { store, remembered, warnings } = files();
		store.load(6, { path: join(dir, "gone.png"), mimeType: "image/png" });
		await store.settle("[image #6]");
		expect(remembered.has(6)).toBe(false);
		expect(warnings).toEqual([expect.stringContaining("读不了这张图片")]);
	});

	test("annotates only markers with a saved file", () => {
		expect(annotateImageMarkerPaths("[image #1] [image #2]", new Map([[2, "~/p/2.png"]]))).toBe(
			"[image #1] [image #2](~/p/2.png)",
		);
	});
});

describe("paste-time notice when no model will see the image", () => {
	test("names blocked images, a missing imageModel, and an unusable one in Chinese", () => {
		expect(pastedImageProblemNotice({ kind: "blocked" }, "bailian/glm-5.3-prime")).toContain("blockImages");
		expect(pastedImageProblemNotice({ kind: "missing" }, "bailian/glm-5.3-prime")).toContain(
			"当前模型 bailian/glm-5.3-prime 看不了图",
		);
		expect(pastedImageProblemNotice({ kind: "unusable", reference: "bailian/typo" }, "x/y")).toContain(
			"「bailian/typo」用不了",
		);
		expect(pastedImageProblemNotice({ kind: "native" }, "x/y")).toBeUndefined();
	});
});
