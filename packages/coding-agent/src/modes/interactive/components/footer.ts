import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/** U6 footer telemetry switch (settings `footer.telemetry`); `on` renders the watermark line. */
export type FooterTelemetryMode = "off" | "on";

/** U2: consecutive errored tool results at which the warning badge appears. */
export const TOOL_ERROR_WARN_THRESHOLD = 3;

/** Cells of the watermark bar: `──────●───────│──` (● = level, │ = compaction notch). */
const WATERMARK_BAR_CELLS = 16;

/** Four-space gap between the line's groups (model, bar, figures, hint). */
const GROUP_GAP = "    ";

/**
 * U6 layout discipline: below 80 columns the bar goes first, then the token
 * figures - the model name never truncates into a wrong number.
 */
const WATERMARK_BAR_MIN_WIDTH = 80;

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
	if (tokens >= 1_000_000) {
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
	let bar = "";
	for (let i = 0; i < cells; i++) {
		if (i === levelCell) {
			bar += theme.fg("accent", "●");
		} else if (i === notchCell) {
			bar += theme.fg(imminent ? "warning" : "dim", "│");
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

	/** U2: trailing consecutive tool errors; the badge renders from TOOL_ERROR_WARN_THRESHOLD. */
	setToolErrorCount(count: number): void {
		this.toolErrorCount = count;
	}

	/**
	 * U6 watermark line: `glm-5.3-prime · max    ──────●───────│──    518k/1M · 49%`.
	 *
	 * `●` marks the context level, `│` the auto-compaction notch; reaching the
	 * notch is the only threshold state (the notch brightens and the line tail
	 * reads 压缩在即). Degradation on narrow widths: bar first, then the token
	 * figures; the model segment is never dropped.
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
		const model = theme.fg("muted", modelText);
		const tokens = snapshot.contextTokens;
		const windowTokens = snapshot.contextWindow ?? 0;
		const knownContext = tokens !== undefined && tokens !== null && windowTokens > 0;
		const threshold = snapshot.compactionThresholdTokens ?? 0;
		// 评审③: the notch and the tail read the real threshold (settings-driven,
		// reserve-capped); threshold compaction off means neither renders.
		const imminent = knownContext && threshold > 0 && tokens >= threshold;
		const tail = imminent ? `${GROUP_GAP}${theme.fg("warning", "压缩在即")}` : "";
		const figures = knownContext
			? theme.fg(
					"muted",
					`${formatContextTokens(tokens, windowTokens)} · ${Math.round((tokens / windowTokens) * 100)}%`,
				)
			: "";
		const bar =
			knownContext && threshold > 0 && safeWidth >= WATERMARK_BAR_MIN_WIDTH
				? watermarkBar(tokens, windowTokens, threshold, imminent)
				: "";

		// Degradation ladder, richest first: bar and figures, bar only, figures only,
		// model alone. A truncated figure would read as a wrong number, so segments
		// drop whole instead of ellipsizing.
		const candidates = [
			`${model}${bar ? `${GROUP_GAP}${bar}` : ""}${figures ? `${GROUP_GAP}${figures}` : ""}${tail}`,
		];
		if (bar) {
			candidates.push(`${model}${GROUP_GAP}${bar}${tail}`);
		}
		if (figures) {
			candidates.push(`${model}${GROUP_GAP}${figures}${tail}`);
		}
		candidates.push(`${model}${tail}`);
		for (const candidate of candidates) {
			if (visibleWidth(candidate) <= safeWidth) {
				return candidate;
			}
		}
		return truncateToWidth(`${model}${tail}`, safeWidth, "");
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
