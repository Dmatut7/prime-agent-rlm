import { fuzzyFilter } from "../fuzzy.js";
import { getKeybindings, type KeybindingsManager } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { Input } from "./input.js";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
	/** Display text for a stored value (e.g. a translation); the stored value itself is unchanged. */
	formatValue?: (value: string) => string;
}

/** The value column never shrinks below this; labels truncate instead. */
const VALUE_MIN_WIDTH = 8;
/** Wrapped description rows shown under the list before an ellipsis takes over. */
const MAX_DESCRIPTION_ROWS = 3;

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;
	/** The query the current filteredItems/selectedIndex were computed for. */
	private appliedQuery = "";
	private formatValue: (value: string) => string;

	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.formatValue = options.formatValue ?? ((value) => value);
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  没有可设置的项"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  没有匹配的设置"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// The label column yields before the value column does: below the floor the
		// label truncates, so an over-wide label can never squeeze the value out.
		const widestLabel = Math.max(...this.items.map((item) => visibleWidth(item.label)));
		const maxLabelWidth = Math.max(4, Math.min(30, widestLabel, width - 2 - 2 - VALUE_MIN_WIDTH));

		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			const labelCell = truncateToWidth(item.label, maxLabelWidth, "…");
			const labelPadded = labelCell + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(labelCell)));
			const labelText = this.theme.label(labelPadded, isSelected);

			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(
				truncateToWidth(this.formatValue(item.currentValue), valueMaxWidth, ""),
				isSelected,
			);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			// The description lives under the list without a window of its own: cap
			// it so a long one cannot push the list past the host's row budget.
			const shown = wrappedDesc.slice(0, MAX_DESCRIPTION_ROWS);
			for (let i = 0; i < shown.length; i++) {
				const line = shown[i]!;
				const cut = i === shown.length - 1 && wrappedDesc.length > shown.length;
				lines.push(this.theme.description(`  ${line}${cut ? " …" : ""}`));
			}
		}

		this.addHintLine(lines, width);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			// Clamp instead of wrap: a burst or held arrow key must never teleport
			// the selection to the far end of the list. A wrap on a short list
			// reads as "the keys stopped working" once the burst outruns the item
			// count (30 rapid downs on a 27-item panel land back near the top).
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = Math.min(displayItems.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.toggle") && !this.searchEnabled) {
			// While searching, the query owns printable characters: a space is
			// search text (labels contain spaces), not "toggle the selected
			// setting" - otherwise every typed space silently cycles whichever
			// setting the filter happens to have selected. Enter still activates.
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel") || this.isBackKey(kb, data)) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/**
	 * Left is back ("app.modal.back"), the convention every selector submenu
	 * already follows. The search query keeps the key for cursor movement
	 * while its cursor sits past column 0; with no text field (or the cursor
	 * at column 0) left closes the panel instead of silently falling through
	 * to the filter, which used to reset the selection to the first item.
	 */
	private isBackKey(kb: KeybindingsManager, data: string): boolean {
		if (!kb.matches(data, "app.modal.back")) return false;
		return this.searchInput === undefined || this.searchInput.getCursor() === 0;
	}

	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		// A key that edits the query without changing it (left moving the
		// cursor inside the text) must not reset the selection: the rows it
		// filtered are the same rows. Only a changed query restarts at the top.
		if (query === this.appliedQuery) return;
		this.appliedQuery = query;
		// The id keeps search working in English when labels are translated.
		this.filteredItems = fuzzyFilter(this.items, query, (item) => `${item.label} ${item.id}`);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled ? "  输入可搜索 · Enter 修改 · Esc 取消" : "  Enter/空格 修改 · Esc 取消",
				),
				width,
			),
		);
	}
}
