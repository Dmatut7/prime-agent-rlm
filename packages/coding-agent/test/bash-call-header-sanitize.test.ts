import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The bash call header (`$ <command>`) is one physical row of the tool panel, and
 * the command is model text. Two gaps this covers:
 *
 * - R4-M6: the row goes through `Text`, whose central gate drops an OSC 52 or a
 *   screen clear but keeps a newline and every SGR/OSC 8 the text carries, so an
 *   untested command could split the header into two rows and paint its own colors.
 * - R3-M21: an empty preview falls back to the raw command, which never went
 *   through the preview descriptor's redaction - `export MY_TOKEN=abc123` is a
 *   setup-only command, so its secret was the header verbatim.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J";
const BEL = "\u0007";
const CR = "\r";
const SGR = "\u001b[31m";
const RESET = "\u001b[0m";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

let callIndex = 0;

/** The rows of a bash call with no result yet: panel header, spacer, call rows. */
function callRows(command: string, width = 80): string[] {
	callIndex += 1;
	const component = new ToolExecutionComponent(
		"bash",
		`bash-header-sanitize-${callIndex}`,
		{ command },
		{},
		createBashToolDefinition(process.cwd()),
		createFakeTui(),
		process.cwd(),
	);
	return component.render(width);
}

/** The visible text of every row, right padding dropped so a literal stays readable. */
function visible(command: string, width = 80): string[] {
	return callRows(command, width).map((row) => stripAnsi(row).trimEnd());
}

describe("bash call header", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("leaves no trace of an injected screen clear, bell, CR or color code", () => {
		const injected = `git status${CLEAR}${BEL}${SGR}x${RESET}${CR}`;
		const rows = callRows(injected);
		const joined = rows.join("\n");
		expect(joined).not.toContain(CLEAR);
		expect(joined).not.toContain(BEL);
		expect(joined).not.toContain(CR);
		expect(joined).not.toContain(OSC52);
		// The header the same text without the escapes produces, byte for byte:
		// the injected SGR painted nothing the component did not paint itself.
		expect(rows).toEqual(callRows("git statusx"));
	});

	it("leaves no trace of an injected clipboard write", () => {
		const rows = callRows(`git add -A${OSC52}`);
		expect(rows.join("\n")).not.toContain("\u001b]52");
		expect(rows.join("\n")).not.toContain("cGFzdGU=");
		expect(rows).toEqual(callRows("git add -A"));
	});

	it("keeps the header on one physical row when the command carries newlines", () => {
		// Both lines are setup, so the preview is empty and the raw command is the
		// header text - newlines and all, unless the row wash collapses them.
		const rows = callRows("set -e\nsource ./env.sh");
		expect(visible("set -e\nsource ./env.sh")).toEqual(["  bash · queued", "", "  $ set -e source ./env.sh"]);
		expect(rows.length).toBe(3);
		expect(rows.every((row) => !row.includes("\n"))).toBe(true);
	});

	it("redacts the secret of a setup-only command the preview falls back on", () => {
		expect(visible("export MY_TOKEN=abc123")).toEqual(["  bash · queued", "", "  $ export MY_TOKEN=<redacted>"]);
		expect(visible("set -e\nexport MY_TOKEN=abc123").join("\n")).not.toContain("abc123");
		const poisoned = `export API_KEY="sk-live-0123456789abcdef"`; // secret-scan: allow: redaction fixture
		expect(visible(poisoned).join("\n")).not.toContain("sk-live");
	});

	it("reads a command that is nothing but escape bytes as no command at all", () => {
		expect(visible(`${CLEAR}${BEL}`)).toEqual(["  bash · queued", "", "  $ ..."]);
	});

	it("keeps an ordinary command's header exactly as it was", () => {
		expect(visible("echo hello")).toEqual(["  bash · queued", "", "  $ echo hello"]);
		expect(visible("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual([
			"  bash · queued",
			"",
			"  $ npm check (../..)",
		]);
	});
});
