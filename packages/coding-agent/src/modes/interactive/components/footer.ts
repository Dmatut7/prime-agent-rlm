import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/** U1 footer telemetry density (settings `footer.telemetry`). */
export type FooterTelemetryMode = "off" | "compact" | "full";

/** Context watermark data for the persistent footer line. */
export interface FooterTelemetrySnapshot {
	modelName?: string;
	contextTokens?: number | null;
	contextWindow?: number;
	/** Auto-compaction trigger ratio (0..1); rendered as the compaction line. */
	compactionTriggerRatio?: number;
	/** GLM-family storm-zone threshold in tokens; marked on the line when set. */
	glmStormTokens?: number;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		// 1M, not 1.0M: exact powers of a million read cleaner in the footer.
		return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}
	return String(tokens);
}

/** Proportional bar with the compaction line and (when in range) the storm zone marker. */
function watermarkBar(tokens: number, windowTokens: number, snapshot: FooterTelemetrySnapshot, cells = 12): string {
	const filled = Math.max(0, Math.min(cells, Math.round((tokens / windowTokens) * cells)));
	const compactionCell =
		snapshot.compactionTriggerRatio !== undefined
			? Math.max(0, Math.min(cells - 1, Math.round(snapshot.compactionTriggerRatio * cells)))
			: -1;
	const stormCell =
		snapshot.glmStormTokens !== undefined && snapshot.glmStormTokens <= windowTokens
			? Math.max(0, Math.min(cells - 1, Math.round((snapshot.glmStormTokens / windowTokens) * cells)))
			: -1;
	let bar = "";
	for (let i = 0; i < cells; i++) {
		if (i === compactionCell) {
			bar += "┊";
		} else if (i === stormCell) {
			bar += "⌁";
		} else {
			bar += i < filled ? "█" : "·";
		}
	}
	return `[${bar}]`;
}

/**
 * Footer component for the prime brand TUI.
 *
 * Renders nothing by default — token counters, cost, model name, cwd, and context %
 * are intentionally hidden. The setters and invalidate/dispose hooks are kept so the
 * existing call sites in interactive-mode keep working without modification, and so
 * `/usage` can expose telemetry without re-plumbing. `/speed` opts the footer into a
 * compact tok/sec readout; see setSpeedEnabled/setSpeedText. The U1 watermark line
 * (`模型名 · ctx 312k/1M(38%) ▍压缩线80%`, plus the GLM storm zone marker) is a
 * persistent one-liner driven by setTelemetryMode/setTelemetry.
 */
export class FooterComponent implements Component {
	// Stable reference so the parent aggregator's identity check can hit while the footer is empty.
	private readonly emptyLines: string[] = [];
	private speedEnabled = false;
	private speedText: string | undefined;
	private telemetryMode: FooterTelemetryMode = "off";
	private telemetry: FooterTelemetrySnapshot | undefined;

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

	/** U1: persistent telemetry line density; off hides the watermark entirely. */
	setTelemetryMode(mode: FooterTelemetryMode): void {
		this.telemetryMode = mode;
	}

	/** U1: latest context watermark snapshot; undefined clears the numbers. */
	setTelemetry(snapshot: FooterTelemetrySnapshot | undefined): void {
		this.telemetry = snapshot;
	}

	private telemetryText(): string | undefined {
		if (this.telemetryMode === "off" || !this.telemetry) {
			return undefined;
		}
		const snapshot = this.telemetry;
		const parts: string[] = [];
		if (snapshot.modelName) {
			parts.push(snapshot.modelName);
		}
		if (
			snapshot.contextTokens !== undefined &&
			snapshot.contextTokens !== null &&
			(snapshot.contextWindow ?? 0) > 0
		) {
			const tokens = snapshot.contextTokens;
			const windowTokens = snapshot.contextWindow ?? 0;
			const percent = Math.round((tokens / windowTokens) * 100);
			parts.push(`ctx ${formatTokens(tokens)}/${formatTokens(windowTokens)}(${percent}%)`);
		}
		if (parts.length === 0) {
			return undefined;
		}
		let line = ` ${parts.join(" · ")}`;
		if (snapshot.compactionTriggerRatio !== undefined && snapshot.compactionTriggerRatio > 0) {
			line += ` ▍压缩线${Math.round(snapshot.compactionTriggerRatio * 100)}%`;
		}
		if (snapshot.glmStormTokens !== undefined && (snapshot.contextWindow ?? 0) >= snapshot.glmStormTokens) {
			line += ` ⚡风暴线${formatTokens(snapshot.glmStormTokens)}`;
		}
		if (this.telemetryMode === "full" && snapshot.contextTokens != null && (snapshot.contextWindow ?? 0) > 0) {
			line += ` ${watermarkBar(snapshot.contextTokens, snapshot.contextWindow ?? 0, snapshot)}`;
		}
		return line;
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
		// Telemetry (U1 watermark) is one persistent line; /speed appends its own
		// line when enabled. The stable empty reference keeps the parent
		// aggregator's identity check hitting while the footer is empty.
		const safeWidth = Math.max(1, width);
		const telemetry = this.telemetryText();
		if (!telemetry && (!this.speedEnabled || !this.speedText)) {
			return this.emptyLines;
		}
		const lines: string[] = [];
		if (telemetry) {
			lines.push(theme.fg("dim", truncateToWidth(telemetry, safeWidth, "")));
		}
		if (this.speedEnabled && this.speedText) {
			const text =
				visibleWidth(this.speedText) > safeWidth ? truncateToWidth(this.speedText, safeWidth, "") : this.speedText;
			lines.push(theme.fg("dim", text));
		}
		return lines;
	}
}
