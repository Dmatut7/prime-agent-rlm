import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createStreamingJsonParseThrottle,
	finalizeThrottledStreamingJson,
	updateThrottledStreamingJson,
} from "../src/utils/streaming-json-throttle.js";

describe("streaming json parse throttle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("parses the first update immediately, including incomplete json", () => {
		vi.useFakeTimers();
		const throttle = createStreamingJsonParseThrottle();
		expect(throttle.update('{"path":"README')).toEqual({ path: "README" });
	});

	it("skips updates within the growth threshold until the interval elapses", () => {
		vi.useFakeTimers();
		const throttle = createStreamingJsonParseThrottle();
		expect(throttle.update('{"a":"1')).not.toBeNull();
		vi.advanceTimersByTime(10);
		expect(throttle.update('{"a":"12')).toBeNull();
		vi.advanceTimersByTime(40);
		expect(throttle.update('{"a":"123')).toEqual({ a: "123" });
	});

	it("re-parses on growth past the threshold before the interval elapses", () => {
		vi.useFakeTimers();
		const throttle = createStreamingJsonParseThrottle();
		expect(throttle.update('{"a":"xxx')).not.toBeNull();
		vi.advanceTimersByTime(5);
		const value = "x".repeat(2000);
		expect(throttle.update(`{"a":"${value}"`)).toEqual({ a: value });
	});

	it("skips when the buffer did not change", () => {
		vi.useFakeTimers();
		const throttle = createStreamingJsonParseThrottle();
		expect(throttle.update('{"a":"1"}')).toEqual({ a: "1" });
		vi.advanceTimersByTime(1000);
		expect(throttle.update('{"a":"1"}')).toBeNull();
	});

	it("tolerates malformed buffers like parseStreamingJson", () => {
		vi.useFakeTimers();
		const throttle = createStreamingJsonParseThrottle();
		expect(throttle.update("}{")).toEqual({});
	});

	it("tracks throttle state per block", () => {
		vi.useFakeTimers();
		const blockA = { partialJson: "" };
		const blockB = { partialJson: "" };
		expect(updateThrottledStreamingJson(blockA, '{"a":"1')).toEqual({ a: "1" });
		// A different block gets its own throttle, so its first update parses too.
		expect(updateThrottledStreamingJson(blockB, '{"b":"2')).toEqual({ b: "2" });
		vi.advanceTimersByTime(10);
		expect(updateThrottledStreamingJson(blockA, '{"a":"12')).toBeNull();
		expect(updateThrottledStreamingJson(blockB, '{"b":"22')).toBeNull();
	});
});

describe("finalizeThrottledStreamingJson", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-parses the partialJson scratch of an in-flight tool call", () => {
		const block = {
			type: "toolCall",
			id: "tool_1",
			name: "edit",
			arguments: { path: "REA" } as Record<string, unknown>,
			partialJson: '{"path":"README.md"}',
		};
		finalizeThrottledStreamingJson([block]);
		expect(block.arguments).toEqual({ path: "README.md" });
	});

	it("re-parses the partialArgs scratch used by openai-completions", () => {
		const block = {
			type: "toolCall",
			id: "call_1",
			name: "edit",
			arguments: {} as Record<string, unknown>,
			partialArgs: '{"path":"README.md"',
		};
		finalizeThrottledStreamingJson([block]);
		expect(block.arguments).toEqual({ path: "README.md" });
	});

	it("tolerates malformed scratch like parseStreamingJson", () => {
		const block = {
			type: "toolCall",
			id: "tool_1",
			name: "edit",
			arguments: { stale: true } as Record<string, unknown>,
			partialJson: "}{ not json",
		};
		finalizeThrottledStreamingJson([block]);
		expect(block.arguments).toEqual({});
	});

	it("leaves finalized blocks, other block types, and empty scratch untouched", () => {
		const finalized = { type: "toolCall", id: "tool_1", name: "edit", arguments: { path: "a.md" } };
		const text = { type: "text", text: "hi", partialJson: '{"ignored":true}' };
		const seeded = { type: "toolCall", id: "tool_2", name: "edit", arguments: { seeded: true }, partialJson: "" };
		finalizeThrottledStreamingJson([finalized, text, seeded]);
		expect(finalized.arguments).toEqual({ path: "a.md" });
		expect(text).toEqual({ type: "text", text: "hi", partialJson: '{"ignored":true}' });
		expect(seeded.arguments).toEqual({ seeded: true });
	});

	it("refreshes stale throttled parses when the last deltas were skipped", () => {
		vi.useFakeTimers();
		const block = {
			type: "toolCall",
			id: "tool_1",
			name: "edit",
			arguments: {} as Record<string, unknown>,
			partialJson: "",
		};
		block.partialJson += '{"path":"REA';
		const first = updateThrottledStreamingJson(block, block.partialJson);
		expect(first).toEqual({ path: "REA" });
		block.arguments = first ?? block.arguments;
		vi.advanceTimersByTime(10);
		block.partialJson += 'DME.md"}';
		// Skipped by the throttle, so arguments stay stale without the final parse.
		expect(updateThrottledStreamingJson(block, block.partialJson)).toBeNull();
		expect(block.arguments).toEqual({ path: "REA" });
		finalizeThrottledStreamingJson([block]);
		expect(block.arguments).toEqual({ path: "README.md" });
	});
});
