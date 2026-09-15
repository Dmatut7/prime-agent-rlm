/**
 * A module-level cache with a ceiling.
 *
 * Two round-14 leak findings (L1 `rlm-subagent-display`, L2
 * `session-artifact-tombstones`) had the same shape: a `Map` keyed by an
 * on-disk path, one entry per path the process had ever read, no bound, no
 * expiry, and eviction only on the invalidation paths of that same key. A
 * directory removed by a delete or a retention sweep therefore left its entry
 * behind forever, because nothing reads a path that is gone.
 *
 * This gives both of them the two properties the audit asked for:
 * - a hard ceiling on entry count and on estimated retained bytes, so growth
 *   stops at a constant instead of at the number of sessions ever seen;
 * - eviction that does not depend on the evicted key: least-recently-used
 *   entries go first under pressure, and entries untouched for `idleTtlMs` go
 *   at the next insert, so a key nobody reads again cannot outlive the TTL.
 *
 * Recency is Map insertion order (a hit re-inserts the key), the same trick
 * `HandledAgentMessageIds` uses. Sweeps are insert-triggered with a minimum
 * interval, never `setInterval`: a cache must not add a timer, a handle, or a
 * reason for the event loop to stay alive.
 */
export interface BoundedCacheOptions<V> {
	/** Ceiling on cached keys. Values beyond the ceiling evict the least recently used. */
	maxEntries: number;
	/** Ceiling on summed estimated bytes. One value above it is not cached at all. */
	maxBytes: number;
	/** Estimated retained bytes of one value; the key length is added by the cache. */
	estimateBytes: (value: V, key: string) => number;
	/** Drop entries untouched for this long. 0 disables idle expiry. */
	idleTtlMs?: number;
	/** Minimum distance between idle sweeps. */
	sweepIntervalMs?: number;
}

interface BoundedCacheRecord<V> {
	value: V;
	bytes: number;
	touchedAt: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 1000;

export class BoundedCache<V> {
	private readonly records = new Map<string, BoundedCacheRecord<V>>();
	private bytes = 0;
	private lastSweepAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly options: BoundedCacheOptions<V>) {}

	/** Cached key count. */
	get size(): number {
		return this.records.size;
	}

	/** Summed estimated bytes of what is cached, keys included. */
	get estimatedBytes(): number {
		return this.bytes;
	}

	/** The stored value, or undefined. A hit refreshes the key's recency and its idle clock. */
	get(key: string): V | undefined {
		const record = this.records.get(key);
		if (record === undefined) return undefined;
		this.records.delete(key);
		this.records.set(key, record);
		record.touchedAt = Date.now();
		return record.value;
	}

	has(key: string): boolean {
		return this.records.has(key);
	}

	set(key: string, value: V): void {
		const now = Date.now();
		// Overwriting a key drops the record it replaces, so its bytes leave the account first.
		// Both consumers refresh the same key on their hot path (a watched file is rewritten on
		// every heartbeat), and bytes that no record owns are bytes no eviction can reclaim: they
		// would accumulate to the ceiling, empty the cache, and leave it refusing every write for
		// the rest of the process's life.
		const replaced = this.records.get(key);
		if (replaced !== undefined) {
			this.bytes = Math.max(0, this.bytes - replaced.bytes);
			this.records.delete(key);
		}
		const bytes = this.options.estimateBytes(value, key) + key.length;
		if (bytes > this.options.maxBytes) {
			// Caching it would break the ceiling by itself and evict the whole working
			// set for one payload: leave it uncached and let the next read do the work.
			return;
		}
		this.records.set(key, { value, bytes, touchedAt: now });
		this.bytes += bytes;
		this.evictToCeiling();
		this.sweepIdle(now);
	}

	delete(key: string): boolean {
		const record = this.records.get(key);
		if (record === undefined) return false;
		this.bytes = Math.max(0, this.bytes - record.bytes);
		return this.records.delete(key);
	}

	clear(): void {
		this.records.clear();
		this.bytes = 0;
	}

	private evictToCeiling(): void {
		const maxEntries = Math.max(1, this.options.maxEntries);
		while (this.records.size > maxEntries && this.records.size > 0) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
		while (this.bytes > this.options.maxBytes && this.records.size > 0) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
	}

	/**
	 * Expire entries nobody has touched for `idleTtlMs`. Called from inserts only:
	 * a process that stops reading also stops allocating, so memory left behind
	 * while idle is not growth, and this keeps the sweep off the read path.
	 */
	private sweepIdle(now: number): void {
		const idleTtlMs = this.options.idleTtlMs ?? 0;
		if (idleTtlMs <= 0) return;
		if (now - this.lastSweepAt < (this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)) return;
		this.lastSweepAt = now;
		for (const [key, record] of this.records) {
			if (now - record.touchedAt > idleTtlMs) this.delete(key);
		}
	}
}
