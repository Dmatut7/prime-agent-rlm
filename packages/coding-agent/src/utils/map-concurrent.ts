/**
 * Order-preserving bounded-concurrency map.
 *
 * Serial `for (const item of items) await fn(item)` loops over disk-backed work
 * pay one event-loop round trip per item even when the items are independent;
 * on a large catalog that round trip, not the I/O, is the cost. This runs at
 * most `limit` items at a time and still resolves/emit in input order, so
 * callers keep the deterministic ordering a serial loop gave them.
 */
export const DEFAULT_MAP_CONCURRENCY_LIMIT = 8;

export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	onResult?: (value: R, index: number) => void,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	if (items.length === 0) return results;
	const permits = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), items.length) : 1;
	let nextIndex = 0;
	let emitIndex = 0;
	const filled = new Array<boolean>(items.length).fill(false);
	// Synchronous and single-threaded, so a contiguously filled prefix is emitted
	// exactly once and in index order no matter which worker finishes first.
	const emitReady = (): void => {
		if (!onResult) return;
		while (emitIndex < items.length && filled[emitIndex]) {
			onResult(results[emitIndex]!, emitIndex);
			emitIndex++;
		}
	};
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex++;
			if (index >= items.length) return;
			const value = await fn(items[index]!, index);
			results[index] = value;
			filled[index] = true;
			emitReady();
		}
	};
	await Promise.all(Array.from({ length: permits }, worker));
	return results;
}
