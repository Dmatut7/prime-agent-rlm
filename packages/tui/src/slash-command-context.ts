export type SlashCommandContext =
	| { kind: "name"; prefix: string; isAtPromptStart: boolean }
	| { kind: "argument"; commandName: string; prefix: string; isAtPromptStart: true };

export function getSlashCommandContext(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): SlashCommandContext | null {
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const trimmedStart = textBeforeCursor.trimStart();

	if (cursorLine === 0 && trimmedStart.startsWith("/")) {
		// Same class parseSlashCommand splits on (/\s+/): an NBSP or any other
		// Unicode space ends the command token for the executor, so it must end it
		// for completion too.
		const separatorIndex = trimmedStart.search(/\s/);
		const commandToken = separatorIndex === -1 ? trimmedStart : trimmedStart.slice(0, separatorIndex);

		if (commandToken.slice(1).includes("/")) {
			return null;
		}

		if (separatorIndex === -1) {
			return { kind: "name", prefix: commandToken, isAtPromptStart: true };
		}

		const commandName = commandToken.slice(1);
		if (!commandName) {
			return null;
		}

		return {
			kind: "argument",
			commandName,
			prefix: trimmedStart.slice(separatorIndex + 1),
			isAtPromptStart: true,
		};
	}

	const tokenStart = (() => {
		const lastSeparator = /\s(?=\S*$)/.exec(textBeforeCursor);
		return lastSeparator ? lastSeparator.index + 1 : 0;
	})();
	const prefix = textBeforeCursor.slice(tokenStart);
	if (!prefix.startsWith("/") || prefix.slice(1).includes("/")) {
		return null;
	}

	return { kind: "name", prefix, isAtPromptStart: false };
}
