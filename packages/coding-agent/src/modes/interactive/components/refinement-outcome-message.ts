import { Clickable, Spacer, Text } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";
import { keyText } from "./keybinding-hints.js";
import { SystemNoticeLine } from "./system-notice.js";

function editableEntry(entry: HarnessEntry): Record<string, unknown> {
	return {
		title: entry.title,
		content: entry.content,
		path: entry.path,
		reference: entry.reference,
		arguments: entry.arguments,
		metadata: entry.metadata,
	};
}

function proposedEntry(edit: AppliedRefinementEdit): Record<string, unknown> {
	return {
		...(edit.title === undefined ? {} : { title: edit.title }),
		...(edit.content === undefined ? {} : { content: edit.content }),
		...(edit.path === undefined ? {} : { path: edit.path }),
		...(edit.reference === undefined ? {} : { reference: edit.reference }),
		...(edit.arguments === undefined ? {} : { arguments: edit.arguments }),
		...(edit.metadata === undefined ? {} : { metadata: edit.metadata }),
	};
}

function entryText(entry: Record<string, unknown> | undefined): string {
	return entry === undefined ? "" : `${JSON.stringify(entry, null, 2)}\n`;
}

function editDiff(edit: AppliedRefinementEdit): string {
	const before = edit.before ? editableEntry(edit.before) : undefined;
	const after = edit.after ? editableEntry(edit.after) : edit.action === "delete" ? undefined : proposedEntry(edit);
	return generateDiffString(entryText(before), entryText(after), 4).diff;
}

function editScope(edit: AppliedRefinementEdit, fallback: "local" | "global"): "local" | "global" {
	return edit.after?.scope ?? edit.before?.scope ?? fallback;
}

function editLabel(edit: AppliedRefinementEdit, fallbackScope: "local" | "global"): string {
	const scope = editScope(edit, fallbackScope);
	if (!edit.applied) {
		const error = edit.error ? `: ${edit.error}` : "";
		return theme.fg("error", `Failed to ${edit.action} ${scope} ${edit.kind} \`${edit.id}\`${error}`);
	}
	const verb = edit.action === "create" ? "Created" : edit.action === "update" ? "Updated" : "Deleted";
	return `${theme.fg("success", verb)} ${scope} ${edit.kind} \`${edit.id}\``;
}

function editCount(edits: AppliedRefinementEdit[]): string {
	const applied = edits.filter((edit) => edit.applied).length;
	return edits.length === applied ? `已应用 ${applied} 处修改` : `已应用 ${applied}/${edits.length} 处修改`;
}

function readableTitle(title: string | undefined): string | undefined {
	const text = title?.replace(/_+/g, " · ").replace(/\s+/g, " ").trim();
	return text || undefined;
}

/**
 * What the collapsed notice says changed: the entries' own titles (`百轮评估进度`),
 * joined, when every edit has one; otherwise the refinement's summary.
 */
function memoryNoticeDetail(summary: string, edits: readonly AppliedRefinementEdit[]): string {
	// Titles are often written as id-like slugs (`a_b_c`); the notice reads them as words.
	const titles = edits.map((edit) => readableTitle(edit.after?.title ?? edit.title ?? edit.before?.title));
	const named = titles.filter((title): title is string => Boolean(title));
	const count = edits.length > 1 ? ` · ${edits.length} 条` : "";
	if (named.length > 0 && named.length === edits.length) {
		return `${[...new Set(named)].join("、")}${count}`;
	}
	return `${summary.replace(/\s+/g, " ").trim()}${count}`;
}

/** Durable refinement outcome card: per-edit rows with before/after diffs when expanded. */
export class RefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
	constructor(private readonly message: RefinementOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const { summary, edits, scope } = this.message.details;
		const toggle = () => this.setExpanded(!this.expanded);
		// Collapsed it is a plain notice line, not a card: no tinted block around it.
		this.setBgFn(this.expanded ? (text) => theme.bg("customMessageBg", text) : undefined);
		if (!this.expanded) {
			// v3: one centered faint line. The entries' own titles name what changed in
			// plain words; the summary (the model's note, which may carry its shorthand)
			// is the fallback.
			const failed = edits.some((edit) => !edit.applied);
			const hintKey = keyText("app.tools.expand", { primaryOnly: true });
			const line = new SystemNoticeLine(
				failed ? "✦ 记忆更新部分失败" : "✦ memory updated",
				memoryNoticeDetail(summary, edits),
				hintKey ? `${hintKey} diff` : "",
				failed ? "error" : "notice",
			);
			this.addChild(new Clickable(line, toggle));
			return;
		}

		this.addChild(new Clickable(new Text(customMessageLabel("memory"), 0, 0), toggle));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("customMessageText", `${summary} · ${editCount(edits)}`), 0, 0));
		for (const edit of edits) {
			this.addChild(new Text(`${theme.fg("dim", "  ╰─ ")}${editLabel(edit, scope)}`, 0, 0));
			const diff = editDiff(edit);
			if (diff) this.addChild(new Text(renderDiff(diff), 4, 0));
		}
	}
}

export class MalformedRefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
	constructor() {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Text(theme.fg("error", "[Malformed refinement outcome message]"), 0, 0));
	}
}
