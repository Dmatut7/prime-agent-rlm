import { type Component, type Focusable, getKeybindings } from "@earendil-works/pi-tui";
import { keyText } from "./keybinding-hints.js";

export interface TurnBoxNavigatorHandlers {
	/** Move the focus one target up or down. */
	move(direction: -1 | 1): void;
	/** Scroll the box body by a page. */
	page(direction: -1 | 1): void;
	/** Enter on the focused target: open or close it. */
	activate(): void;
	/** Leave the box; `passThrough` is a key the prompt should receive. */
	exit(passThrough?: string): void;
	/** Focus moved to something else (a dialog) while in the box. */
	blur(): void;
}

/**
 * The focus owner while the keyboard walks a turn's box (`app.turn.focus`).
 * It renders nothing itself: the box draws the focused row. Every key it does
 * not own leaves the box and goes to the prompt, so typing is never swallowed.
 */
export class TurnBoxNavigator implements Component, Focusable {
	private hasFocus = false;
	private active = true;

	constructor(private readonly handlers: TurnBoxNavigatorHandlers) {}

	get focused(): boolean {
		return this.hasFocus;
	}

	/** Same contract as block navigation: losing focus ends the walk; a finished navigator hands focus on. */
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
		// Draws nothing.
	}

	handleInput(data: string): void {
		if (!this.active) {
			this.handlers.exit(data);
			return;
		}
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.up")) {
			this.handlers.move(-1);
		} else if (keys.matches(data, "tui.select.down")) {
			this.handlers.move(1);
		} else if (keys.matches(data, "tui.select.pageUp")) {
			this.handlers.page(-1);
		} else if (keys.matches(data, "tui.select.pageDown")) {
			this.handlers.page(1);
		} else if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "app.blocks.toggle")) {
			this.handlers.activate();
		} else if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.turn.focus")) {
			this.handlers.exit();
		} else {
			this.handlers.exit(data);
		}
	}
}

/** The one-line hint shown on the prompt's rule while the box has the keyboard. */
export function turnBoxFocusHints(): string[] {
	const up = keyText("tui.select.up", { primaryOnly: true });
	const down = keyText("tui.select.down", { primaryOnly: true });
	const confirm = keyText("tui.select.confirm", { primaryOnly: true });
	const cancel = keyText("tui.select.cancel", { primaryOnly: true });
	return [
		up && down ? `${up}${down} 选` : "",
		confirm ? `${confirm} 展开/收起` : "",
		cancel ? `${cancel} 退出` : "",
	].filter((hint) => hint.length > 0);
}
