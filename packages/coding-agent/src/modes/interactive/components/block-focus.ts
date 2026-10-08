import {
	CONTENT_START_MARKER,
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
 * The inline background codes a rendered block row can carry: an SGR background
 * set (`\x1b[48;…m`, 256-color or truecolor) and the background reset (`\x1b[49m`).
 */
const INLINE_BG_SET = /\x1b\[48;[0-9;]*m/g;
const INLINE_BG_RESET = /\x1b\[49m/g;

/** Least columns of its own a row keeps when the hint takes the rest; a narrower terminal keeps the row whole. */
const HINT_CUT_MIN_COLS = 4;

/**
 * The focused look: every row on the selection background, the key hint
 * right-aligned on the first row that shows content (a row of timeline gutter
 * alone does not), and the reveal marker in front.
 */
export function decorateFocusedBlock(lines: readonly string[], width: number, state: BlockFocusState): string[] {
	const paint = theme.getSelectionBackgroundColor();
	// The selection background must win the whole row. A block with its own
	// background (a tool panel, a user bubble) otherwise keeps it: an inline
	// `48;…` set paints over the selection, and an inline `49` reset drops to the
	// terminal default for the rest of the row. Restate the selection background
	// where those codes sat.
	const paintedEmpty = paint("");
	const selectionOpen = paintedEmpty.endsWith("\x1b[49m") ? paintedEmpty.slice(0, -"\x1b[49m".length) : paintedEmpty;
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
			} else if (width - visibleWidth(hint) - 2 >= HINT_CUT_MIN_COLS) {
				// A row that already fills the terminal gives its last columns to the hint: a hint
				// nobody can see tells the owner less than a row cut short does, and the block's own
				// text is one key press away. A terminal too narrow for both keeps the row.
				row = `${truncateToWidth(row, width - visibleWidth(hint) - 2, "…")}${theme.fg("dim", hint)} `;
			}
		}
		const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
		const painted = paint(padded.replace(INLINE_BG_SET, selectionOpen).replace(INLINE_BG_RESET, selectionOpen));
		return index === Math.max(0, firstContent) && state.reveal ? `${BLOCK_REVEAL_MARKER}${painted}` : painted;
	});
}

/** Zero-width markers a row can carry (the content mark, a reveal mark): never content. */
const ZERO_WIDTH_MARKS = /\x1b_[^\x07]*\x07/g;

/**
 * A rendered row's own words: its timeline gutter (the time, the rails), its styling escapes, its
 * zero-width markers and nothing else. Every caller that asks what a row *shows* reads it this way,
 * so a row that is only gutter never counts as content.
 */
export function rowWords(line: string): string {
	return stripAnsi(withoutGutter(line)).replace(ZERO_WIDTH_MARKS, "");
}

/** Whether a rendered row shows anything: gutter, styling escapes, markers and spaces alone do not count. */
export function isVisibleRow(line: string): boolean {
	return rowWords(line).trim().length > 0;
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

	/**
	 * False for transient notices (a startup warning): block navigation can
	 * still walk onto the row, but entering navigation never starts on it — a
	 * one-row notice often has no room for the key hint, so landing there reads
	 * as a dead keypress.
	 */
	navigationEntryTarget = true;

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

/** A rendered row from where its content starts: what a timeline row's time and rails leave out of a copy. */
export function withoutGutter(line: string): string {
	const at = line.indexOf(CONTENT_START_MARKER);
	return at === -1 ? line : line.slice(at + CONTENT_START_MARKER.length);
}

/** Blank lines at the two ends of a text, which carry nothing; the ones inside are paragraph breaks. */
function tidyBlock(text: string): string {
	const lines = text.split("\n");
	while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
	while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
	return lines.join("\n");
}

/**
 * What `y` copies: the parts of the block's own source, blank line apart. A card that holds the text
 * it renders (a skill body, a compaction summary, a memory) copies that text, so its indentation and
 * its paragraph breaks survive; only a card with no source falls back to its rendered rows.
 */
export function copyFromSource(...parts: ReadonlyArray<string | undefined>): string {
	return parts
		.map((part) => (part === undefined ? "" : tidyBlock(part.replace(/\r\n/g, "\n"))))
		.filter((part) => part.length > 0)
		.join("\n\n");
}

/**
 * Plain text of rendered rows: styling, markers and the timeline gutter stripped. A row keeps its own
 * indentation and the blank rows between paragraphs stay - a copy that trims every row flattens the
 * code and the paragraphs of what it copied.
 */
export function renderedCopyText(lines: readonly string[]): string {
	return tidyBlock(lines.map((line) => rowWords(line).trimEnd()).join("\n"));
}

/**
 * The row `target` starts on when `components` render one after another,
 * descending into plain containers; undefined when it is not among them.
 *
 * Render-safety of the measurement probe (display audit item 39, judged an
 * observation record): the walk returns at the target before rendering it, so it
 * only ever renders the target's older siblings. Its sole caller passes the
 * fullscreen scroll components, where the chat container is the first child of
 * the main view — so the probe renders only the header chrome, never the chat
 * blocks, and cannot spend a one-shot marker (an armed reveal marker) the next
 * frame owns. The same render-to-measure pattern over chat children lives in
 * `measureBlockRows` (interactive-mode), which routes turn summaries through
 * `renderForMeasurement` for exactly that marker; extend that pattern, not this
 * probe, if a one-shot ever moves into the header chrome.
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
