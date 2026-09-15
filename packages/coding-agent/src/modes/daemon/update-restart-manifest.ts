import { writePrivateFileAtomic } from "../../utils/private-files.js";
import type { DaemonUpdateRestartManifest } from "./daemon-protocol.js";

/**
 * Persist the update-restart manifest durably and atomically.
 *
 * `prompt-admission.ts` promises that queued work "must survive into the restart
 * manifest", and the supervisor's reader swallows a parse failure as "no manifest".
 * A direct write torn mid-way therefore leaves half a manifest at the final path and
 * silently drops every queued session on the restart. The write goes through
 * `writePrivateFileAtomic` (temp file + fsync + rename, 0600), so the final path only
 * ever holds a complete manifest: the old one or the new one, never a torn prefix.
 */
export function writeUpdateRestartManifestFile(path: string, manifest: DaemonUpdateRestartManifest): void {
	writePrivateFileAtomic(path, `${JSON.stringify(manifest)}\n`);
}
