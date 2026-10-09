import { getKeybindings } from "@earendil-works/pi-tui";
import { ExtensionSelectorComponent, type ExtensionSelectorOptions } from "./extension-selector.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface ProjectTrustSelectorOptions extends ExtensionSelectorOptions {
	/**
	 * Invoked when the app's interrupt-and-exit key (app.clear, Ctrl+C by
	 * default) lands in this selector. The shared cancel binding folds Ctrl+C
	 * into Escape, but a dismissed trust prompt means "untrusted, keep
	 * running" - the one answer an interrupt must never give silently - so
	 * the trust prompt routes the interrupt key to a clean exit instead.
	 */
	onInterrupt: () => void;
}

/** Hint for the keys that still dismiss the prompt (cancel minus interrupt keys). */
function dismissHint(): string {
	const kb = getKeybindings();
	const interruptKeys = kb.getKeys("app.clear");
	const dismissKeys = kb.getKeys("tui.select.cancel").filter((key) => !interruptKeys.includes(key));
	if (dismissKeys.length === 0) {
		return keyHint("tui.select.cancel", "取消");
	}
	return rawKeyHint(dismissKeys.join("/"), "取消");
}

/**
 * The project-trust prompt's selector: same list semantics as the extension
 * selector, except the interrupt key exits the process instead of dismissing.
 * The footer labels the two separately so Ctrl+C is not advertised as cancel.
 */
export class ProjectTrustSelectorComponent extends ExtensionSelectorComponent {
	private readonly onInterrupt: () => void;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts: ProjectTrustSelectorOptions,
	) {
		super(title, options, onSelect, onCancel, {
			...opts,
			cancelHint: opts.cancelHint ?? dismissHint(),
			extraHint: opts.extraHint ?? keyHint("app.clear", "退出"),
		});
		this.onInterrupt = opts.onInterrupt;
	}

	override handleInput(keyData: string): void {
		if (getKeybindings().matches(keyData, "app.clear")) {
			this.onInterrupt();
			return;
		}
		super.handleInput(keyData);
	}
}
