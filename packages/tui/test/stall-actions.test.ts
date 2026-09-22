import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { formatStallActionLines, type StallActionEvent, StallActions } from "../src/components/stall-actions.js";
import { type KeybindingDefinition, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";
import { matchesKey } from "../src/keys.js";

const CTRL_Y = "\x19";
const CTRL_G = "\x07";
const ESCAPE = "\x1b";

const actionableEvent: StallActionEvent = {
	type: "stall_warning",
	message: "Possible stall: no session activity for 312s while a turn is running.",
	silentMs: 312_000,
	thresholdMs: 300_000,
	actions: { canAbort: true, canDiagnose: true },
};

const legacyEvent: StallActionEvent = {
	type: "stall_warning",
	message: "Possible stall: no session activity for 312s while a turn is running.",
	silentMs: 312_000,
	thresholdMs: 300_000,
};

const interruptKeyLabel = "Esc";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("formatStallActionLines", () => {
	it("renders one hint line per offered action plus the dismiss note", () => {
		const lines = formatStallActionLines(actionableEvent, { interrupt: interruptKeyLabel, diagnostics: "ctrl+y" });

		assert.deepStrictEqual(lines, [
			"\u26a0 stall: silent 312s (threshold 300s)",
			"  Esc = interrupt this turn",
			"  ctrl+y = show stall diagnostics",
			"  any other key = dismiss (the turn keeps running)",
		]);
	});

	it("omits the hint line of an action the event does not offer", () => {
		const lines = formatStallActionLines(
			{ ...actionableEvent, actions: { canAbort: false, canDiagnose: true } },
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
		);

		assert.deepStrictEqual(lines, [
			"\u26a0 stall: silent 312s (threshold 300s)",
			"  ctrl+y = show stall diagnostics",
			"  any other key = dismiss (the turn keeps running)",
		]);
	});

	it("degrades to plain text (summary plus message) when the event carries no actions field", () => {
		const lines = formatStallActionLines(legacyEvent, { interrupt: interruptKeyLabel, diagnostics: "ctrl+y" });

		// Degraded direction: no action hints, no dismiss note.
		assert.deepStrictEqual(lines, [
			"\u26a0 stall: silent 312s (threshold 300s)",
			"Possible stall: no session activity for 312s while a turn is running.",
		]);
	});

	it("degrades the same way when actions exist but offer nothing", () => {
		const lines = formatStallActionLines(
			{ ...actionableEvent, actions: { canAbort: false, canDiagnose: false } },
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
		);

		assert.deepStrictEqual(lines, [
			"\u26a0 stall: silent 312s (threshold 300s)",
			"Possible stall: no session activity for 312s while a turn is running.",
		]);
	});

	it("uses the caller-provided key labels verbatim (no hardcoded key)", () => {
		const lines = formatStallActionLines(actionableEvent, { interrupt: "alt+x", diagnostics: "ctrl+g" });

		assert.ok(lines.some((line) => line.includes("alt+x = interrupt this turn")));
		assert.ok(lines.some((line) => line.includes("ctrl+g = show stall diagnostics")));
		assert.ok(!lines.some((line) => line.includes("Esc")));
	});

	it("F3: renders the armed auto-recovery moment (wall clock) plus a countdown", () => {
		const nowMs = 1_000_000_000;
		const atMs = nowMs + 90_000;
		const lines = formatStallActionLines(
			{
				...actionableEvent,
				actions: {
					canAbort: true,
					canDiagnose: true,
					autoRecoveryArmed: true,
					executor: "daemon",
					autoRecoveryAtMs: atMs,
				},
			},
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
			nowMs,
		);

		const expectedClock = new Date(atMs);
		const pad = (value: number): string => String(value).padStart(2, "0");
		const clock = `${pad(expectedClock.getHours())}:${pad(expectedClock.getMinutes())}:${pad(expectedClock.getSeconds())}`;
		assert.deepStrictEqual(lines, [
			"\u26a0 stall: silent 312s (threshold 300s)",
			"  Esc = interrupt this turn",
			"  ctrl+y = show stall diagnostics",
			`  auto-recovery (daemon): machine will act at ${clock} (in 90s)`,
			"  any other key = dismiss (the turn keeps running)",
		]);
	});

	it("F3: renders 'due now' once the expected moment has passed", () => {
		const lines = formatStallActionLines(
			{
				...actionableEvent,
				actions: { canAbort: true, canDiagnose: true, autoRecoveryArmed: true, autoRecoveryAtMs: 999_000 },
			},
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
			1_000_000_000,
		);

		assert.ok(
			lines.some((line) => line.includes("auto-recovery: machine will act at") && line.includes("(due now)")),
		);
	});

	it("F3: an unarmed or moment-less actions field renders no auto-recovery line", () => {
		// Unarmed even though the moment is present: armed is the gate, so a
		// malformed/absent flag can never invent a countdown.
		const unarmed = formatStallActionLines(
			{ ...actionableEvent, actions: { canAbort: true, canDiagnose: true, autoRecoveryAtMs: 1_000_090_000 } },
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
			1_000_000_000,
		);
		const disarmed = formatStallActionLines(
			{ ...actionableEvent, actions: { canAbort: true, canDiagnose: true, autoRecoveryArmed: false } },
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
			1_000_000_000,
		);
		const momentless = formatStallActionLines(
			{ ...actionableEvent, actions: { canAbort: true, canDiagnose: true, autoRecoveryArmed: true } },
			{ interrupt: interruptKeyLabel, diagnostics: "ctrl+y" },
			1_000_000_000,
		);

		for (const lines of [unarmed, disarmed, momentless]) {
			assert.ok(!lines.some((line) => line.includes("auto-recovery")));
			// Line-count pin: without the armed facts the render is exactly the
			// pre-F3 shape - summary, one hint per offered action, dismiss note.
			assert.strictEqual(lines.length, 4);
		}
	});
});

describe("stall action keybinding registration", () => {
	it("registers app.stall.diagnostics in the default table with ctrl+y and no scope", () => {
		const definition: KeybindingDefinition = TUI_KEYBINDINGS["app.stall.diagnostics"];
		assert.strictEqual(definition.defaultKeys, "ctrl+y");
		assert.ok(definition.description);
		assert.strictEqual(definition.defaultKeyScope, undefined);
	});

	it("resolves and matches the default binding", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("app.stall.diagnostics"), ["ctrl+y"]);
		assert.strictEqual(keybindings.matches(CTRL_Y, "app.stall.diagnostics"), true);
		assert.strictEqual(keybindings.matches(CTRL_G, "app.stall.diagnostics"), false);
	});

	it("stays fully configurable through user bindings", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"app.stall.diagnostics": "ctrl+g",
		});

		assert.deepStrictEqual(keybindings.getKeys("app.stall.diagnostics"), ["ctrl+g"]);
		assert.strictEqual(keybindings.matches(CTRL_G, "app.stall.diagnostics"), true);
		assert.strictEqual(keybindings.matches(CTRL_Y, "app.stall.diagnostics"), false);
	});

	it("registers no stall interrupt binding of its own (interrupt reuses the host binding)", () => {
		// Negative conclusion: no "app.stall.interrupt" row exists. The positive
		// control is the row lookup itself: the same lookup finds
		// app.stall.diagnostics, so a hypothetical interrupt row would be found
		// too.
		assert.strictEqual("app.stall.interrupt" in TUI_KEYBINDINGS, false);
		assert.strictEqual("app.stall.diagnostics" in TUI_KEYBINDINGS, true);
	});
});

describe("StallActions component", () => {
	it("renders the action lines and pads them to the given width", () => {
		// F1: hint lines only render for actions that have a callback behind them.
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onInterrupt: () => {},
			onDiagnostics: () => {},
		});

		const lines = bar.render(80);

		assert.strictEqual(lines.length, 4);
		assert.ok(lines[0]!.startsWith("\u26a0 stall: silent 312s (threshold 300s)"));
		assert.strictEqual(lines[1], `  ${interruptKeyLabel} = interrupt this turn`.padEnd(80));
		assert.strictEqual(lines[2], "  ctrl+y = show stall diagnostics".padEnd(80));
		assert.strictEqual(lines[3], "  any other key = dismiss (the turn keeps running)".padEnd(80));
	});

	it("exposes one click region per offered action and dispatches their clicks", () => {
		const calls: string[] = [];
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onInterrupt: () => calls.push("interrupt"),
			onDiagnostics: () => calls.push("diagnostics"),
		});

		const lines = bar.render(80);
		const regions = bar.getClickRegions();
		assert.strictEqual(regions.length, 2);
		const interruptHint = `${interruptKeyLabel} = interrupt this turn`;
		const diagnosticsHint = "ctrl+y = show stall diagnostics";
		const interruptLine = lines.findIndex((line) => line.includes(interruptHint));
		const diagnosticsLine = lines.findIndex((line) => line.includes(diagnosticsHint));
		assert.strictEqual(regions[0]!.line, interruptLine);
		assert.strictEqual(regions[0]!.col, lines[interruptLine]!.indexOf(interruptHint));
		assert.strictEqual(regions[1]!.line, diagnosticsLine);
		assert.strictEqual(regions[1]!.col, lines[diagnosticsLine]!.indexOf(diagnosticsHint));

		regions[0]!.onClick({ row: 0, col: 0 });
		regions[1]!.onClick({ row: 0, col: 0 });
		assert.deepStrictEqual(calls, ["interrupt", "diagnostics"]);
	});

	it("consumes the diagnostics key and the host interrupt key, nothing else", () => {
		const calls: string[] = [];
		// matchesKey stands in for the host's binding-derived matcher (the app
		// layer passes one built from its own keybindings table); the component
		// itself never hardcodes a key check.
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			matchesInterruptKey: (data) => matchesKey(data, "escape"),
			onInterrupt: () => calls.push("interrupt"),
			onDiagnostics: () => calls.push("diagnostics"),
		});

		assert.strictEqual(bar.handleInput(CTRL_Y), true);
		assert.strictEqual(bar.handleInput(ESCAPE), true);
		assert.strictEqual(bar.handleInput("x"), false);
		assert.deepStrictEqual(calls, ["diagnostics", "interrupt"]);
	});

	it("skips the interrupt action when the host provides no interrupt matcher", () => {
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onInterrupt: () => assert.fail("interrupt must not fire"),
		});

		// Without a host matcher the bar never consumes the interrupt key: the
		// host's own interrupt binding stays the only trigger.
		assert.strictEqual(bar.handleInput(ESCAPE), false);
	});

	it("renders a user-overridden diagnostics key in the hint line and matches it", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"app.stall.diagnostics": "ctrl+g",
			}),
		);
		const calls: string[] = [];
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onDiagnostics: () => calls.push("diagnostics"),
		});

		const lines = bar.render(80);
		assert.ok(lines.some((line) => line.includes("ctrl+g = show stall diagnostics")));
		assert.ok(!lines.some((line) => line.includes("ctrl+y = show stall diagnostics")));

		assert.strictEqual(bar.handleInput(CTRL_G), true);
		assert.strictEqual(bar.handleInput(CTRL_Y), false);
		assert.deepStrictEqual(calls, ["diagnostics"]);
	});

	it("renders degraded plain text with no click regions and no key consumption", () => {
		const bar = new StallActions(legacyEvent, {
			interruptKeyLabel,
			onInterrupt: () => assert.fail("interrupt must not fire"),
			onDiagnostics: () => assert.fail("diagnostics must not fire"),
		});

		const lines = bar.render(80);

		// Positive control: the detector below (searching for the interrupt
		// hint) fires on the actionable render, so its silence here is the
		// degrade, not a broken detector.
		const actionableLines = formatStallActionLines(actionableEvent, {
			interrupt: interruptKeyLabel,
			diagnostics: "ctrl+y",
		});
		assert.ok(actionableLines.some((line) => line.includes("interrupt this turn")));

		assert.deepStrictEqual(
			lines.map((line) => line.trimEnd()),
			[
				"\u26a0 stall: silent 312s (threshold 300s)",
				"Possible stall: no session activity for 312s while a turn is running.",
			],
		);
		assert.deepStrictEqual(bar.getClickRegions(), []);
		assert.strictEqual(bar.handleInput(CTRL_Y), false);
		assert.strictEqual(bar.handleInput(ESCAPE), false);
	});

	it("F3: renders the armed auto-recovery line after the action hints, unclickable", () => {
		// The countdown is a fact, not an action: it adds a line but no key and
		// no click region, so the two action regions are the only ones.
		const bar = new StallActions(
			{
				...actionableEvent,
				actions: {
					canAbort: true,
					canDiagnose: true,
					autoRecoveryArmed: true,
					executor: "daemon",
					autoRecoveryAtMs: Date.now() + 90_000,
				},
			},
			{
				interruptKeyLabel,
				onInterrupt: () => {},
				onDiagnostics: () => {},
			},
		);

		const lines = bar.render(80);

		assert.strictEqual(lines.length, 5);
		const countdownLine = lines[3]!;
		assert.ok(countdownLine.includes("auto-recovery (daemon): machine will act at"), countdownLine);
		assert.ok(countdownLine.includes("(in 90s)"), countdownLine);
		assert.strictEqual(bar.getClickRegions().length, 2);
	});

	it("F3: the auto-recovery facts survive the callback AND (informational, not host-gated)", () => {
		// Only the diagnostics callback is provided, so the interrupt hint is
		// gone - but the daemon's countdown still renders: dropping it with the
		// unusable action would hide when the sweep will act.
		const bar = new StallActions(
			{
				...actionableEvent,
				actions: {
					canAbort: true,
					canDiagnose: true,
					autoRecoveryArmed: true,
					executor: "daemon",
					autoRecoveryAtMs: Date.now() + 45_000,
				},
			},
			{ interruptKeyLabel, onDiagnostics: () => {} },
		);

		const lines = bar.render(80);

		assert.ok(!lines.some((line) => line.includes("interrupt this turn")));
		assert.ok(
			lines.some(
				(line) => line.includes("auto-recovery (daemon): machine will act at") && line.includes("(in 45s)"),
			),
		);
		assert.strictEqual(bar.getClickRegions().length, 1);
	});

	it("renders nothing and consumes no input after dismiss", () => {
		const calls: string[] = [];
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			matchesInterruptKey: (data) => matchesKey(data, "escape"),
			onInterrupt: () => calls.push("interrupt"),
			onDiagnostics: () => calls.push("diagnostics"),
		});
		bar.render(80);
		assert.strictEqual(bar.getClickRegions().length, 2);

		bar.dismiss();
		assert.strictEqual(bar.isDismissed, true);
		assert.deepStrictEqual(bar.render(80), []);
		assert.deepStrictEqual(bar.getClickRegions(), []);
		assert.strictEqual(bar.handleInput(CTRL_Y), false);
		assert.strictEqual(bar.handleInput(ESCAPE), false);
		assert.deepStrictEqual(calls, []);
	});

	it("drops a click region whose hint line wraps below the terminal width", () => {
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onInterrupt: () => {},
			onDiagnostics: () => {},
		});

		// Width 30 keeps the interrupt hint on one line but wraps the
		// diagnostics hint across two, so only the interrupt region survives.
		// The key path is unaffected by the loss of the click target.
		const lines = bar.render(30);
		assert.ok(lines.some((line) => line.trimEnd() === `  ${interruptKeyLabel} = interrupt this turn`));
		assert.ok(!lines.some((line) => line.includes("ctrl+y = show stall diagnostics")));

		const regions = bar.getClickRegions();
		assert.strictEqual(regions.length, 1);
		const interruptHint = `${interruptKeyLabel} = interrupt this turn`;
		const regionLine = lines[regions[0]!.line]!;
		assert.strictEqual(regionLine.indexOf(interruptHint), regions[0]!.col);
	});

	it("F1: an action without a callback renders no hint and consumes no key", () => {
		// The event offers both actions, but the host provides neither handler:
		// the bar must not advertise or consume either one.
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			matchesInterruptKey: (data) => matchesKey(data, "escape"),
		});

		const lines = bar.render(80);
		assert.deepStrictEqual(
			lines.map((line) => line.trimEnd()),
			[
				"\u26a0 stall: silent 312s (threshold 300s)",
				"Possible stall: no session activity for 312s while a turn is running.",
			],
		);
		assert.deepStrictEqual(bar.getClickRegions(), []);
		assert.strictEqual(bar.handleInput(ESCAPE), false);
		assert.strictEqual(bar.handleInput(CTRL_Y), false);
	});

	it("F1: only the action with a callback renders its hint line", () => {
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onDiagnostics: () => {},
		});

		const lines = bar.render(80);
		assert.ok(lines.some((line) => line.includes("ctrl+y = show stall diagnostics")));
		assert.ok(!lines.some((line) => line.includes("interrupt this turn")));
		// The unhandled action's key is not consumed: the host's own interrupt
		// binding stays the only trigger for it.
		assert.strictEqual(bar.handleInput(ESCAPE), false);
		assert.strictEqual(bar.handleInput(CTRL_Y), true);
	});

	it("F2: an unbound diagnostics key keeps the hint line but renders no click region", () => {
		// "Unbound" is an empty resolved key set: the default table declares no
		// key for the action (the same shape app.interrupt has). The hint line
		// still renders - it says "unbound" - but the click region is suppressed.
		const keybindings = new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.stall.diagnostics": {
				...TUI_KEYBINDINGS["app.stall.diagnostics"]!,
				defaultKeys: [],
			},
		});
		setKeybindings(keybindings);
		const bar = new StallActions(actionableEvent, {
			interruptKeyLabel,
			onInterrupt: () => {},
			onDiagnostics: () => {},
		});

		const lines = bar.render(80);
		assert.ok(lines.some((line) => line.includes("unbound = show stall diagnostics")));
		const regions = bar.getClickRegions();
		// Only the interrupt region survives: the unbound action has no click target.
		assert.strictEqual(regions.length, 1);
		const interruptHint = `${interruptKeyLabel} = interrupt this turn`;
		assert.ok(lines[regions[0]!.line]!.includes(interruptHint));
	});

	it("wraps long degraded messages instead of overflowing the width", () => {
		const longMessage = "word ".repeat(60).trim();
		const bar = new StallActions({ ...legacyEvent, message: longMessage }, { interruptKeyLabel });

		const lines = bar.render(20);

		assert.ok(lines.length > 2);
		for (const line of lines) {
			assert.strictEqual(line.length, 20);
		}
	});
});
