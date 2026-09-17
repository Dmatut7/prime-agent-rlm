import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const SNAPSHOT_TARGET_CHUNK_BYTES = 512 * 1024;
export const SNAPSHOT_MEMORY_CACHE_BYTES = 4 * 1024 * 1024;

interface SnapshotTranscriptChunk {
	buffer?: Buffer;
	path?: string;
}

export interface SnapshotTranscriptCacheOptions {
	activeSessionId: string;
	snapshotId: string;
	messages?: readonly AgentMessage[];
	cacheRoot: string;
	targetChunkBytes?: number;
	memoryCacheBytes?: number;
}

export type SnapshotTranscriptChunkSource = (Iterable<Buffer> | AsyncIterable<Buffer>) & {
	markFailed?(error: Error): void;
	dispose?(): void;
};

/** The frame `createSnapshotTranscriptChunks` and `SnapshotTranscriptCache` both emit. */
interface SnapshotTranscriptChunkFrame {
	type: "session_snapshot_chunk";
	activeSessionId: string;
	snapshotId: string;
	index: number;
	messages: AgentMessage[];
}

function isSnapshotTranscriptChunkFrame(value: unknown): value is SnapshotTranscriptChunkFrame {
	if (!value || typeof value !== "object") {
		return false;
	}
	const frame = value as Partial<SnapshotTranscriptChunkFrame>;
	return (
		frame.type === "session_snapshot_chunk" &&
		typeof frame.activeSessionId === "string" &&
		typeof frame.snapshotId === "string" &&
		typeof frame.index === "number" &&
		Array.isArray(frame.messages)
	);
}

/**
 * Memoizes the per-message JSON serialization of one session transcript.
 *
 * The worker serves every attached client from the same live message array, and
 * each snapshot transfer (attach, replacement, catch-up) used to walk it with a
 * fresh `JSON.stringify` per message — once per client. This cache holds the
 * serialized strings for the exact message-object sequence it last encoded: an
 * O(n) pointer comparison detects a hit, so a repeated transfer of an unchanged
 * transcript costs no re-encoding. A miss (new, replaced or re-ordered message
 * objects) re-encodes, which is exactly the pre-cache behavior. A session that
 * mutates a message object in place while keeping the array identity would go
 * stale, so callers must only use the cache while the session is not streaming.
 */
export class TranscriptMessageSerializationCache {
	private entry?: { messages: AgentMessage[]; serialized: string[] };

	serialize(messages: readonly AgentMessage[]): string[] {
		const entry = this.entry;
		if (
			entry &&
			entry.messages.length === messages.length &&
			entry.messages.every((message, index) => message === messages[index])
		) {
			return entry.serialized;
		}
		const serialized = messages.map((message) => JSON.stringify(message));
		this.entry = { messages: [...messages], serialized };
		return serialized;
	}
}

export function createSnapshotTranscriptChunks(options: {
	activeSessionId: string;
	snapshotId: string;
	messages: readonly AgentMessage[];
	/** Pre-serialized messages (e.g. from a {@link TranscriptMessageSerializationCache}); overrides per-message JSON.stringify. */
	serializedMessages?: string[];
	targetChunkBytes?: number;
	signal?: AbortSignal;
}): Iterable<Buffer> {
	const messages = [...options.messages];
	const preSerializedMessages = options.serializedMessages;
	const targetChunkBytes = options.targetChunkBytes ?? SNAPSHOT_TARGET_CHUNK_BYTES;
	return {
		*[Symbol.iterator](): Iterator<Buffer> {
			options.signal?.throwIfAborted();
			let chunkMessages: string[] = [];
			let serializedBytes = 0;
			let index = 0;
			const flush = (): Buffer | undefined => {
				if (chunkMessages.length === 0) {
					return undefined;
				}
				const prefix =
					`{"type":"session_snapshot_chunk","activeSessionId":${JSON.stringify(options.activeSessionId)},` +
					`"snapshotId":${JSON.stringify(options.snapshotId)},"index":${index},"messages":[`;
				const line = Buffer.from(`${prefix}${chunkMessages.join(",")}]}\n`);
				chunkMessages = [];
				serializedBytes = 0;
				index++;
				return line;
			};

			for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
				options.signal?.throwIfAborted();
				const serialized = preSerializedMessages?.[messageIndex] ?? JSON.stringify(messages[messageIndex]!);
				const bytes = Buffer.byteLength(serialized) + (chunkMessages.length > 0 ? 1 : 0);
				if (chunkMessages.length > 0 && serializedBytes + bytes > targetChunkBytes) {
					const chunk = flush();
					if (chunk) yield chunk;
				}
				chunkMessages.push(serialized);
				serializedBytes += bytes;
			}
			options.signal?.throwIfAborted();
			const chunk = flush();
			if (chunk) yield chunk;
		},
	};
}

export class SnapshotTranscriptCache {
	private readonly chunks: SnapshotTranscriptChunk[] = [];
	private cacheDirectory?: string;
	private totalBytes = 0;
	private completed = false;
	private readers = 0;
	private disposeRequested = false;
	private disposed = false;
	private failure?: Error;
	private readonly chunkWaiters = new Map<
		number,
		Array<{ resolve: (buffer: Buffer | undefined) => void; reject: (error: Error) => void }>
	>();
	readonly targetChunkBytes: number;
	readonly snapshotId: string;
	readonly activeSessionId: string;

	constructor(private readonly options: SnapshotTranscriptCacheOptions) {
		this.targetChunkBytes = options.targetChunkBytes ?? SNAPSHOT_TARGET_CHUNK_BYTES;
		this.snapshotId = options.snapshotId;
		this.activeSessionId = options.activeSessionId;
		if (options.messages) {
			this.encodeMessages(options.messages);
			this.completed = true;
		}
	}

	get chunkCount(): number {
		return this.chunks.length;
	}

	get complete(): boolean {
		return this.completed && !this.failure && !this.disposed;
	}

	get bytes(): number {
		return this.totalBytes;
	}

	get fileBacked(): boolean {
		return this.cacheDirectory !== undefined;
	}

	readChunk(index: number): Buffer {
		const chunk = this.chunks[index];
		if (!chunk) {
			throw new Error(`Unknown snapshot transcript chunk: ${index}`);
		}
		if (chunk.buffer) {
			return chunk.buffer;
		}
		if (!chunk.path) {
			throw new Error(`Snapshot transcript chunk ${index} has no backing storage`);
		}
		return readFileSync(chunk.path);
	}

	*[Symbol.iterator](): Iterator<Buffer> {
		for (let index = 0; index < this.chunkCount; index++) {
			yield this.readChunk(index);
		}
	}

	/**
	 * Rebuilds the message list from the encoded chunks.
	 *
	 * A client that cannot consume the chunk transfer reads the transcript from the
	 * attach response instead. Decoding the bytes the worker already encoded keeps one
	 * JSON pass over the transcript per snapshot generation; re-encoding the messages
	 * into new chunk frames was a second full pass over the same content, and it wrote
	 * a second copy of the transcript to the supervisor's cache directory.
	 *
	 * `undefined` means the transfer is not usable: incomplete, failed, disposed, a chunk
	 * that does not parse into this snapshot's frame, or a message count that does not
	 * match what the snapshot summary promises. Callers treat that as "reload".
	 */
	decodeMessages(expectedMessageCount?: number): AgentMessage[] | undefined {
		if (!this.complete) {
			return undefined;
		}
		const messages: AgentMessage[] = [];
		try {
			for (let index = 0; index < this.chunkCount; index++) {
				const frame: unknown = JSON.parse(this.readChunk(index).toString("utf8"));
				if (
					!isSnapshotTranscriptChunkFrame(frame) ||
					frame.snapshotId !== this.snapshotId ||
					frame.activeSessionId !== this.activeSessionId ||
					frame.index !== index
				) {
					return undefined;
				}
				for (const message of frame.messages) {
					messages.push(message);
				}
			}
		} catch {
			return undefined;
		}
		if (expectedMessageCount !== undefined && messages.length !== expectedMessageCount) {
			return undefined;
		}
		return messages;
	}

	appendEncodedChunk(buffer: Buffer): void {
		if (this.completed || this.failure || this.disposed) {
			throw new Error(`Snapshot transcript ${this.snapshotId} is not writable`);
		}
		this.storeChunk(buffer);
	}

	markComplete(): void {
		if (this.completed) {
			return;
		}
		if (this.failure || this.disposed) {
			throw new Error(`Snapshot transcript ${this.snapshotId} cannot be completed`);
		}
		this.completed = true;
		for (const [index, waiters] of this.chunkWaiters) {
			if (index < this.chunks.length) {
				continue;
			}
			for (const waiter of waiters) {
				waiter.resolve(undefined);
			}
			this.chunkWaiters.delete(index);
		}
	}

	markFailed(error: Error): void {
		if (this.failure) {
			return;
		}
		this.failure = error;
		for (const waiters of this.chunkWaiters.values()) {
			for (const waiter of waiters) {
				waiter.reject(error);
			}
		}
		this.chunkWaiters.clear();
	}

	waitForChunk(index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		if (index < this.chunks.length) {
			return Promise.resolve(this.readChunk(index));
		}
		if (this.completed) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve, reject) => {
			const waiters = this.chunkWaiters.get(index) ?? [];
			const onAbort = () => {
				waiters.splice(waiters.indexOf(waiter), 1);
				if (waiters.length === 0) this.chunkWaiters.delete(index);
				reject(signal?.reason);
			};
			const waiter = {
				resolve: (buffer: Buffer | undefined) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(buffer);
				},
				reject: (error: Error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			waiters.push(waiter);
			this.chunkWaiters.set(index, waiters);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	retain(): () => void {
		if (this.disposed) {
			throw new Error(`Snapshot transcript ${this.snapshotId} was disposed`);
		}
		this.readers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.readers--;
			if (this.readers === 0 && this.disposeRequested) {
				this.disposeNow();
			}
		};
	}

	dispose(): void {
		if (this.disposed || this.disposeRequested) return;
		this.disposeRequested = true;
		if (this.readers > 0) return;
		this.disposeNow();
	}

	private disposeNow(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.markFailed(new Error(`Snapshot transcript ${this.snapshotId} was disposed`));
		if (this.cacheDirectory) {
			rmSync(this.cacheDirectory, { recursive: true, force: true });
			this.cacheDirectory = undefined;
		}
		this.chunks.length = 0;
	}

	private encodeMessages(messages: readonly AgentMessage[]): void {
		let serializedMessages: string[] = [];
		let serializedBytes = 0;
		const flush = () => {
			if (serializedMessages.length === 0) {
				return;
			}
			const index = this.chunks.length;
			const prefix =
				`{"type":"session_snapshot_chunk","activeSessionId":${JSON.stringify(this.options.activeSessionId)},` +
				`"snapshotId":${JSON.stringify(this.options.snapshotId)},"index":${index},"messages":[`;
			const line = Buffer.from(`${prefix}${serializedMessages.join(",")}]}\n`);
			this.storeChunk(line);
			serializedMessages = [];
			serializedBytes = 0;
		};

		for (const message of messages) {
			const serialized = JSON.stringify(message);
			const bytes = Buffer.byteLength(serialized) + (serializedMessages.length > 0 ? 1 : 0);
			if (serializedMessages.length > 0 && serializedBytes + bytes > this.targetChunkBytes) {
				flush();
			}
			serializedMessages.push(serialized);
			serializedBytes += bytes;
		}
		flush();
	}

	private storeChunk(buffer: Buffer): void {
		this.totalBytes += buffer.length;
		const memoryLimit = this.options.memoryCacheBytes ?? SNAPSHOT_MEMORY_CACHE_BYTES;
		if (!this.cacheDirectory && this.totalBytes > memoryLimit) {
			this.cacheDirectory = join(this.options.cacheRoot, this.options.snapshotId.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
			mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
			for (let index = 0; index < this.chunks.length; index++) {
				const existing = this.chunks[index]!;
				if (!existing.buffer) {
					continue;
				}
				const path = join(this.cacheDirectory, `${index}.jsonl`);
				writeFileSync(path, existing.buffer, { mode: 0o600 });
				this.chunks[index] = { path };
			}
		}

		if (this.cacheDirectory) {
			const path = join(this.cacheDirectory, `${this.chunks.length}.jsonl`);
			writeFileSync(path, buffer, { mode: 0o600 });
			this.chunks.push({ path });
		} else {
			this.chunks.push({ buffer });
		}
		const index = this.chunks.length - 1;
		const waiters = this.chunkWaiters.get(index);
		if (waiters) {
			const stored = this.readChunk(index);
			for (const waiter of waiters) {
				waiter.resolve(stored);
			}
			this.chunkWaiters.delete(index);
		}
	}
}
