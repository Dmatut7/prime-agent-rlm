import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/**
 * U6: the single global expand-hint line at the conversation's tail. Every
 * per-line `(Ctrl+O 展开)` suffix is gone; this one dim line states the
 * boss's two-key division instead: `Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 消息`.
 */
export class ExpandKeysHintLine implements Component {
	constructor(private readonly hasChatContent: () => boolean = () => true) {}

	invalidate(): void {
		// Render output is derived from live getters and the keybinding table.
	}

	render(width: number): string[] {
		if (!this.hasChatContent()) {
			return [];
		}
		const thinking = keyText("app.thinking.toggle");
		const process = keyText("app.tools.expand");
		const messages = keyText("app.messages.expand");
		if (!thinking && !process && !messages) {
			return [];
		}
		const parts = [
			thinking ? `${thinking} 思考` : undefined,
			process ? `${process} 过程` : undefined,
			messages ? `${messages} 消息` : undefined,
		].filter((part): part is string => part !== undefined);
		const safeWidth = Math.max(1, width);
		const line = theme.fg("dim", truncateToWidth(` ${parts.join(" · ")}`, safeWidth, ""));
		return [line];
	}
}
