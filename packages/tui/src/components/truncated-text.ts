import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const result: string[] = [];

		const emptyLine = " ".repeat(width);

		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		const availableWidth = Math.max(1, width - this.paddingX * 2);

		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		const displayText = truncateToWidth(singleLineText, availableWidth);

		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result;
	}
}
