import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface UserMessageItem {
	id: string;
	text: string;
	timestamp?: string;
}

class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	/**
	 * Rows the whole selector may occupy (terminal height minus the dock's other
	 * members). Each entry renders three lines, so the count must shrink on short
	 * terminals instead of scrolling the selection out of the clipped dock.
	 */
	public getAvailableRows?: () => number;

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// Session history is chronological; default to the latest fork point.
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	private readonly chromeRows = 8;

	private effectiveMaxVisible(): number {
		const rows = this.getAvailableRows?.() ?? 30;
		// Title + hint + spacers + borders (chromeRows) plus three lines per entry;
		// always keep at least one entry visible.
		return Math.max(1, Math.min(10, Math.floor((rows - this.chromeRows) / 3)));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		const maxVisible = this.effectiveMaxVisible();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.messages.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.messages.length);

		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2;
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			const position = i + 1;
			const metadata = `  第 ${position} / ${this.messages.length} 条`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push("");
		}

		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
		getAvailableRows?: () => number,
	) {
		super();

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("从这条消息分叉"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "选一条你的消息，把到那里为止的对话复制成新会话"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;
		this.messageList.getAvailableRows = getAvailableRows;

		this.addChild(this.messageList);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
