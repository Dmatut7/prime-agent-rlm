import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = [this.color("─".repeat(Math.max(1, width)))];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
