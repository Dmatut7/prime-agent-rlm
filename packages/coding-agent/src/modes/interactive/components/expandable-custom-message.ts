import { Box } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import {
	type BlockFocusState,
	decorateFocusedBlock,
	type ExpandableBlock,
	type FocusableBlock,
	renderedCopyText,
} from "./block-focus.js";

/**
 * Shared skeleton for boxed custom-message cards (compaction, skill,
 * refinement) with a collapsed/expanded state driven by the shared
 * tool-output expansion toggle.
 */
export abstract class ExpandableCustomMessageBox extends Box implements FocusableBlock, ExpandableBlock {
	protected expanded = false;
	private blockFocus?: BlockFocusState;

	constructor() {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	isBlockExpanded(): boolean {
		return this.expanded;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	getBlockCopyText(): string {
		return renderedCopyText(super.render(100));
	}

	protected abstract updateDisplay(): void;
}

/** Bold custom-message label like `[refinement]`. */
export function customMessageLabel(name: string): string {
	return theme.fg("customMessageLabel", `\x1b[1m[${name}]\x1b[22m`);
}
