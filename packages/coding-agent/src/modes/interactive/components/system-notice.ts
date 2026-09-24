import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * v3 chat layers: a routine system notice (memory updated, the Python kernel
 * restored, an automatic continue) as one centered, very faint line -
 * `·  ✦ memory updated  <summary>  ·  Ctrl+O diff  ·` - the way a chat app
 * says "someone joined", so it never competes with the user or the AI.
 */
export class SystemNoticeLine implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	/** `error`: something went wrong (a memory write that failed) - it must not read as routine. */
	constructor(
		private readonly label: string,
		private readonly detail = "",
		private readonly hint = "",
		private readonly tone: "notice" | "error" = "notice",
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		const frame = "·  ";
		const tail = this.hint ? `  ·  ${this.hint}  ·` : "  ·";
		const fixed = visibleWidth(frame) + visibleWidth(this.label) + visibleWidth(tail);
		const room = safeWidth - fixed - 2;
		const detail = this.detail && room >= 8 ? `  ${truncateToWidth(this.detail, room, "…")}` : "";
		const plain = truncateToWidth(`${frame}${this.label}${detail}${tail}`, safeWidth, "…");
		const left = Math.max(0, Math.floor((safeWidth - visibleWidth(plain)) / 2));
		const lines = [" ".repeat(left) + theme.fg(this.tone === "error" ? "error" : "systemNotice", plain)];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
