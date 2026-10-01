import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";
import {
	isDaemonShutdownAdmissionError,
	waitForDaemonShutdownAdmissionClear,
} from "./modes/daemon/daemon-supervisor-ownership.js";

/**
 * The one-line answer for a shutdown that outlives both waits: no stack, and it
 * says what to do. Kept single-line on purpose — tests pin that shape.
 */
export const DAEMON_SHUTDOWN_IN_PROGRESS_CLI_LINE =
	"prime-agent: the previous daemon is still shutting down; wait a few seconds and retry.";

/**
 * Longer than the supervisor startup-side wait (SHUTDOWN_ADMISSION_STARTUP_WAIT_MS):
 * that wait already absorbed the common restart window, so a signature that still
 * reaches the CLI is a slow shutdown worth one more bounded window plus a retry.
 */
const DAEMON_SHUTDOWN_ADMISSION_RETRY_WAIT_MS = 15_000;

export interface DaemonShutdownRetryOptions {
	waitForClear?: (timeoutMs: number) => Promise<boolean>;
	retryWaitMs?: number;
	report?: (line: string) => void;
	setExitCode?: (code: number) => void;
}

/**
 * A restart that lands inside the previous daemon's shutdown window used to surface
 * as a full stack: the daemon child exits 1 over DaemonShutdownAdmissionError and
 * the launch wrapper rethrows with the child's log tail, stack included. The
 * supervisor startup side now waits the admission out itself; this is the backstop
 * for a shutdown that outlives that wait. Recognize the signature (the direct error
 * or the launch wrapper quoting it), give the shutdown a bounded window to finish,
 * retry main once, and otherwise report one line — never the stack.
 */
export async function runMainWithDaemonShutdownRetry(
	main: (args: string[]) => Promise<void>,
	args: string[],
	options: DaemonShutdownRetryOptions = {},
): Promise<void> {
	const waitForClear = options.waitForClear ?? waitForDaemonShutdownAdmissionClear;
	const retryWaitMs = options.retryWaitMs ?? DAEMON_SHUTDOWN_ADMISSION_RETRY_WAIT_MS;
	const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
	const setExitCode =
		options.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	try {
		await main(args);
		return;
	} catch (error) {
		if (!isDaemonShutdownAdmissionError(error)) {
			throw error;
		}
		if (!(await waitForClear(retryWaitMs))) {
			report(DAEMON_SHUTDOWN_IN_PROGRESS_CLI_LINE);
			setExitCode(1);
			return;
		}
	}
	try {
		await main(args);
	} catch (error) {
		if (!isDaemonShutdownAdmissionError(error)) {
			throw error;
		}
		report(DAEMON_SHUTDOWN_IN_PROGRESS_CLI_LINE);
		setExitCode(1);
	}
}

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await runMainWithDaemonShutdownRetry(main, process.argv.slice(2));
		} finally {
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}
