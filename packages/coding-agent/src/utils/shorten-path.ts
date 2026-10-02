import * as os from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Contract `path` to tilde notation when it lives under the user's home
 * directory; non-string input shortens to an empty string.
 */
export function shortenPathHome(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export interface ShortenPathToWidthOptions {
	/**
	 * Cap on how many trailing segments an absolute path may keep; relative
	 * paths always keep as many as fit. Default: uncapped.
	 */
	absoluteMaxSegments?: number;
	/** Drop empty segments (`a//b`, trailing slash) before shortening. */
	filterEmptySegments?: boolean;
}

/**
 * Cut a path from the left at directory boundaries until it fits `width`
 * columns (`…/components/turn-strip.ts`, then `…/turn-strip.ts`); a file name
 * that alone is too wide is cut at its end. Keeps as many trailing segments
 * as fit, subject to the options above.
 */
export function shortenPathToWidth(path: string, width: number, options: ShortenPathToWidthOptions = {}): string {
	if (visibleWidth(path) <= width) return path;
	const parts = options.filterEmptySegments ? path.split("/").filter((part) => part.length > 0) : path.split("/");
	const cap = path.startsWith("/") ? (options.absoluteMaxSegments ?? parts.length - 1) : parts.length - 1;
	for (let keep = Math.min(cap, parts.length - 1); keep >= 1; keep--) {
		const candidate = `…/${parts.slice(-keep).join("/")}`;
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth(parts.at(-1) ?? path, width, "…");
}
