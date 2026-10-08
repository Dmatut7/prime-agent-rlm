import type { Component } from "../tui.js";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	// Stable identity: a fresh array per render defeats the line aggregator's
	// unchanged-output check and rebuilds the whole transcript line list.
	private cached: string[] = [];

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		if (this.cached.length !== this.lines) {
			this.cached = Array.from({ length: this.lines }, () => "");
		}
		return this.cached;
	}
}
