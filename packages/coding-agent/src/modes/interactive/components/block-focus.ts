import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
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
	/** What the toggle key does to this block (`展开`, `收起`); absent when it does nothing here. */
	toggleLabel?: string;
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

/** A block whose own expanded state the toggle key flips (a notice card). */
export interface ExpandableBlock {
	isBlockExpanded(): boolean;
	setExpanded(expanded: boolean): void;
}

export function isExpandableBlock(component: unknown): component is ExpandableBlock {
	return (
		typeof component === "object" &&
		component !== null &&
		typeof (component as Partial<ExpandableBlock>).isBlockExpanded === "function" &&
		typeof (component as Partial<ExpandableBlock>).setExpanded === "function"
	);
}

/**
 * `Enter 展开 · Y 复制 · Esc 返回`, from the live keybindings. The toggle part
 * only shows with a label: a block the toggle key does nothing to says so by
 * leaving it out.
 */
export function blockFocusHint(toggleLabel?: string): string {
	const parts: string[] = [];
	const toggle = keyText("app.blocks.toggle", { primaryOnly: true });
	const copy = keyText("app.blocks.copy", { primaryOnly: true });
	const exit = keyText("app.blocks.exit", { primaryOnly: true });
	if (toggle && toggleLabel) parts.push(`${toggle} ${toggleLabel}`);
	if (copy) parts.push(`${copy} 复制`);
	if (exit) parts.push(`${exit} 返回`);
	return parts.join(" · ");
}

/** The block-navigation keys for the shortcut panels: `Enter 展开 · Y 复制 · Esc 返回`. */
export function blockNavigationKeysText(): string {
	return blockFocusHint("展开");
}

/** Trailing spaces, with any styling escapes that follow them kept. */
const TRAILING_PADDING = / +((?:\x1b\[[0-9;]*m)*)$/;

/**
 * The focused look: every row on the selection background, the key hint
 * right-aligned on the first non-empty row, and the reveal marker in front.
 */
export function decorateFocusedBlock(lines: readonly string[], width: number, state: BlockFocusState): string[] {
	const paint = theme.getSelectionBackgroundColor();
	const hint = blockFocusHint(state.toggleLabel);
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
	/** Focus moved to something else (a dialog, a panel) while navigating. */
	blur(): void;
}

/**
 * The focus owner while block navigation runs. It renders nothing itself: the
 * focused block draws the highlight. Every key it does not own leaves the mode
 * and goes to the prompt, so typing never gets swallowed.
 */
export class BlockNavigator implements Component, Focusable {
	private hasFocus = false;
	private active = true;

	constructor(private readonly handlers: BlockNavigatorHandlers) {}

	get focused(): boolean {
		return this.hasFocus;
	}

	/**
	 * Losing focus ends the navigation: a dialog answered while navigating hands
	 * focus to the prompt, and nothing else would ever clear the highlight. The
	 * check waits a microtask because the TUI re-sets focus by clearing it
	 * first. A finished navigator that gets focus back (an overlay restoring
	 * what it covered) hands it straight on to the prompt.
	 */
	set focused(value: boolean) {
		const lost = this.hasFocus && !value;
		const regained = !this.hasFocus && value;
		this.hasFocus = value;
		if (lost && this.active) {
			queueMicrotask(() => {
				if (!this.hasFocus && this.active) this.handlers.blur();
			});
		} else if (regained && !this.active) {
			queueMicrotask(() => {
				if (this.hasFocus && !this.active) this.handlers.exit();
			});
		}
	}

	/** Navigation ended: from now on every key goes back to the prompt. */
	deactivate(): void {
		this.active = false;
	}

	get isActive(): boolean {
		return this.active;
	}

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {
		// Nothing cached: the navigator draws no rows.
	}

	handleInput(data: string): void {
		if (!this.active) {
			this.handlers.exit(data);
			return;
		}
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

/**
 * A one-block chat row (an `出错：…` line, a warning) that block navigation can
 * focus and copy; `copyText` is the row without its styling.
 */
export class FocusableTextBlock extends Text implements FocusableBlock {
	private blockFocus?: BlockFocusState;

	constructor(
		text: string,
		private readonly copyText: string,
		paddingX = 1,
		paddingY = 0,
	) {
		super(text, paddingX, paddingY);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	getBlockCopyText(): string {
		return this.copyText;
	}
}

/** Plain text of rendered rows: styling and markers stripped, blank rows dropped. */
export function renderedCopyText(lines: readonly string[]): string {
	return lines
		.map((line) =>
			stripAnsi(line)
				.replace(/\x1b_[^\x07]*\x07/g, "")
				.trimEnd(),
		)
		.filter((line) => line.trim().length > 0)
		.map((line) => line.trim())
		.join("\n");
}

/**
 * The row `target` starts on when `components` render one after another,
 * descending into plain containers; undefined when it is not among them.
 */
export function componentRowOffset(
	components: readonly Component[],
	target: Component,
	width: number,
): number | undefined {
	let row = 0;
	for (const component of components) {
		if (component === target) return row;
		if (component instanceof Container && component.constructor === Container) {
			const inner = componentRowOffset(component.children, target, width);
			if (inner !== undefined) return row + inner;
		}
		row += component.render(width).length;
	}
	return undefined;
}
