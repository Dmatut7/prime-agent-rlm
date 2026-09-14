/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

const bashExecutorLog = getLogger("coding-agent.bash-executor");

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/**
	 * Path to the temp file containing the full output, set only when that file exists and holds
	 * everything: callers show it as "Full output: <path>", so a path with no file behind it is a
	 * promise nothing can keep.
	 */
	fullOutputPath?: string;
}
/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileError: Error | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		const path = join(tmpdir(), `pi-bash-${id}.log`);
		// This file holds the complete output, including the part truncation kept out of
		// the model's view, and it lives in a world-shared tmpdir: owner-only, like every
		// other artifact the agent writes.
		const stream = createWriteStream(path, { mode: 0o600 });
		// Opening and writing both fail asynchronously, through the `error` event. With no listener
		// that event becomes an uncaughtException, which daemon-mode answers by exiting the process
		// - one unwritable tmpdir would take down every session in the daemon. Capture it instead
		// and let settleTempFile() withdraw the path.
		stream.on("error", (error) => {
			tempFileError ??= error;
		});
		tempFilePath = path;
		tempFileStream = stream;
		for (const chunk of outputChunks) {
			stream.write(chunk);
		}
	};

	/**
	 * Close the temp file and name it only if the whole output really landed. Awaiting the close is
	 * also what makes the returned path readable by whoever is pointed at it: the stream opens
	 * lazily, so a path handed out before this settles can name a file that is not there yet.
	 */
	const settleTempFile = async (): Promise<string | undefined> => {
		const path = tempFilePath;
		const stream = tempFileStream;
		tempFileStream = undefined;
		if (!path || !stream) {
			return undefined;
		}
		await new Promise<void>((resolve) => {
			const settle = () => {
				stream.off("error", settle);
				stream.off("finish", settle);
				resolve();
			};
			stream.on("error", settle);
			stream.on("finish", settle);
			stream.end();
		});
		if (tempFileError) {
			bashExecutorLog.warn("could not persist full bash output; withholding the temp file path", {
				path,
				reason: tempFileError.message,
			});
			// Nothing to hand out: the caller reports the truncation without a path.
			tempFilePath = undefined;
			return undefined;
		}
		return path;
	};

	const decoder = new TextDecoder();

	const appendText = (decoded: string) => {
		const text = sanitizeBinaryOutput(stripAnsi(decoded)).replace(/\r/g, "");
		if (text.length === 0) {
			return;
		}
		if (tempFileStream) {
			tempFileStream.write(text);
		}
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}
		appendText(decoder.decode(data, { stream: true }));
	};

	/**
	 * Deliver whatever the streaming decoder is still holding. A producer cut off
	 * mid-character (timeout, kill, abort) leaves an incomplete sequence buffered;
	 * without this those bytes disappear from both the returned output and the
	 * persisted file instead of surfacing as the replacement character.
	 */
	const flushDecoder = () => {
		appendText(decoder.decode());
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		flushDecoder();
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		const fullOutputPath = await settleTempFile();
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath,
		};
	} catch (err) {
		if (options?.signal?.aborted) {
			flushDecoder();
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: await settleTempFile(),
			};
		}

		// Close the stream even when the command failed, so a partially written file is flushed and
		// the error listener above stays the only channel through which it can report a problem.
		await settleTempFile();
		throw err;
	}
}
