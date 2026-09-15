import { backgroundNetworkOptOut } from "../../src/utils/privacy-opt-out.js";

/**
 * Stand-in for a nested prime-agent CLI launched through the bash tool: reads
 * the same production env names (privacy opt-outs via the production helper,
 * update routing, agentDir/sessionDir pins) and prints them as one JSON line.
 */
const report = {
	optOut: backgroundNetworkOptOut() ?? null,
	supervisorSocket: process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET ?? null,
	activeSessionId: process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID ?? null,
	agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR ?? null,
	sessionDir: process.env.PRIME_AGENT_SESSION_DIR ?? null,
	supervisorRegistryDir: process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR ?? null,
	workerToken: process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN ?? null,
	serperApiKey: process.env.SERPER_API_KEY ?? null,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
