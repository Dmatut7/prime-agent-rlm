import type { ClickRegion } from "../click-regions.js";
import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { visibleWidth, wrapTextWithAnsi } from "../utils.js";

/**
 * The actionable capabilities a stall event offers, as the emitter reports them.
 *
 * The `actions` field is additive on the stall event wire: an older emitter (or
 * a terminal stall stage, where the turn is already dead) sends the event
 * without it, and the renderer degrades to plain text instead of showing
 * actions that are not actually available.
 */
export interface StallActionsView {
	/** Whether the current turn can still be interrupted. */
	canAbort: boolean;
	/** Whether stall diagnostics can be shown for the current turn. */
	canDiagnose: boolean;
	/**
	 * True once an auto-recovery executor (the daemon's stall-recovery sweep)
	 * has this session under observation (r4 phase-2, F3). Informational, not
	 * an action: it adds one hint line, consumes no key, and has no click
	 * region. Filled by the daemon on the wire; absent when unarmed.
	 */
	autoRecoveryArmed?: boolean;
	/** Who performs the auto action when the wait window closes, when armed. */
	executor?: "daemon" | "in-process";
	/** Epoch ms when the auto action is expected, when armed. */
	autoRecoveryAtMs?: number;
}

/**
 * One stall event as the action bar receives it.
 *
 * Structurally compatible with the agent session's stall event payloads
 * (`stall_warning` / `stall_abort` / `stall_unsettled`): fields this view does
 * not need, such as the full `diagnostics` snapshot, may be present and are
 * ignored. The bar is TUI plumbing; the host (interactive mode) decides which
 * events hang it and keeps rendering the forensic full text through its
 * existing error channel.
 */
export interface StallActionEvent {
	type: string;
	message: string;
	silentMs: number;
	thresholdMs: number;
	/** Which actions the emitter offers. Absent on older emitters; degrades the render to plain text. */
	actions?: StallActionsView | undefined;
}

/** Display labels for the two action keys, resolved by the caller from real bindings. */
export interface StallActionKeyHints {
	/**
	 * Label for the key that interrupts the current turn. The stall bar owns no
	 * interrupt binding (a duplicate of the existing one would double-trigger
	 * the interrupt); the host resolves this label from its existing interrupt
	 * keybinding, so the hint always reflects what the host actually honors.
	 */
	interrupt: string;
	/** Label for the key that shows stall diagnostics, resolved from "app.stall.diagnostics". */
	diagnostics: string;
}

function secondsOf(ms: number): string {
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Locale-independent wall-clock rendering (HH:MM:SS) of an epoch-ms moment. */
function clockOf(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The auto-recovery hint line, or undefined when the facts are not renderable
 * (unarmed, or the moment is missing/non-finite). Static: the wall-clock
 * moment to the second plus a countdown against this paint's own `nowMs`, both
 * recomputed on every paint (see the cache key in render()); the wall-clock
 * part stays honest even if nothing repaints for a while.
 *
 * The copy promises the machine's own deadline. It must not say "any input
 * keeps this turn alive": that second claim belongs to the daemon's input
 * accounting (blind1 F1) and cannot ship from here before it exists.
 */
function autoRecoveryLine(actions: StallActionsView, nowMs: number): string | undefined {
	if (actions.autoRecoveryArmed !== true) return undefined;
	const atMs = actions.autoRecoveryAtMs;
	if (typeof atMs !== "number" || !Number.isFinite(atMs)) return undefined;
	const who = actions.executor === undefined ? "auto-recovery" : `auto-recovery (${actions.executor})`;
	const remainingMs = atMs - nowMs;
	const countdown = remainingMs <= 0 ? "due now" : `in ${Math.max(1, Math.round(remainingMs / 1000))}s`;
	return `  ${who}: machine will act at ${clockOf(atMs)} (${countdown})`;
}

function isActionable(actions: StallActionsView | undefined): actions is StallActionsView {
	return actions !== undefined && (actions.canAbort || actions.canDiagnose);
}

/**
 * The actions this instance can actually deliver (r4 recovery-shell F1): an
 * action without a callback is not offered - it renders no hint line and
 * consumes no key - because a hint that names a key which then does nothing is
 * a promise the bar cannot keep. The event's offer is ANDed with the host's
 * handlers here, once, so render, input, and click regions cannot disagree.
 */
function effectiveActions(event: StallActionEvent, options: StallActionsOptions): StallActionsView | undefined {
	const actions = event.actions;
	if (actions === undefined) return undefined;
	const canAbort = actions.canAbort && options.onInterrupt !== undefined;
	const canDiagnose = actions.canDiagnose && options.onDiagnostics !== undefined;
	if (!canAbort && !canDiagnose) return undefined;
	// F3: the auto-recovery facts are informational, not host-gated, so they
	// survive this AND - the countdown keeps showing even when only one action
	// is deliverable here.
	return { canAbort, canDiagnose, ...autoRecoveryFactsOf(actions) };
}

/** The daemon's auto-recovery facts, verbatim: this layer never invents them. */
function autoRecoveryFactsOf(
	actions: StallActionsView,
): Pick<StallActionsView, "autoRecoveryArmed" | "executor" | "autoRecoveryAtMs"> {
	return {
		autoRecoveryArmed: actions.autoRecoveryArmed,
		executor: actions.executor,
		autoRecoveryAtMs: actions.autoRecoveryAtMs,
	};
}

/**
 * Render the stall action bar lines from a stall event payload.
 *
 * Pure function (no keybindings manager, no TUI): the caller resolves the key
 * labels and passes them in, which keeps the render testable and the labels in
 * sync with the bindings the host actually honors.
 *
 * Two render directions:
 * - With an `actions` field that offers at least one action: the summary line
 *   plus one hint line per offered action (the hint lines double as the
 *   clickable buttons of the {@link StallActions} component), the armed
 *   auto-recovery line when the emitter filled one (F3: wall-clock moment plus
 *   a countdown against `nowMs`, not an action and not clickable), and the
 *   dismiss note.
 * - Without usable actions (older emitter, or a terminal stall stage): the
 *   summary plus the plain event message - the degraded plain-text render the
 *   old error channel produced before the action bar existed.
 */
export function formatStallActionLines(
	event: StallActionEvent,
	keys: StallActionKeyHints,
	nowMs: number = Date.now(),
): string[] {
	const summary = `\u26a0 stall: silent ${secondsOf(event.silentMs)} (threshold ${secondsOf(event.thresholdMs)})`;
	if (!isActionable(event.actions)) {
		return [summary, event.message];
	}
	const lines = [summary];
	if (event.actions.canAbort) {
		lines.push(`  ${keys.interrupt} = interrupt this turn`);
	}
	if (event.actions.canDiagnose) {
		lines.push(`  ${keys.diagnostics} = show stall diagnostics`);
	}
	const autoRecovery = autoRecoveryLine(event.actions, nowMs);
	if (autoRecovery !== undefined) {
		lines.push(autoRecovery);
	}
	lines.push("  any other key = dismiss (the turn keeps running)");
	return lines;
}

export interface StallActionsOptions {
	/**
	 * Label for the interrupt key hint, resolved by the host from its existing
	 * interrupt keybinding. Rendered verbatim; the bar never hardcodes a key.
	 */
	interruptKeyLabel: string;
	/**
	 * Optional matcher for the host's existing interrupt binding, so a focused
	 * bar can consume that key as the interrupt action too. The host builds
	 * this from its own keybindings table; the bar registers no interrupt
	 * binding of its own to avoid double-triggering the interrupt path.
	 */
	matchesInterruptKey?: (data: string) => boolean;
	/** Invoked when the interrupt action fires (key match or button click). */
	onInterrupt?: () => void;
	/** Invoked when the diagnostics action fires (key match or button click). */
	onDiagnostics?: () => void;
}

/**
 * Non-modal stall action bar: turns a stall event into an actionable strip
 * ("interrupt this turn" / "show stall diagnostics") while the turn keeps
 * running.
 *
 * The bar does not grab focus. The host routes input while the bar is visible:
 * `handleInput` returns true only when an action consumed the key; for every
 * other key it returns false, and the host dismisses the bar and lets the key
 * flow to its normal destination - which is how the existing interrupt binding
 * interrupts the turn without a duplicate binding here.
 *
 * Events without a usable `actions` field render as plain text with no click
 * regions and consume no keys: the old-client/old-daemon degradation path.
 */
export class StallActions implements Component {
	private readonly event: StallActionEvent;
	private readonly options: StallActionsOptions;
	private dismissed = false;
	private regions: ClickRegion[] = [];
	private cache?: { width: number; hintKey: string; countdownKey: string; lines: string[] };

	constructor(event: StallActionEvent, options: StallActionsOptions) {
		this.event = event;
		this.options = options;
	}

	/** Mark the bar as dismissed: renders empty and consumes no further input. */
	dismiss(): void {
		this.dismissed = true;
		this.regions = [];
		this.cache = undefined;
	}

	get isDismissed(): boolean {
		return this.dismissed;
	}

	/**
	 * Handle one key event. Returns true when an action consumed the key, false
	 * when the host should continue its normal dispatch (and typically dismiss
	 * the bar). Satisfies the Component interface while giving the host a
	 * consumed/not-consumed answer.
	 */
	handleInput(data: string): boolean {
		if (this.dismissed) return false;
		const actions = effectiveActions(this.event, this.options);
		if (!actions) return false;
		if (actions.canAbort && this.options.matchesInterruptKey?.(data)) {
			this.options.onInterrupt?.();
			return true;
		}
		if (actions.canDiagnose && getKeybindings().matches(data, "app.stall.diagnostics")) {
			this.options.onDiagnostics?.();
			return true;
		}
		return false;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.dismissed) {
			this.regions = [];
			return [];
		}
		const hints = this.resolveKeyHints();
		const hintKey = `${hints.interrupt}\u0000${hints.diagnostics}`;
		const actions = effectiveActions(this.event, this.options);
		// F3: an armed countdown line is measured against the paint's clock, so
		// the cache key carries the current second and any ordinary repaint
		// re-renders the countdown. No timer lives here: while a turn streams the
		// host already repaints (the working loader's spinner and the chat pulse
		// both run), and inventing a second ticker would only duplicate them.
		// Without an armed countdown the key is constant, so the cache behaves
		// exactly as it did before this feature.
		const countdownKey =
			actions?.autoRecoveryArmed === true && typeof actions.autoRecoveryAtMs === "number"
				? String(Math.floor(Date.now() / 1000))
				: "";
		const cache = this.cache;
		if (cache && cache.width === width && cache.hintKey === hintKey && cache.countdownKey === countdownKey) {
			return cache.lines;
		}
		const rawLines = formatStallActionLines({ ...this.event, actions }, hints);
		const lines: string[] = [];
		for (const raw of rawLines) {
			for (const wrapped of wrapTextWithAnsi(raw, Math.max(1, width))) {
				const padding = Math.max(0, width - visibleWidth(wrapped));
				lines.push(wrapped + " ".repeat(padding));
			}
		}
		this.cache = { width, hintKey, countdownKey, lines };
		this.regions = this.regionsFor(lines, hints);
		return lines;
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	private resolveKeyHints(): StallActionKeyHints {
		const keys = getKeybindings().getKeys("app.stall.diagnostics");
		return {
			interrupt: this.options.interruptKeyLabel,
			diagnostics: keys.some((key) => key.trim().length > 0) ? keys.join("/") : "unbound",
		};
	}

	/**
	 * Click regions cover the (unsplit) hint lines of the two actions. A hint
	 * wrapped across lines is skipped rather than guessed at: at that width the
	 * key path still works, only the click target is gone.
	 */
	private regionsFor(lines: string[], hints: StallActionKeyHints): ClickRegion[] {
		const actions = effectiveActions(this.event, this.options);
		if (!actions) return [];
		const regions: ClickRegion[] = [];
		if (actions.canAbort) {
			this.addHintRegion(regions, lines, `${hints.interrupt} = interrupt this turn`, () => {
				this.options.onInterrupt?.();
			});
		}
		// F2: an unbound diagnostics key (the user cleared it) renders the hint
		// line - it honestly says "unbound" - but no click region: a clickable
		// affordance for an action with no key behind it invites a dead click.
		const diagnosticsKeys = getKeybindings().getKeys("app.stall.diagnostics");
		if (actions.canDiagnose && diagnosticsKeys.some((key) => key.trim().length > 0)) {
			this.addHintRegion(regions, lines, `${hints.diagnostics} = show stall diagnostics`, () => {
				this.options.onDiagnostics?.();
			});
		}
		return regions;
	}

	private addHintRegion(regions: ClickRegion[], lines: string[], hint: string, onClick: () => void): void {
		for (const [index, line] of lines.entries()) {
			const col = line.indexOf(hint);
			if (col >= 0) {
				regions.push({ line: index, col, width: visibleWidth(hint), height: 1, onClick });
				return;
			}
		}
	}
}
