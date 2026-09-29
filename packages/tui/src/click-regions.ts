/**
 * Click regions: components record them during render() in their own
 * render-output coordinates; containers aggregate them with line offsets
 * and the fullscreen viewport projects them onto screen rows.
 */

/** Position of a click relative to the clicked region's top-left cell. */
export interface ClickPosition {
	/** Zero-based row within the region. */
	row: number;
	/** Zero-based column within the region. */
	col: number;
}

/** A rectangular clickable area produced by a component render. */
export interface ClickRegion {
	/** Zero-based line of the region's top row within the component's rendered output. */
	line: number;
	/** Zero-based visible column of the region's left edge. */
	col: number;
	/** Region width in visible columns. */
	width: number;
	/** Region height in rows. */
	height: number;
	/**
	 * Rows a click on this region opens directly below it (an expandable row that
	 * is collapsed now). The fullscreen viewport keeps the clicked row where it
	 * was and scrolls just enough to show those rows, never pushing the clicked
	 * row off the top.
	 */
	revealBelow?: number;
	/** Not a click target (clicks go on as if the region were absent); only its `onWheel` applies. */
	passive?: boolean;
	onClick: (position: ClickPosition) => void;
	/**
	 * Mouse wheel over the region in the fullscreen viewport (-1 up, 1 down).
	 * Return true when the region scrolled its own content; false lets the
	 * transcript scroll instead (it reached that end, or has nothing to scroll).
	 */
	onWheel?: (direction: -1 | 1) => boolean;
	/** Stable identity of the region across frames; required for hover (regions are rebuilt every render). */
	hoverKey?: string;
	/**
	 * Called with true when the pointer enters this region and false when it leaves (fullscreen with mouse tracking only).
	 * It may only change colors and styles: the number of rows and the position of regions must stay
	 * the same, because the hover is re-checked against the pointer after every frame.
	 */
	onHover?: (hovered: boolean) => void;
}

/**
 * A header a component keeps on screen while the rows it heads scroll under the
 * top of the fullscreen transcript window (the header of a box taller than the
 * screen). Containers aggregate these with line offsets, like click regions.
 */
export interface StickyHeader {
	/** Zero-based line of the header's first row within the component's rendered output. */
	line: number;
	/** Zero-based line of the last row the header belongs to (the end of its box). */
	endLine: number;
	/** Rows painted over the top of the transcript window while the header is pinned. */
	lines: readonly string[];
	/** Click regions of the pinned rows, in `lines` coordinates. */
	regions?: ReadonlyArray<ClickRegion>;
}
