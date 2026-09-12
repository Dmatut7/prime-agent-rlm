import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fork self-keep gate.
 *
 * This repository is a maintained fork (`Dmatut7/prime-agent-rlm`): the installed
 * `prime-agent` command is a symlink into this checkout's build output, and the
 * official published package does not contain the fork's changes. The upstream
 * `update --self` path installs that official package over whatever provides the
 * running executable, so on a fork build it silently replaces the fork - and when
 * the install is not package-manager managed, the refusal it prints still tells the
 * user to run the official installer by hand. Both outcomes lose the fork, so the
 * gate refuses first and names the fork's own update procedure.
 */

/** Marker this fork keeps at its repository root; AGENTS.md requires every push to update it. */
export const FORK_MARKER_FILE = "FORK_NOTES.md";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ForkInstall {
	/** Repository root of the fork checkout the running build came from. */
	repoRoot: string;
}

/**
 * The fork checkout this build runs from, or `undefined` for an installation that is
 * not a fork checkout (an official package under a global package manager has no
 * marker above it). Walks up from the running module, so a bundled `dist/bundle`
 * CLI, a `dist/` CLI and a `src/` tsx run all resolve to the same root.
 */
export function detectForkInstall(startDir: string = __dirname): ForkInstall | undefined {
	let dir = resolve(startDir);
	for (;;) {
		if (existsSync(join(dir, FORK_MARKER_FILE))) return { repoRoot: dir };
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The refusal printed instead of a self-update. Lines are returned rather than
 * printed so a caller decides the stream and a test can assert the content.
 */
export function forkSelfUpdateRefusalLines(fork: ForkInstall, options: { extensionsUpdated?: boolean } = {}): string[] {
	const lines = [
		`error: refusing to self-update a fork build (marker ${FORK_MARKER_FILE} at ${fork.repoRoot}).`,
		"The official published package does not contain this fork's changes, so installing it over",
		"the running executable would discard them.",
	];
	if (options.extensionsUpdated) {
		lines.push("Extensions were updated; only the self-update half was refused.");
	}
	lines.push(
		"",
		"Update this fork from its own checkout:",
		`  cd ${fork.repoRoot} && git pull --rebase && npm run build`,
		"  prime-agent shutdown && prime-agent        # the daemon keeps the old bundle until it restarts",
		"Run the checkout without installing it:",
		`  ${join(fork.repoRoot, "prime-agent.sh")}`,
		"",
		"To install the official package over this fork anyway: prime-agent update --allow-official",
	);
	return lines;
}

/** The warning printed when --allow-official overrides the gate. */
export function forkSelfUpdateOverrideLine(fork: ForkInstall): string {
	return `warning: --allow-official given; installing the official package over the fork build at ${fork.repoRoot}.`;
}
