/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.js";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateTail,
} from "./tools/truncate.js";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Extra env vars merged over the parent process env for this command.
	 * A key with an undefined value is unset in the child.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** True when stdout or stderr exceeded the retention limit and was truncated */
	truncated: boolean;
}

/**
 * Retained output per stream before oldest chunks are dropped. Kept above the
 * truncation limit so the final tail truncation always has enough material.
 */
const OUTPUT_RETENTION_BYTES = DEFAULT_MAX_BYTES * 2;

/**
 * Bounded output accumulator (same ring-buffer scheme as bash-executor): raw
 * bytes stream in, only the most recent OUTPUT_RETENTION_BYTES are kept, and
 * the final content is tail-truncated and annotated.
 */
class BoundedOutputCollector {
	private chunks: string[] = [];
	private retainedBytes = 0;
	private readonly decoder = new TextDecoder();
	totalBytes = 0;
	private newlineCount = 0;

	add(data: Buffer): void {
		this.totalBytes += data.length;
		const text = this.decoder.decode(data, { stream: true });
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) this.newlineCount++;
		}
		this.chunks.push(text);
		this.retainedBytes += Buffer.byteLength(text);
		while (this.retainedBytes > OUTPUT_RETENTION_BYTES && this.chunks.length > 1) {
			const removed = this.chunks.shift()!;
			this.retainedBytes -= Buffer.byteLength(removed);
		}
	}

	finish(): { content: string; truncated: boolean } {
		const tail = this.decoder.decode();
		if (tail) {
			for (let i = 0; i < tail.length; i++) {
				if (tail.charCodeAt(i) === 10) this.newlineCount++;
			}
			this.chunks.push(tail);
		}

		const retained = this.chunks.join("");
		const result = truncateTail(retained, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		if (!result.truncated) {
			return { content: retained, truncated: false };
		}

		const totalLines = this.newlineCount + 1;
		const annotation = formatExecTruncationAnnotation(result, totalLines, this.totalBytes);
		return { content: result.content + annotation, truncated: true };
	}
}

function formatExecTruncationAnnotation(result: TruncationResult, totalLines: number, totalBytes: number): string {
	if (result.truncatedBy === "lines") {
		return `\n\n[Output truncated: showing last ${result.outputLines} of ${totalLines} lines.]`;
	}
	return `\n\n[Output truncated: showing last ${formatSize(result.outputBytes)} of ${formatSize(totalBytes)}.]`;
}

function mergeExecEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
	if (!env) {
		return undefined;
	}
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal. On abort or timeout the whole process
 * group is killed (matching the bash tool), and output accumulation is
 * bounded per stream.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			// New process group so abort/timeout can kill the entire tree,
			// matching createLocalBashOperations.
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			// Merge per-call env over the parent env so callers can scope vars
			// (e.g. herdr pane identity) without mutating the shared process.env.
			env: mergeExecEnv(options?.env),
		});
		if (proc.pid) trackDetachedChildPid(proc.pid);

		const stdoutCollector = new BoundedOutputCollector();
		const stderrCollector = new BoundedOutputCollector();
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				// Kill the full process group (taskkill /T on Windows); a plain
				// proc.kill leaves grandchildren running.
				if (proc.pid !== undefined) {
					killProcessTree(proc.pid);
				} else {
					proc.kill("SIGKILL");
				}
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdoutCollector.add(data);
		});

		proc.stderr?.on("data", (data) => {
			stderrCollector.add(data);
		});

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (proc.pid) untrackDetachedChildPid(proc.pid);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		const finish = (code: number) => {
			const stdout = stdoutCollector.finish();
			const stderr = stderrCollector.finish();
			resolve({
				stdout: stdout.content,
				stderr: stderr.content,
				code,
				killed,
				truncated: stdout.truncated || stderr.truncated,
			});
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				cleanup();
				finish(code ?? 0);
			})
			.catch((_err) => {
				cleanup();
				finish(1);
			});
	});
}
