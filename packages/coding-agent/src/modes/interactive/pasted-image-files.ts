/**
 * Files behind pasted images. A Ctrl+V image lives only in the prompt's bytes, so once
 * those leave a model's context (a text-only model gets a placeholder, a resumed
 * session, a later question about it) nothing can look at it again; saving it under the
 * session's artifact directory and naming that path next to its marker lets the model
 * re-attach it. A pasted image file path is loaded and attached like a Ctrl+V image.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ImageModelRoute } from "../../core/image-model-routing.js";
import { resizeImage } from "../../utils/image-resize.js";
import { annotateImageMarkerPaths, imageMarkerIds } from "./image-markers.js";
import { displayPath } from "./pasted-image-paths.js";

const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

export interface PastedImageFilesHost {
	/** Register a loaded image under its marker (the pasted-image registry). */
	remember(markerId: number, image: ImageContent): void;
	/** Tell the owner a pasted image could not be attached. */
	warn(message: string): void;
}

export class PastedImageFiles {
	private readonly savedPaths = new Map<number, string>();
	private readonly pending = new Map<number, Promise<void>>();

	constructor(private readonly host: PastedImageFilesHost) {}

	/**
	 * Save a clipboard image to `dir`; the path is known at once, so a message sent
	 * before the write lands still names it. A failed write drops the path again.
	 */
	save(markerId: number, image: ImageContent, dir: string | undefined): void {
		if (!dir) return;
		const extension = EXTENSION_BY_MIME[image.mimeType] ?? "png";
		const digest = createHash("sha256").update(image.data).digest("hex").slice(0, 8);
		const file = join(dir, `image-${markerId}-${digest}.${extension}`);
		this.savedPaths.set(markerId, displayPath(file));
		const write = (async () => {
			try {
				await mkdir(dir, { recursive: true, mode: 0o700 });
				await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
			} catch {
				this.savedPaths.delete(markerId);
			}
		})();
		this.track(markerId, write);
	}

	/** Read, resize and register an image file the owner pasted or dropped as a path. */
	load(markerId: number, file: { path: string; mimeType: string }): void {
		const load = (async () => {
			try {
				const raw: ImageContent = {
					type: "image",
					data: (await readFile(file.path)).toString("base64"),
					mimeType: file.mimeType,
				};
				const resized = await resizeImage(raw);
				if (!resized) {
					this.host.warn(`图片太大，压不到能发送的大小，没有附加：${displayPath(file.path)}`);
					return;
				}
				this.host.remember(markerId, { type: "image", data: resized.data, mimeType: resized.mimeType });
			} catch {
				this.host.warn(`读不了这张图片，没有附加：${displayPath(file.path)}`);
			}
		})();
		this.track(markerId, load);
	}

	/** Whether an image whose marker is in `text` is still being loaded or saved. */
	hasPending(text: string): boolean {
		return imageMarkerIds(text).some((markerId) => this.pending.has(markerId));
	}

	/** Wait for the images whose markers are in `text` to be loaded and saved. */
	async settle(text: string): Promise<void> {
		await Promise.all(imageMarkerIds(text).map((markerId) => this.pending.get(markerId)));
	}

	/** `text` as sent: each saved clipboard image's path next to its marker. */
	annotate(text: string): string {
		return annotateImageMarkerPaths(text, this.savedPaths);
	}

	private track(markerId: number, work: Promise<void>): void {
		const settled = work.finally(() => {
			if (this.pending.get(markerId) === settled) this.pending.delete(markerId);
		});
		this.pending.set(markerId, settled);
	}
}

/**
 * The Chinese notice for a pasted image no model will see, or undefined when the
 * session model or the configured imageModel reads it.
 */
export function pastedImageProblemNotice(route: ImageModelRoute, sessionModelLabel: string): string | undefined {
	switch (route.kind) {
		case "blocked":
			return "图片在设置里关掉了（settings.json 的 images.blockImages），模型看不到这张图。";
		case "missing":
			return `当前模型 ${sessionModelLabel} 看不了图，也没设看图模型：在 settings.json 里设 imageModel，不然这条消息发出去会报错。`;
		case "unusable":
			return `看图模型 imageModel「${route.reference}」用不了（找不到、不支持看图或没登录），这条消息发出去会报错：改一下 settings.json 里的 imageModel，或登录它的服务商。`;
		default:
			return undefined;
	}
}
