import { describe, expect, it, vi } from "vitest";
import { mapConcurrent } from "../src/utils/map-concurrent.js";

describe("mapConcurrent", () => {
	it("preserves input order no matter which item finishes first", async () => {
		const delays = [30, 1, 20, 2, 10];
		const results = await mapConcurrent(delays, 5, async (delay, index) => {
			await new Promise((resolve) => setTimeout(resolve, delay));
			return index;
		});
		expect(results).toEqual([0, 1, 2, 3, 4]);
	});

	it("never runs more items than the limit allows", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 40 }, (_unused, index) => index);
		const results = await mapConcurrent(items, 4, async (index) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
			return index * 2;
		});
		expect(peak).toBe(4);
		expect(results).toEqual(items.map((index) => index * 2));
	});

	it("runs independent items concurrently instead of one round trip each", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8], 8, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
		});
		expect(peak).toBe(8);
	});

	it("emits results through the callback in input order as the prefix completes", async () => {
		const emitted: number[] = [];
		// Item 0 is the slowest, so nothing may be emitted until it lands; after
		// that the whole contiguous prefix arrives at once, still in order.
		const delays = [25, 1, 1, 1];
		await mapConcurrent(
			delays,
			4,
			async (delay) => {
				await new Promise((resolve) => setTimeout(resolve, delay));
				return delay;
			},
			(value) => emitted.push(value),
		);
		expect(emitted).toEqual([25, 1, 1, 1]);
	});

	it("emits nothing ahead of an unfinished predecessor", async () => {
		const emitted: number[] = [];
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const done = mapConcurrent(
			[0, 1],
			2,
			async (index) => {
				if (index === 0) await gate;
				return index;
			},
			(value) => emitted.push(value),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(emitted).toEqual([]);
		releaseFirst?.();
		await done;
		expect(emitted).toEqual([0, 1]);
	});

	it("handles an empty input without starting a worker", async () => {
		const fn = vi.fn(async () => 1);
		await expect(mapConcurrent([], 4, fn)).resolves.toEqual([]);
		expect(fn).not.toHaveBeenCalled();
	});

	it("clamps a nonsensical limit to a serial walk", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapConcurrent([1, 2, 3], 0, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
		});
		expect(peak).toBe(1);
	});

	it("propagates a failure instead of swallowing it", async () => {
		await expect(
			mapConcurrent([1, 2, 3], 2, async (index) => {
				if (index === 2) throw new Error("boom");
				return index;
			}),
		).rejects.toThrow("boom");
	});
});
