import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { SystemNoticeLine } from "./system-notice.js";
import { boxRecordFromMessage } from "./turn-timeline.js";

/** Renders a durable unsuccessful automatic-compaction outcome. */
export class CompactionOutcomeMessageComponent extends Container {
	/** `quiet`: the quiet conversation says it in one faint line in plain words. */
	constructor(message: CompactionOutcomeMessage, options: { quiet?: boolean } = {}) {
		super();
		if (options.quiet) {
			const record = boxRecordFromMessage(message);
			const facts = record?.kind === "compaction" ? record.facts : undefined;
			const label =
				message.details.outcome === "cancelled"
					? "⇣ 已取消整理上下文"
					: facts?.skipped
						? "⇣ 暂不整理上下文"
						: "⇣ 上下文没整理成";
			const detail = message.details.outcome === "cancelled" ? "" : (facts?.failed ?? "");
			this.addChild(new Spacer(1));
			this.addChild(
				new SystemNoticeLine(label, detail, "", message.details.outcome === "failed" ? "error" : "notice"),
			);
			return;
		}
		const color = message.details.outcome === "skipped" ? "warning" : "error";
		const contentBox = new Box(2, 1, (text: string) => theme.getUserMessageBackgroundColor()(text));
		contentBox.addChild(new Text(theme.fg(color, message.content), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}

export class MalformedCompactionOutcomeMessageComponent extends Container {
	constructor() {
		super();
		const contentBox = new Box(2, 1, (text: string) => theme.getUserMessageBackgroundColor()(text));
		contentBox.addChild(new Text(theme.fg("error", "[Malformed compaction outcome message]"), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}
