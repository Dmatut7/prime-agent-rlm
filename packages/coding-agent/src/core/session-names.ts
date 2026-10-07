/**
 * Session names travel through untrusted hands: the model names subagents it
 * spawns, and those names end up in the terminal title OSC sequence, table
 * cells, and single-row chips. A name carrying BEL or ESC would terminate the
 * OSC early and inject escapes into the terminal (including OSC 52 clipboard
 * writes), and a newline breaks the one-logical-row contract of the lines that
 * render it. Strip control characters at every boundary instead of trusting
 * every producer.
 */

/** Remove C0/C1 control characters and DEL, collapsing nothing else. */
export function sanitizeSessionName(name: string): string {
	return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
