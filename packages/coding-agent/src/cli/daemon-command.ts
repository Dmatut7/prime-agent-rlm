import chalk from "chalk";
import type { AgentSessionMessageDeliveryMode } from "../core/agent-messages.js";
import { type AgentCronJob, formatAgentCronJob } from "../core/cron-jobs.js";
import { resolveDaemonSocketForAgentDir } from "../modes/daemon/daemon-agent-endpoint.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../modes/daemon/daemon-protocol.js";
import { DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES } from "../modes/daemon/daemon-protocol.js";
import { matchesSessionIdSuffix } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { formatSessionListTable } from "./daemon-list-format.js";

interface ParsedDaemonClientCommand {
	command: string;
	socketPath: string;
	/** True when the caller named a socket, so agent-dir discovery must not override it. */
	socketExplicit: boolean;
	json: boolean;
	positionals: string[];
}

// This module is the internal client behind the public agent commands
// (`prime-agent list|stop|rename|send|schedule`); public-command.ts routes those
// here with a synthesized "daemon" prefix. The user-facing `prime-agent daemon ...`
// surface was removed upstream (REMOVED_COMMAND_NAMES rejects the prefix), and the
// subcommands no public command routes to (open/start/ps/create/attach/detach/
// prompt/agent-messages/steer/follow-up/state/messages/stats/commands/retry/
// restart/shutdown) were deleted with it - keep this set in sync with
// public-command.ts instead of re-adding arms here.
const DAEMON_CLIENT_COMMANDS = new Set(["list", "kill", "rename", "send", "cron"]);

export async function handleDaemonCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "daemon") {
		return false;
	}

	try {
		const parsed = parseDaemonClientCommand(args.slice(1));
		await runDaemonClientCommand(parsed);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

function parseDaemonClientCommand(args: string[]): ParsedDaemonClientCommand {
	let socketPath = defaultDaemonSocketPath();
	let socketExplicit = false;
	let json = false;
	const positionals: string[] = [];
	let passthrough = false;
	let command: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (passthrough) {
			positionals.push(arg);
			continue;
		}

		// send/cron parse "--" themselves as an end-of-flags separator
		if (arg === "--" && (command === "cron" || command === "send")) {
			positionals.push(arg);
			passthrough = true;
			continue;
		}

		if (arg === "--") {
			passthrough = true;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			if (!command) {
				command = "help";
			} else {
				positionals.push("help");
			}
			continue;
		}

		if (arg === "--socket" || arg === "--daemon-socket") {
			const value = args[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a value`);
			}
			socketPath = normalizeSocketPath(value);
			socketExplicit = true;
			index++;
			continue;
		}

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (!command && DAEMON_CLIENT_COMMANDS.has(arg)) {
			command = arg;
			continue;
		}

		positionals.push(arg);
	}

	if (command === undefined) {
		const attempted = positionals[0];
		throw new Error(
			attempted
				? `Unknown daemon command: ${attempted}. The "daemon" command surface was removed; run "prime-agent help" to see the agent commands.`
				: "Missing daemon command.",
		);
	}
	return { command, socketPath, socketExplicit, json, positionals };
}

/**
 * Agent-dir scoped commands (`list`, `attach`, `stop`, `send`, ...) without an
 * explicit socket talk to the daemon that owns this agent dir, in whatever
 * `$TMPDIR` that daemon happens to live (see resolveDaemonSocketForAgentDir).
 * An explicit `--socket`/`--daemon-socket` is never overridden.
 */
async function resolveAgentDirSocket(parsed: ParsedDaemonClientCommand): Promise<ParsedDaemonClientCommand> {
	const endpoint = await resolveDaemonSocketForAgentDir();
	return { ...parsed, socketPath: endpoint.socketPath };
}

async function runDaemonClientCommand(parsedInput: ParsedDaemonClientCommand): Promise<void> {
	// An explicit socket keeps its exact call shape: it is never awaited through the
	// discovery path, so nothing about a named endpoint changes by a microtask.
	const parsed = parsedInput.socketExplicit ? parsedInput : await resolveAgentDirSocket(parsedInput);
	const client = new DaemonClient(parsed.socketPath, {
		declaredCapabilities: DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	});
	await client.connect();

	try {
		switch (parsed.command) {
			case "list":
				await runList(client, parsed.positionals, parsed.json);
				return;
			case "kill":
				await printResponseData(
					client,
					{ type: "kill", activeSessionId: requireActiveSessionId(parsed.positionals) },
					parsed.json,
				);
				return;
			case "rename":
				await runRename(client, parsed.positionals, parsed.json);
				return;
			case "send":
				await runSend(client, parsed.positionals, parsed.json);
				return;
			case "cron":
				await runCron(client, parsed.positionals, parsed.json);
				return;
		}
	} finally {
		client.close();
	}
}

async function getLiveSessions(client: DaemonClient, all = false): Promise<SessionSummary[]> {
	const response = await client.request({ type: "list", ...(all ? { all: true } : {}) });
	const data = requireSuccess(response);
	const sessions = getSessionSummaries(data);
	if (!sessions) {
		throw new Error("Daemon returned an invalid list response");
	}
	return sessions;
}

async function runList(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const { all } = parseListArgs(args);
	const response = await client.request({ type: "list", all });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	const sessions = getSessionSummaries(data);
	if (!sessions) {
		printJson(data);
		return;
	}

	if (sessions.length === 0) {
		console.log(all ? "No agents." : "No active agents.");
		return;
	}

	console.log(formatSessionListTable(sessions));
}

function parseListArgs(args: string[]): { all: boolean } {
	let all = false;
	for (const arg of args) {
		if (arg === "-a" || arg === "--all") {
			all = true;
			continue;
		}
		throw new Error(`Unknown list option: ${arg}`);
	}
	return { all };
}

async function runRename(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const activeSessionId = requireActiveSessionId(args);
	const name = args.slice(1).join(" ").trim();
	if (!name) {
		throw new Error("Usage: prime-agent rename <agent> <name>");
	}
	const response = await client.request({ type: "rename", activeSessionId, name });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (isLiveSessionSummary(data)) {
		console.log(`Renamed ${data.activeSessionId} to ${data.sessionName ?? name}`);
		return;
	}
	printJson(data);
}

async function runSend(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const parsed = parseSendArgs(args);
	if (parsed.deliveryMode) {
		// A rev-40 daemon accepted send_message.deliveryMode and silently steered;
		// refuse before the request leaves so an update-window daemon cannot degrade
		// an explicit --follow-up into a steer. The bare send stays on the legacy path.
		await client.waitForHello();
		if (!client.supportsServerCapability("send_message_delivery_mode")) {
			const flag = parsed.deliveryMode === "follow_up" ? "--follow-up" : "--steer";
			throw new Error(
				`The connected daemon is too old to honor ${flag} (send_message_delivery_mode requires daemon schema revision 41+). Restart the daemon to pick up the current version: prime-agent shutdown, then run prime-agent again.`,
			);
		}
	}
	const response = await client.request({
		type: "send_message",
		targetActiveSessionId: parsed.targetActiveSessionId,
		fromActiveSessionId: parsed.fromActiveSessionId,
		message: parsed.message,
		...(parsed.deliveryMode ? { deliveryMode: parsed.deliveryMode } : {}),
	});
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}
	if (isAgentMessageReceipt(data)) {
		const target = data.target.sessionName ?? data.target.activeSessionId;
		console.log(data.deliveryStatus === "queued" ? `Queued for ${target}` : `Sent to ${target}`);
		return;
	}
	console.log("ok");
}

interface ParsedSendArgs {
	targetActiveSessionId: string;
	fromActiveSessionId?: string;
	message: string;
	deliveryMode?: AgentSessionMessageDeliveryMode;
}

function parseSendArgs(args: string[]): ParsedSendArgs {
	let fromActiveSessionId: string | undefined;
	let targetActiveSessionId: string | undefined;
	let explicitMessage: string | undefined;
	let deliveryMode: AgentSessionMessageDeliveryMode | undefined;
	const messageParts: string[] = [];
	let parseOptions = true;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (parseOptions && arg === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && arg === "--from") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--from requires a session id or name");
			}
			fromActiveSessionId = value;
			index++;
			continue;
		}
		if (parseOptions && (arg === "--steer" || arg === "--follow-up")) {
			const requested: AgentSessionMessageDeliveryMode = arg === "--steer" ? "steer" : "follow_up";
			if (deliveryMode !== undefined && deliveryMode !== requested) {
				throw new Error("--steer and --follow-up cannot be used together");
			}
			deliveryMode = requested;
			continue;
		}
		if (parseOptions && arg === "--message") {
			if (!targetActiveSessionId) {
				throw new Error("--message must appear after the target session");
			}
			const value = args[index + 1];
			if (!value) {
				throw new Error("--message requires message text");
			}
			explicitMessage = value;
			index++;
			parseOptions = false;
			continue;
		}
		if (parseOptions && arg.startsWith("--")) {
			throw new Error(`Unknown option for send: ${arg} (use -- before message text starting with --)`);
		}
		if (!targetActiveSessionId) {
			targetActiveSessionId = arg;
			continue;
		}
		messageParts.push(arg);
	}

	if (explicitMessage !== undefined && messageParts.length > 0) {
		throw new Error(
			"Usage: prime-agent send [--from <agent>] [--steer|--follow-up] <agent> [--message <message>|<message>]",
		);
	}
	const message = (explicitMessage ?? messageParts.join(" ")).trim();
	if (!targetActiveSessionId || !message) {
		throw new Error(
			"Usage: prime-agent send [--from <agent>] [--steer|--follow-up] <agent> [--message <message>|<message>]",
		);
	}
	return {
		targetActiveSessionId,
		fromActiveSessionId,
		message,
		deliveryMode,
	};
}

async function runCron(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const subcommand = args[0] ?? "list";
	if (subcommand === "list") {
		const includeInactive = args.includes("--all") || args.includes("-a");
		const selector = args.find((arg) => !arg.startsWith("-") && arg !== "list");
		const activeSessionId = selector ? await resolveLiveSessionSelector(client, selector) : undefined;
		const response = await client.request({ type: "cron_list", activeSessionId, includeInactive });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const jobs = getCronJobs(data);
		if (!jobs) {
			printJson(data);
			return;
		}
		if (jobs.length === 0) {
			console.log("No scheduled prompts.");
			return;
		}
		for (const job of jobs) {
			console.log(formatAgentCronJob(job));
		}
		return;
	}

	if (subcommand === "add" || subcommand === "schedule") {
		const separator = args.indexOf("--");
		if (separator < 0) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const activeSessionId = args[1];
		if (!activeSessionId) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const schedule = args.slice(2, separator).join(" ").trim();
		const message = args
			.slice(separator + 1)
			.join(" ")
			.trim();
		if (!schedule || !message) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const response = await client.request({ type: "cron_add", activeSessionId, schedule, prompt: message });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const job = getCronJob(data);
		console.log(job ? `Scheduled ${job.id} next=${job.nextRunAt ?? "-"}` : "Scheduled prompt.");
		return;
	}

	if (subcommand === "cancel" || subcommand === "delete" || subcommand === "remove") {
		const jobId = args[1];
		if (!jobId) {
			throw new Error("Usage: prime-agent schedule cancel <job-id>");
		}
		const response = await client.request({ type: "cron_cancel", jobId });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const job = getCronJob(data);
		console.log(job ? `Cancelled ${job.id}` : "Cancelled cron job.");
		return;
	}

	throw new Error(`Unknown schedule command: ${subcommand}`);
}

async function resolveLiveSessionSelector(client: DaemonClient, selector: string): Promise<string> {
	const sessions = (await getLiveSessions(client)).filter(
		(session): session is SessionSummary & { activeSessionId: string } => typeof session.activeSessionId === "string",
	);
	const exact = sessions.filter(
		(session) =>
			session.activeSessionId === selector || session.sessionId === selector || session.sessionName === selector,
	);
	const suffix = sessions.filter(
		(session) =>
			matchesSessionIdSuffix(session.activeSessionId, selector) ||
			matchesSessionIdSuffix(session.sessionId, selector),
	);
	const matches = exact.length > 0 ? exact : suffix;
	if (matches.length === 1) {
		return matches[0]!.activeSessionId;
	}
	if (matches.length > 1) {
		throw new Error(`Ambiguous active session "${selector}"`);
	}
	throw new Error(`Unknown active session: ${selector}`);
}

async function printResponseData(
	client: DaemonClient,
	command: Parameters<DaemonClient["request"]>[0],
	json: boolean,
): Promise<void> {
	const response = await client.request(command);
	const data = requireSuccess(response);
	if (json || data !== undefined) {
		printJson(data ?? response);
		return;
	}
	console.log("ok");
}

function requireActiveSessionId(args: string[]): string {
	const activeSessionId = args[0];
	if (!activeSessionId) {
		throw new Error("Missing agent id or name");
	}
	return activeSessionId;
}

function requireSuccess(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return "data" in response ? response.data : undefined;
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function getSessionSummaries(value: unknown): SessionSummary[] | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const sessions = (value as { sessions?: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		return undefined;
	}

	const entries: SessionSummary[] = [];
	for (const session of sessions) {
		if (isSessionSummary(session)) {
			entries.push(session);
			continue;
		}
		return undefined;
	}
	return entries;
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<SessionSummary>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.lifecycle === "string" &&
		typeof candidate.activity === "string" &&
		typeof candidate.isSessionActive === "boolean" &&
		typeof candidate.isStreaming === "boolean" &&
		typeof candidate.isCompacting === "boolean" &&
		typeof candidate.attachedClients === "number" &&
		typeof candidate.messageCount === "number" &&
		(candidate.unfinishedActionCount === undefined || typeof candidate.unfinishedActionCount === "number") &&
		typeof candidate.sessionActions === "object" &&
		candidate.sessionActions !== null &&
		typeof candidate.sessionActions.queuedCount === "number" &&
		Array.isArray(candidate.sessionActions.steering) &&
		Array.isArray(candidate.sessionActions.followUps)
	);
}

function isLiveSessionSummary(value: unknown): value is SessionSummary & { activeSessionId: string } {
	return isSessionSummary(value) && typeof value.activeSessionId === "string";
}

function getCronJobs(value: unknown): AgentCronJob[] | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const jobs = (value as { jobs?: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as AgentCronJob[]) : undefined;
}

function getCronJob(value: unknown): { id: string; nextRunAt?: string } | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const job = (value as { job?: unknown }).job;
	if (!job || typeof job !== "object" || typeof (job as { id?: unknown }).id !== "string") {
		return undefined;
	}
	const candidate = job as { id: string; nextRunAt?: unknown };
	return { id: candidate.id, ...(typeof candidate.nextRunAt === "string" ? { nextRunAt: candidate.nextRunAt } : {}) };
}

function isAgentMessageReceipt(
	value: unknown,
): value is { target: { activeSessionId: string; sessionName?: string }; deliveryStatus?: string } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const target = (value as { target?: unknown }).target;
	return (
		!!target &&
		typeof target === "object" &&
		typeof (target as { activeSessionId?: unknown }).activeSessionId === "string"
	);
}
