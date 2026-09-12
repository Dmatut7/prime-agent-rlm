import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createStreamingJsonParseThrottle,
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
