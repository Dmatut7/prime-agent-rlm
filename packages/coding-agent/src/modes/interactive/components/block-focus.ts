import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/**
 * Zero-width marker a focused block puts on its first row in fullscreen, so the
 * viewport can scroll that row into view. It is an APC string: terminals ignore
 * it, and the viewport strips it before painting.
 */
export const BLOCK_REVEAL_MARKER = "\x1b_pi:block-focus\x07";

/** How a conversation block is drawn while block navigation has it focused. */
export interface BlockFocusState {
	/** Put the reveal marker on the first row (fullscreen only). */
	reveal: boolean;
}

/** A conversation block that block navigation can focus, toggle and copy. */
export interface FocusableBlock {
	setBlockFocus(state: BlockFocusState | undefined): void;
	/** The text `y` copies: the block's own source, not its rendered decoration. */
	getBlockCopyText(): string;
}

export function isFocusableBlock(component: unknown): component is FocusableBlock & Component {
	return (
		typeof component === "object" &&
		component !== null &&
		typeof (component as Partial<FocusableBlock>).setBlockFocus === "function" &&
		typeof (component as Partial<FocusableBlock>).getBlockCopyText === "function"
	);
}

/** `Enter 展开 · y 复制 · Esc 返回`, from the live keybindings. */
export function blockFocusHint(): string {
	const parts: string[] = [];
	const toggle = keyText("app.blocks.toggle", { primaryOnly: true });
	const copy = keyText("app.blocks.copy", { primaryOnly: true });
	const exit = keyText("app.blocks.exit", { primaryOnly: true });
	if (toggle) parts.push(`${toggle} 展开`);
	if (copy) parts.push(`${copy} 复制`);
	if (exit) parts.push(`${exit} 返回`);
	return parts.join(" · ");
}

/** Trailing spaces, with any styling escapes that follow them kept. */
const TRAILING_PADDING = / +((?:\x1b\[[0-9;]*m)*)$/;

/**
 * The focused look: every row on the selection background, the key hint
 * right-aligned on the first non-empty row, and the reveal marker in front.
 */
export function decorateFocusedBlock(lines: readonly string[], width: number, state: BlockFocusState): string[] {
	const paint = theme.getSelectionBackgroundColor();
	const hint = blockFocusHint();
	const firstContent = lines.findIndex(isVisibleRow);
	return lines.map((line, index) => {
		let row = truncateToWidth(line, width, "");
		if (index === firstContent && hint) {
			// Rows often arrive padded to full width; the hint takes the padding's place.
			row = row.replace(TRAILING_PADDING, "$1");
			const room = width - visibleWidth(row) - visibleWidth(hint) - 1;
			if (room >= 2) {
				row = `${row}${" ".repeat(room)}${theme.fg("dim", hint)} `;
			}
		}
		const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
		const painted = paint(padded);
		return index === Math.max(0, firstContent) && state.reveal ? `${BLOCK_REVEAL_MARKER}${painted}` : painted;
	});
}

/** Whether a rendered row shows anything: styling escapes and spaces alone do not count. */
export function isVisibleRow(line: string): boolean {
	return stripAnsi(line).trim().length > 0;
}

export interface BlockNavigatorHandlers {
	move(direction: -1 | 1): void;
	toggle(): void;
	copy(): void;
	/** Leave block navigation; `passThrough` is a key the prompt should receive. */
	exit(passThrough?: string): void;
}

/**
 * The focus owner while block navigation runs. It renders nothing itself: the
 * focused block draws the highlight. Every key it does not own leaves the mode
 * and goes to the prompt, so typing never gets swallowed.
 */
export class BlockNavigator implements Component, Focusable {
	focused = false;

	constructor(private readonly handlers: BlockNavigatorHandlers) {}

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {
		// Nothing cached: the navigator draws no rows.
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "app.blocks.prev") || keys.matches(data, "tui.select.up")) {
			this.handlers.move(-1);
		} else if (keys.matches(data, "app.blocks.next") || keys.matches(data, "tui.select.down")) {
			this.handlers.move(1);
		} else if (keys.matches(data, "app.blocks.toggle")) {
			this.handlers.toggle();
		} else if (keys.matches(data, "app.blocks.copy")) {
			this.handlers.copy();
		} else if (keys.matches(data, "app.blocks.exit")) {
			this.handlers.exit();
		} else {
			this.handlers.exit(data);
		}
	}
}
