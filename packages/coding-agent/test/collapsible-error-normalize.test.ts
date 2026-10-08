import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CollapsibleErrorComponent,
	normalizeErrorDetails,
} from "../src/modes/interactive/components/collapsible-error.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Control bytes via fromCharCode so the source file itself stays clean ASCII.
const BEL = String.fromCharCode(0x07);
const FS = String.fromCharCode(0x1c);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85); // C1 next-line
const CSI_2J = `${String.fromCharCode(0x1b)}[2J`;
const SGR_RED = `${String.fromCharCode(0x1b)}[31m`;
const SGR_RESET = `${String.fromCharCode(0x1b)}[0m`;
const OSC52 = `${String.fromCharCode(0x1b)}]52;c;cGFzdGU=${BEL}`;

/**
 * Display-audit wash batch: the collapsible error faces build their own rows
 * (`renderText` interpolates into styled strings; ipython-cell's output paths do
 * the same off `normalizeErrorDetails`), so the text never passes the `Text`
 * render gate. A bare BEL in a bash output rings on every repaint, a NUL or a C1
 * byte is terminal-dependent debris. `normalizeErrorDetails` is the shared wash
 * every one of those faces already calls.
 */
describe("normalizeErrorDetails", () => {
	it("strips bare C0 controls, DEL and C1 while keeping newlines and tabs", () => {
		expect(normalizeErrorDetails(`a${BEL}b${FS}c${DEL}d${NEL}e${NUL}f`)).toBe("abcdef");
		expect(normalizeErrorDetails("keep\nnewlines\tand\ttabs")).toBe("keep\nnewlines\tand\ttabs");
	});

	it("still strips escape sequences, folds CR and trims the tail", () => {
		expect(normalizeErrorDetails(`${CSI_2J}${SGR_RED}red${SGR_RESET}`)).toBe("red");
		expect(normalizeErrorDetails(`${OSC52}payload`)).toBe("payload");
		expect(normalizeErrorDetails("one\r\ntwo\rthree  \n")).toBe("one\ntwo\nthree");
	});

	it("keeps traceback indentation semantics the stack parser relies on", () => {
		const text = normalizeErrorDetails('Traceback (most recent call last):\n\tFile "x", line 1\n');
		expect(text.split("\n")[1]).toBe('\tFile "x", line 1');
	});
});

describe("CollapsibleErrorComponent wash", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders no control characters from an injected error text", () => {
		const component = new CollapsibleErrorComponent({
			text: `boom${BEL}${CSI_2J}\nTraceback (most recent call last):\n\t  File "x.py", line 1\nValueError${OSC52}: bad`,
			expanded: true,
		});
		const rows = component.render(80);
		const visible = rows.map((row) => stripAnsi(row)).join("\n");
		// Every C0 but \n and \t, DEL and C1 are gone from what hits the screen.
		expect(visible).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
		expect(visible).toContain("boom");
		expect(visible).toContain("ValueError: bad");
	});
});
