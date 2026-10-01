import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Width-aware truncation for " · "-joined hint segments (key hints). A plain
 * truncateToWidth of the joined line cuts wherever the width lands - in the worst case
 * mid-key ("Ctrl+D" → "Ctr") on the line whose whole job is listing keys. Truncation
 * here drops whole trailing segments behind an ellipsis; only a first segment that alone
 * exceeds the width gets a hard ellipsis cut.
 */

const SEGMENT_SEPARATOR = " · ";
const ELLIPSIS = "…";

export function joinHintSegments(
	segments: readonly string[],
	width: number,
	separator: string = SEGMENT_SEPARATOR,
): string {
	const safeWidth = Math.max(0, Math.floor(width));
	if (segments.length === 0 || safeWidth === 0) return "";
	const ellipsisSuffix = `${separator}${ELLIPSIS}`;
	const suffixWidth = visibleWidth(ellipsisSuffix);

	let result = "";
	let kept = 0;
	for (const [index, segment] of segments.entries()) {
		const candidate = kept === 0 ? segment : `${result}${separator}${segment}`;
		// Keep room for the drop marker while segments remain; the last one needs none.
		const budget = index < segments.length - 1 ? safeWidth - suffixWidth : safeWidth;
		if (visibleWidth(candidate) > budget) break;
		result = candidate;
		kept++;
	}
	if (kept === segments.length) return result;
	if (kept === 0) {
		// The first segment alone fits only without the marker; narrower still gets a cut.
		return visibleWidth(segments[0] ?? "") <= safeWidth
			? (segments[0] ?? "")
			: truncateToWidth(segments[0] ?? "", safeWidth, ELLIPSIS);
	}
	return `${result}${ellipsisSuffix}`;
}

export class SegmentedHintText implements Component {
	constructor(
		private readonly segments: readonly string[],
		private readonly separator: string = SEGMENT_SEPARATOR,
	) {}

	invalidate(): void {
		// Render is derived from the constructor's segments.
	}

	render(width: number): string[] {
		return [joinHintSegments(this.segments, width, this.separator)];
	}
}
