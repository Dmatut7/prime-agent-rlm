import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The daemon supervisor's durable owner registry is user-wide authority state: it
 * lives in the real home directory on purpose, so every daemon on the box can see
 * every other one. A test that starts a daemon without relocating this root leaves
 * owner records behind in the developer's real `~/.prime/supervisor-owners`, where
 * `status`, endpoint discovery and the same-agent-dir startup gate then read them as
 * live supervisors.
 *
 * Everything a test needs to relocate that root lives here, next to the resolution
 * it mirrors (`defaultDaemonSupervisorRegistryDir` in
 * `src/modes/daemon/daemon-supervisor-ownership.ts`).
 */
export const SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

/** Where a daemon that resolves the registry root without an override writes. */
export function realSupervisorRegistryDir(): string {
	return join(homedir(), ".prime", "supervisor-owners");
}

/** Environment that points a spawned or in-process daemon at one isolated registry root. */
export function isolatedSupervisorRegistryEnv(root: string): Record<string, string> {
	return { [SUPERVISOR_REGISTRY_DIR_ENV]: join(root, "supervisor-registry") };
}

/** Owner directory names in a registry root; `[]` when the root does not exist. */
export function supervisorRegistryEntries(registryDir: string = realSupervisorRegistryDir()): string[] {
	try {
		return readdirSync(registryDir)
			.filter((name) => name.endsWith(".owner"))
			.sort();
	} catch {
		return [];
	}
}
