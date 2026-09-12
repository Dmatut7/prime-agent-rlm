import { parseStreamingJson } from "./json-parse.js";

/**
 * Incremental parse throttle for streamed tool-call arguments.
 *
 * Providers deliver tool-call arguments as many small deltas. Re-parsing the
 * full accumulated buffer on every delta is quadratic in the argument length,
 * so mid-stream parses are throttled: re-parse only when the buffer grew by at
 * least MIN_PARSE_GROWTH_CHARS, or at least MIN_PARSE_INTERVAL_MS elapsed since
 * the last parse. A skipped update returns null and the caller keeps the
 * previous parse, so block-end handling must still do an unthrottled final
 * parse, which is authoritative.
 */
const MIN_PARSE_GROWTH_CHARS = 1024;
const MIN_PARSE_INTERVAL_MS = 50;

export interface StreamingJsonParseThrottle {
	/** Returns a fresh parse of `buffer`, or null when the throttle skipped this update. */
	update(buffer: string): Record<string, unknown> | null;
}

export function createStreamingJsonParseThrottle(): StreamingJsonParseThrottle {
	let lastParsedLength = 0;
	let lastParseTime = 0;
	return {
		update(buffer) {
			if (buffer.length === lastParsedLength) {
				return null;
			}
			const now = Date.now();
			if (buffer.length - lastParsedLength < MIN_PARSE_GROWTH_CHARS && now - lastParseTime < MIN_PARSE_INTERVAL_MS) {
				return null;
			}
			lastParsedLength = buffer.length;
			lastParseTime = now;
			return parseStreamingJson(buffer);
		},
	};
}

const throttlesByBlock = new WeakMap<object, StreamingJsonParseThrottle>();

/**
 * Throttled parseStreamingJson keyed by the owning content block, for per-block
 * streaming buffers. Returns null when the parse was skipped; the caller keeps
 * the previously parsed arguments in that case.
 */
export function updateThrottledStreamingJson(block: object, buffer: string): Record<string, unknown> | null {
	let throttle = throttlesByBlock.get(block);
	if (!throttle) {
		throttle = createStreamingJsonParseThrottle();
		throttlesByBlock.set(block, throttle);
	}
	return throttle.update(buffer);
}
