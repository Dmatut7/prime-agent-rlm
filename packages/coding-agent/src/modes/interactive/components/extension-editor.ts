import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import { createPrivateTempFile, readPrivateFile } from "../../../utils/private-files.js";
import { splitShellWords } from "../../../utils/shell.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "提交") +
			"  " +
			keyHint("tui.input.newLine", "换行") +
			"  " +
			keyHint("tui.select.cancel", "取消") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "外部编辑器")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		if (this.keybindings.matches(keyData, "app.editor.external")) {
			this.openExternalEditor();
			return;
		}

		this.editor.handleInput(keyData);
	}

	private openExternalEditor(): void {
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			return;
		}

		// Shell words, not a raw space split: a quoted path with spaces
		// ("/Applications/My Editor.app/bin/edit") is one argv word.
		const editorWords = splitShellWords(editorCmd);
		const editor = editorWords[0];
		if (!editor) {
			this.showErrorLine("编辑器命令为空。请检查 $VISUAL 或 $EDITOR 环境变量。");
			return;
		}

		const currentText = this.editor.getText();
		const temp = createPrivateTempFile("pi-extension-editor-", ".md", currentText);
		const tmpFile = temp.path;
		let spawnFailure: string | undefined;

		try {
			this.tui.stop();

			const result = spawnSync(editor, [...editorWords.slice(1), tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			if (result.status === 0) {
				const newContent = readPrivateFile(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			} else if (result.error) {
				// The editor never ran (bad path, ENOENT): say so instead of failing
				// silently. A non-zero exit is the editor's own "abort" and stays quiet.
				spawnFailure = `外部编辑器没能启动：${result.error.message}`;
			}
		} finally {
			try {
				fs.rmSync(temp.directory, { recursive: true, force: true });
			} finally {
				this.tui.start();
				// Force full re-render since external editor uses alternate screen
				this.tui.requestRender(true);
			}
		}

		if (spawnFailure) {
			this.showErrorLine(spawnFailure);
		}
	}

	/** An error row above the bottom border; the dialog stays open with the draft intact. */
	private showErrorLine(message: string): void {
		const bottom = this.children.at(-1);
		if (bottom) this.removeChild(bottom);
		this.addChild(new Text(theme.fg("error", message), 1, 0));
		if (bottom) this.addChild(bottom);
		this.tui.requestRender();
	}
}
