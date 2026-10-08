import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Clickable, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.js";
import type { CustomMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		this.addChild(new Spacer(1));

		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
				if (component) {
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall back to the default renderer.
			}
		}

		this.addChild(this.box);
		this.box.clear();

		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Clickable(new Text(label, 0, 0), () => this.setExpanded(!this._expanded)));
		this.box.addChild(new Spacer(1));

		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else if (Array.isArray(this.message.content)) {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		} else {
			// A transcript written before the write-side shape check (or by a tool
			// that bypassed it) can hold a message with no usable content. The row
			// says so instead of taking the whole replay down with a TypeError.
			text = "[malformed message: no readable content]";
		}

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
