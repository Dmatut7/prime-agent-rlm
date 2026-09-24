import { homedir } from "node:os";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/** U6 footer telemetry switch (settings `footer.telemetry`); `on` renders the watermark line. */
export type FooterTelemetryMode = "off" | "on";

/** U2: consecutive errored tool results at which the warning badge appears. */
export const TOOL_ERROR_WARN_THRESHOLD = 3;

/** Cells of the watermark bar: `──────●───────│──` (● = level, │ = compaction notch). */
const WATERMARK_BAR_CELLS = 16;

/** Gap between the line's groups (model, location, bar, figures). */
const GROUP_GAP = "   ";

/** The bar only appears once the context reaches this share of the compaction threshold. */
const WATERMARK_BAR_MIN_LEVEL = 0.5;

/** Where the session runs, for the status line's location group. */
export interface FooterLocation {
	cwd: string;
	branch?: string | null;
}

function displayCwd(cwd: string): string {
	const home = homedir();
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

/** U6 评审②: the pull source behind the watermark line - mode and snapshot as one frame-consistent pair. */
export interface FooterTelemetrySource {
	mode: FooterTelemetryMode;
	snapshot?: FooterTelemetrySnapshot;
}

/** Context watermark data for the persistent footer line. */
export interface FooterTelemetrySnapshot {
	modelName?: string;
	/** Current thinking level (e.g. "max"), rendered after the model id. */
	thinkingLevel?: string;
	/**
	 * The model that actually served the latest assistant message. While the
	 * provider fallback chain answers with someone other than the configured
	 * model, the status line names the real server - a footer that shows the
	 * configured id during a fallback episode quietly lies about who answers.
	 */
	servingModelName?: string;
	contextTokens?: number | null;
	contextWindow?: number;
	/**
	 * The REAL auto-compaction threshold in tokens, from
	 * compactionThresholdTokens (ratio × base, minus the reserve ceiling). 0 or
	 * undefined means threshold compaction is off: no notch, no imminent tail
	 * (评审③ - the bar never reports a threshold that does not exist).
	 */
	compactionThresholdTokens?: number;
}

/**
 * Token figure shared by every context readout: `518k/1M`, `1.2M/2M`.
 * Exact powers (and near-powers like a 1,048,576 window) read as 1M, not 1.0M.
 */
export function formatContextTokens(tokens: number, windowTokens: number): string {
	return `${formatTokens(tokens)}/${formatTokens(windowTokens)}`;
}

function formatTokens(tokens: number): string {
	// F6 (DS2 review): 999,600 tokens rounding to "1000k" reads like an
	// overflow next to the window's "1M" - within half a k of the next
	// million, promote to the M form.
	if (tokens >= 999_500) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}
	return String(tokens);
}

/**
 * The watermark bar: a rail of `─` with `●` at the current level and `│` at
 * the compaction notch (the threshold's fraction of the window). The notch
 * brightens once the level reaches it (the tail text carries the same state).
 */
function watermarkBar(tokens: number, windowTokens: number, thresholdTokens: number, imminent: boolean): string {
	const cells = WATERMARK_BAR_CELLS;
	const levelCell = Math.max(0, Math.min(cells - 1, Math.round((tokens / windowTokens) * cells)));
	const notchCell = Math.max(0, Math.min(cells - 1, Math.round((thresholdTokens / windowTokens) * cells)));
	// F3 (DS2 review): when the level rounds onto the notch, the NOTCH keeps its
	// cell and the level marker takes the next one - the notch is the static
	// scale and must stay readable in the whole band around the threshold, or
	// the crossing itself is invisible.
	const notchWins = levelCell === notchCell;
	let levelAt = notchWins ? Math.min(cells - 1, levelCell + 1) : levelCell;
	// P1-A edge: the displacement clamps back onto the notch when the notch is
	// the last cell (a 0.95 ratio) - there is no room to the right, so the level
	// renders IN the notch cell wearing the imminent color: the crossing stays
	// visible exactly where the scale ends.
	const fused = notchWins && levelAt === notchCell;
	if (fused) {
		levelAt = -1;
	}
	let bar = "";
	for (let i = 0; i < cells; i++) {
		if (i === notchCell) {
			bar += fused ? theme.fg(imminent ? "warning" : "accent", "●") : theme.fg(imminent ? "warning" : "dim", "│");
		} else if (i === levelAt) {
			bar += theme.fg("accent", "●");
		} else {
			bar += theme.fg("dim", "─");
		}
	}
	return bar;
}

/**
 * Footer component for the prime brand TUI.
 *
 * Renders nothing by default — token counters, cost, model name, cwd, and context %
 * are intentionally hidden. The setters and invalidate/dispose hooks are kept so the
 * existing call sites in interactive-mode keep working without modification, and so
 * `/usage` can expose telemetry without re-plumbing. `/speed` opts the footer into a
 * compact tok/sec readout; see setSpeedEnabled/setSpeedText. The U6 watermark line
 * (`glm-5.3-prime · max    ──────●───────│──    518k/1M · 49%`) is a persistent
 * one-liner driven by a pull source (评审②): the mode and the snapshot are read
 * at render time from the same getter the tray fallback reads, so the two lines
 * can never disagree — one frame, one value.
 */
export class FooterComponent implements Component {
	// Stable reference so the parent aggregator's identity check can hit while the footer is empty.
	private readonly emptyLines: string[] = [];
	private speedEnabled = false;
	private speedText: string | undefined;
	private telemetrySource: (() => FooterTelemetrySource) | undefined;
	private locationSource: (() => FooterLocation | undefined) | undefined;
	private activitySource: (() => string | undefined) | undefined;
	private toolErrorCount = 0;

	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op while the footer is empty
	}

	/** /speed toggle: when enabled, render the tok/sec text set via setSpeedText. */
	setSpeedEnabled(enabled: boolean): void {
		this.speedEnabled = enabled;
		if (!enabled) {
			this.speedText = undefined;
		}
	}

	/** Latest tok/sec readout computed by interactive-mode from completed model responses. */
	setSpeedText(text: string | undefined): void {
		this.speedText = text;
	}

	/**
	 * U6 评审②: the watermark's pull source, read once per render. The tray
	 * fallback reads the same getter, so both faces of the context usage show
	 * one frame's value.
	 */
	setTelemetrySource(source: () => FooterTelemetrySource): void {
		this.telemetrySource = source;
	}

	/** The cwd and git branch shown between the model and the context figures. */
	setLocationSource(source: () => FooterLocation | undefined): void {
		this.locationSource = source;
	}

	/** The live activity (`◈ 运行中 12s`) shown right-aligned before the context figures while a turn runs. */
	setActivitySource(source: () => string | undefined): void {
		this.activitySource = source;
	}

	/** U2: trailing consecutive tool errors; the badge renders from TOOL_ERROR_WARN_THRESHOLD. */
	setToolErrorCount(count: number): void {
		this.toolErrorCount = count;
	}

	/**
	 * The status line: `glm-5.3-prime · max   ~/repo · main          21k/1M · 2%`.
	 *
	 * Model and location on the left, the context figures right-aligned. The
	 * watermark bar (`●` level, `│` compaction notch) joins the figures only
	 * once the context reaches half the compaction threshold, and reaching the
	 * threshold turns the figures warning-colored with `即将压缩`. Narrow
	 * widths drop the location first, then the bar, then the figures; the
	 * model never drops and segments never truncate into a wrong number.
	 */
	private telemetryText(safeWidth: number): string | undefined {
		const source = this.telemetrySource?.();
		if (!source || source.mode === "off" || !source.snapshot) {
			return undefined;
		}
		const snapshot = source.snapshot;
		const modelName = snapshot.modelName;
		if (!modelName) {
			return undefined;
		}
		const modelText = snapshot.thinkingLevel ? `${modelName} · ${snapshot.thinkingLevel}` : modelName;
		const serving = snapshot.servingModelName;
		const servingNote = serving && serving !== modelName ? theme.fg("warning", ` 实际:${serving}`) : "";
		const model = ` ${theme.fg("muted", modelText)}${servingNote}`;
		const location = this.locationSource?.();
		const locationText = location
			? [displayCwd(location.cwd), location.branch ?? undefined].filter((part) => part).join(" · ")
			: "";
		const locationGroup = locationText ? `${GROUP_GAP}${theme.fg("dim", locationText)}` : "";
		const tokens = snapshot.contextTokens;
		const windowTokens = snapshot.contextWindow ?? 0;
		const knownContext = tokens !== undefined && tokens !== null && windowTokens > 0;
		const threshold = snapshot.compactionThresholdTokens ?? 0;
		const imminent = knownContext && threshold > 0 && tokens >= threshold;
		const figuresText = knownContext
			? `${formatContextTokens(tokens, windowTokens)} · ${Math.round((tokens / windowTokens) * 100)}%${imminent ? " · 即将压缩" : ""}`
			: "";
		const figures = figuresText ? theme.fg(imminent ? "warning" : "muted", `${figuresText} `) : "";
		const bar =
			knownContext && threshold > 0 && tokens >= threshold * WATERMARK_BAR_MIN_LEVEL
				? `${watermarkBar(tokens, windowTokens, threshold, imminent)}  `
				: "";

		const activityText = this.activitySource?.()?.trim();
		const activity = activityText ? `${activityText}${GROUP_GAP}` : "";
		const layouts: Array<[string, string]> = [
			[`${model}${locationGroup}`, `${activity}${bar}${figures}`],
			[model, `${activity}${bar}${figures}`],
			[model, `${activity}${figures}`],
			[model, figures],
			[model, ""],
		];
		for (const [left, right] of layouts) {
			const gap = right ? 2 : 0;
			const used = visibleWidth(left) + gap + visibleWidth(right);
			if (used <= safeWidth) {
				return `${left}${" ".repeat(Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(right)))}${right}`;
			}
		}
		return truncateToWidth(model, safeWidth, "…");
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		// Telemetry (U6 watermark) is one persistent line; /speed appends its own
		// line when enabled. The stable empty reference keeps the parent
		// aggregator's identity check hitting while the footer is empty.
		const safeWidth = Math.max(1, width);
		const toolErrorBadge =
			this.toolErrorCount >= TOOL_ERROR_WARN_THRESHOLD ? `⚠ 工具错误×${this.toolErrorCount}` : undefined;
		// F1 (DS2 review): one width ledger. The badge rides the watermark line,
		// so the watermark's own ladder runs against the width the badge leaves
		// - segments still drop whole, never a truncated "5" that reads as a
		// number. (The badge's visible width is the plain string; the color
		// wrapper adds zero columns.)
		const telemetry = this.telemetryText(
			toolErrorBadge ? Math.max(1, safeWidth - toolErrorBadge.length - 1) : safeWidth,
		);
		if (!telemetry && !toolErrorBadge && (!this.speedEnabled || !this.speedText)) {
			return this.emptyLines;
		}
		const lines: string[] = [];
		if (telemetry && toolErrorBadge) {
			lines.push(`${telemetry} ${theme.fg("warning", toolErrorBadge)}`);
		} else if (telemetry) {
			lines.push(truncateToWidth(telemetry, safeWidth, ""));
		} else if (toolErrorBadge) {
			lines.push(theme.fg("warning", truncateToWidth(` ${toolErrorBadge}`, safeWidth, "")));
		}
		if (this.speedEnabled && this.speedText) {
			const text =
				visibleWidth(this.speedText) > safeWidth ? truncateToWidth(this.speedText, safeWidth, "") : this.speedText;
			lines.push(theme.fg("dim", text));
		}
		return lines;
	}
}
