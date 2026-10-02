/**
 * ProbeBus is the single owner of startup capability probing between the TUI
 * and the terminal (docs/fork/probe-bus-design.md).
 *
 * One bus per terminal session: `start()` writes every capability query in one
 * burst and finishes with a primary-DA request (`CSI c`) as the fence. A
 * terminal processes its input serially, so a DA answer proves every query
 * ahead of it was seen; anything still pending when the DA lands is judged
 * "unsupported" without waiting out a wall-clock guess. A single fallback
 * timer covers terminals that never answer DA at all and judges "unknown".
 *
 * Consumers subscribe per capability instead of greping the input stream: both
 * the plain stdin path and the paste-strip path (stdin-buffer.ts) feed
 * `handleSequence`, which consumes every probe-answer shape it recognizes.
 *
 * Per-capability env escape hatches (`PI_TERMINAL_<CAP>`): "0" disables the
 * probe and the capability, "1" forces support without probing, anything else
 * probes. An override is final - answers are still consumed (they must not
 * leak into the key path) but change nothing.
 */

import {
	type DefaultTerminalColors,
	parseOscColorResponse,
	QUERY_DEFAULT_BACKGROUND,
	QUERY_DEFAULT_FOREGROUND,
	type Rgb,
} from "./terminal-colors.js";
import type { CellDimensions } from "./terminal-image.js";

export type ProbeCapability =
	| "kittyKeyboard" // CSI ? u
	| "sync2026" //      DECRQM 2026
	| "grapheme2027" //  DECRQM 2027
	| "scheme2031" //    DECRQM 2031 + CSI ? 997;n push
	| "oscColors" //     OSC 10/11
	| "cellSize"; //     CSI 16 t

export type ProbeVerdict = "pending" | "supported" | "unsupported" | "unknown";

export interface CapabilityState {
	verdict: ProbeVerdict;
	/** DECRPM answer Pv (0-4); only DECRQM capabilities carry it. */
	decrpmValue?: 0 | 1 | 2 | 3 | 4;
	/** probe=terminal answered; env-override=PI_TERMINAL_* forced; default=fence/timer fallback. */
	source: "probe" | "env-override" | "default";
	/** oscColors: both default colors, present once the verdict is supported. */
	defaultColors?: DefaultTerminalColors;
	/** cellSize: last answered cell geometry. */
	cellSize?: CellDimensions;
}

export type ProbeListener = (cap: ProbeCapability, state: CapabilityState) => void;

/**
 * The sync2026 decision table (docs/fork/probe-bus-design.md §3.2): frames stay
 * wrapped in synchronized-output markers for every probe outcome — supported or
 * reset the terminal joins in, refused or silent it ignores the mode-sets —
 * and only the PI_TERMINAL_SYNC_2026=0 escape hatch turns the wrapping off.
 */
export function sync2026FrameWrapping(state: CapabilityState): boolean {
	return !(state.source === "env-override" && state.verdict === "unsupported");
}

export interface ProbeBusOptions {
	/** Wall-clock fallback when no primary-DA answer arrives (default 1000ms). */
	fallbackMs?: number;
	/** PI_TERMINAL_* override source; defaults to process.env. */
	env?: Record<string, string | undefined>;
}

export interface ProbeBusStartOptions {
	/** Send the OSC 10/11 color queries (the caller gates this on TTY). Default true. */
	queryOscColors?: boolean;
	/** Send the CSI 16 t cell-size query (the caller gates this on image support). Default true. */
	queryCellSize?: boolean;
}

/** The DA fence is the last resort verdict clock; the DA answer itself is the primary one. */
export const PROBE_FALLBACK_MS = 1000;

const KITTY_KEYBOARD_QUERY = "\x1b[?u";
const SYNC_2026_QUERY = "\x1b[?2026$p";
const GRAPHEME_2027_QUERY = "\x1b[?2027$p";
const CELL_SIZE_QUERY = "\x1b[16t";
const PRIMARY_DA_QUERY = "\x1b[c";

const KITTY_ANSWER_REGEX = /^\x1b\[\?\d+u$/;
const DECRPM_ANSWER_REGEX = /^\x1b\[\?(\d+);(\d+)\$y$/;
// The `?` prefix is load-bearing: a bare `\x1b[c` is the shift+right key.
const DA_ANSWER_REGEX = /^\x1b\[\?[\d;]*c$/;
const SCHEME_PUSH_REGEX = /^\x1b\[\?997;[12]n$/;
const CELL_SIZE_ANSWER_REGEX = /^\x1b\[6;(\d+);(\d+)t$/;
// Consumed on shape even when the payload does not parse: the paste stripper
// (stdin-buffer.ts) lifts the same shape out of pastes, so an answer the bus
// rejected would leak into the key path.
const OSC_COLOR_ANSWER_SHAPE_REGEX = /^\x1b\]1[01];[^\x07\x1b]+(?:\x07|\x1b\\)$/;

const ENV_VAR_PER_CAPABILITY: Record<ProbeCapability, string> = {
	kittyKeyboard: "PI_TERMINAL_KITTY_KEYBOARD",
	sync2026: "PI_TERMINAL_SYNC_2026",
	grapheme2027: "PI_TERMINAL_GRAPHEME_2027",
	scheme2031: "PI_TERMINAL_SCHEME_2031",
	oscColors: "PI_TERMINAL_OSC_COLORS",
	cellSize: "PI_TERMINAL_CELL_SIZE",
};

const DECRPM_MODE_PER_CAPABILITY: Partial<Record<number, ProbeCapability>> = {
	2026: "sync2026",
	2027: "grapheme2027",
	2031: "scheme2031",
};

/** Capabilities with a query in flight in this phase; the rest stay "unknown" until theirs lands. */
const QUERIED_CAPABILITIES: ProbeCapability[] = ["kittyKeyboard", "sync2026", "grapheme2027", "oscColors", "cellSize"];

const ALL_CAPABILITIES = Object.keys(ENV_VAR_PER_CAPABILITY) as ProbeCapability[];

export class ProbeBus {
	private readonly fallbackMs: number;
	private readonly env: Record<string, string | undefined>;
	private readonly states = new Map<ProbeCapability, CapabilityState>();
	private readonly listeners = new Map<ProbeCapability, Set<ProbeListener>>();
	private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private disposed = false;
	private settledFlag = false;
	private oscForeground?: Rgb;
	private oscBackground?: Rgb;
	private resolveSettled!: () => void;
	/** Resolves when the DA fence (or the fallback timer, or dispose) closes the probe window. */
	readonly settled: Promise<void>;

	constructor(options: ProbeBusOptions = {}) {
		this.fallbackMs = options.fallbackMs ?? PROBE_FALLBACK_MS;
		this.env = options.env ?? process.env;
		for (const cap of ALL_CAPABILITIES) {
			// Capabilities whose query only a later phase sends have nothing in
			// flight; "unknown" (not "pending") is the honest starting verdict.
			const queried = QUERIED_CAPABILITIES.includes(cap);
			this.states.set(cap, { verdict: queried ? "pending" : "unknown", source: "default" });
		}
		this.settled = new Promise<void>((resolve) => {
			this.resolveSettled = resolve;
		});
	}

	/**
	 * Write every registered query in one burst, primary DA last, and arm the
	 * fallback timer. Listeners attached before start() observe env overrides.
	 */
	start(write: (data: string) => void, options: ProbeBusStartOptions = {}): void {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;

		for (const cap of ALL_CAPABILITIES) {
			this.applyEnvOverride(cap);
		}

		// A capability the caller gated off was never asked: unknown, not pending,
		// so the fence leaves it alone.
		if (options.queryOscColors === false && this.isPending("oscColors")) {
			this.setState("oscColors", { verdict: "unknown", source: "default" });
		}
		if (options.queryCellSize === false && this.isPending("cellSize")) {
			this.setState("cellSize", { verdict: "unknown", source: "default" });
		}

		let burst = "";
		if (this.isPending("kittyKeyboard")) {
			burst += KITTY_KEYBOARD_QUERY;
		}
		if (this.isPending("sync2026")) {
			burst += SYNC_2026_QUERY;
		}
		if (this.isPending("grapheme2027")) {
			burst += GRAPHEME_2027_QUERY;
		}
		if (this.isPending("oscColors")) {
			burst += QUERY_DEFAULT_FOREGROUND + QUERY_DEFAULT_BACKGROUND;
		}
		if (this.isPending("cellSize")) {
			burst += CELL_SIZE_QUERY;
		}
		burst += PRIMARY_DA_QUERY;
		write(burst);

		this.fallbackTimer = setTimeout(() => {
			this.fallbackTimer = undefined;
			this.settle("unknown");
		}, this.fallbackMs);
	}

	/**
	 * Feed one stdin sequence (plain data path or paste-strip path). Returns true
	 * when the sequence is a probe answer or push the bus consumed.
	 */
	handleSequence(sequence: string): boolean {
		if (this.disposed) {
			return false;
		}

		if (KITTY_ANSWER_REGEX.test(sequence)) {
			// Honored whenever it arrives: on a slow link the answer can outrun the
			// fallback timer, and enabling late beats never enabling.
			this.setStateUnlessOverridden("kittyKeyboard", { verdict: "supported", source: "probe" });
			return true;
		}

		const decrpm = sequence.match(DECRPM_ANSWER_REGEX);
		if (decrpm) {
			const cap = DECRPM_MODE_PER_CAPABILITY[Number(decrpm[1])];
			if (cap) {
				const pv = Number(decrpm[2]) as 0 | 1 | 2 | 3 | 4;
				// Pv 1/2/3 mean the terminal knows the mode; 0/4 mean it does not
				// (or refuses it). The raw Pv stays on the state for the per-mode
				// decision tables in the design.
				const verdict: ProbeVerdict = pv >= 1 && pv <= 3 ? "supported" : "unsupported";
				this.setStateUnlessOverridden(cap, { verdict, source: "probe", decrpmValue: pv });
			}
			return true;
		}

		if (SCHEME_PUSH_REGEX.test(sequence)) {
			// A 997 push means mode 2031 is live. Later phases route this into an
			// oscColors refresh; the bus only records the capability for now.
			this.setStateUnlessOverridden("scheme2031", { verdict: "supported", source: "probe" });
			return true;
		}

		if (DA_ANSWER_REGEX.test(sequence)) {
			this.settle("unsupported");
			return true;
		}

		const cellSize = sequence.match(CELL_SIZE_ANSWER_REGEX);
		if (cellSize) {
			// No fence semantics, matching the pre-bus behavior: the geometry applies
			// whenever the answer lands, and degenerate answers are swallowed.
			const heightPx = Number(cellSize[1]);
			const widthPx = Number(cellSize[2]);
			if (heightPx > 0 && widthPx > 0) {
				this.setStateUnlessOverridden("cellSize", {
					verdict: "supported",
					source: "probe",
					cellSize: { widthPx, heightPx },
				});
			}
			return true;
		}

		if (OSC_COLOR_ANSWER_SHAPE_REGEX.test(sequence)) {
			// The probe closes at the fence: late color answers are consumed but
			// dropped, as before the bus (phase 5 revisits this for 2031 pushes).
			if (this.isPending("oscColors")) {
				const response = parseOscColorResponse(sequence);
				if (response) {
					if (response.kind === "foreground") {
						this.oscForeground = response.rgb;
					} else {
						this.oscBackground = response.rgb;
					}
					if (this.oscForeground && this.oscBackground) {
						this.setState("oscColors", {
							verdict: "supported",
							source: "probe",
							defaultColors: { foreground: this.oscForeground, background: this.oscBackground },
						});
					}
				}
			}
			return true;
		}

		return false;
	}

	/** Current state snapshot; the caller cannot mutate the bus through it. */
	query(cap: ProbeCapability): CapabilityState {
		const state = this.states.get(cap)!;
		const snapshot: CapabilityState = { verdict: state.verdict, source: state.source };
		if (state.decrpmValue !== undefined) {
			snapshot.decrpmValue = state.decrpmValue;
		}
		if (state.defaultColors) {
			snapshot.defaultColors = {
				foreground: { ...state.defaultColors.foreground },
				background: { ...state.defaultColors.background },
			};
		}
		if (state.cellSize) {
			snapshot.cellSize = { ...state.cellSize };
		}
		return snapshot;
	}

	/** Fires on changes only; use query() for the current value. Returns the unsubscribe. */
	onChange(cap: ProbeCapability, listener: ProbeListener): () => void {
		let set = this.listeners.get(cap);
		if (!set) {
			set = new Set();
			this.listeners.set(cap, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.fallbackTimer) {
			clearTimeout(this.fallbackTimer);
			this.fallbackTimer = undefined;
		}
		this.listeners.clear();
		this.settleNow();
	}

	private isPending(cap: ProbeCapability): boolean {
		return this.states.get(cap)!.verdict === "pending";
	}

	private applyEnvOverride(cap: ProbeCapability): void {
		const value = this.env[ENV_VAR_PER_CAPABILITY[cap]];
		if (value === "0") {
			this.setState(cap, { verdict: "unsupported", source: "env-override" });
		} else if (value === "1") {
			this.setState(cap, { verdict: "supported", source: "env-override" });
		}
	}

	/** The fence (unsupported) or the fallback timer (unknown): first settle wins. */
	private settle(verdict: "unsupported" | "unknown"): void {
		if (this.settledFlag) {
			return;
		}
		this.settledFlag = true;
		if (this.fallbackTimer) {
			clearTimeout(this.fallbackTimer);
			this.fallbackTimer = undefined;
		}
		for (const cap of ALL_CAPABILITIES) {
			if (this.isPending(cap)) {
				this.setState(cap, { verdict, source: "default" });
			}
		}
		this.settleNow();
	}

	private settleNow(): void {
		this.settledFlag = true;
		this.resolveSettled();
	}

	private setStateUnlessOverridden(cap: ProbeCapability, next: CapabilityState): void {
		if (this.states.get(cap)!.source === "env-override") {
			return;
		}
		this.setState(cap, next);
	}

	private setState(cap: ProbeCapability, next: CapabilityState): void {
		const prev = this.states.get(cap)!;
		if (
			prev.verdict === next.verdict &&
			prev.source === next.source &&
			prev.decrpmValue === next.decrpmValue &&
			prev.cellSize?.widthPx === next.cellSize?.widthPx &&
			prev.cellSize?.heightPx === next.cellSize?.heightPx &&
			prev.defaultColors === next.defaultColors
		) {
			return;
		}
		this.states.set(cap, next);
		const set = this.listeners.get(cap);
		if (!set) {
			return;
		}
		const snapshot = this.query(cap);
		for (const listener of set) {
			listener(cap, snapshot);
		}
	}
}
