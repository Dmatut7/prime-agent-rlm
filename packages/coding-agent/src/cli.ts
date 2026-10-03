#!/usr/bin/env node
// The Node 22+ module graph fails at link time on older Node, so it must load
// behind the dynamic import, after the dependency-free guard runs.
import * as nodeModule from "node:module";
import { assertNodeVersion } from "./cli/node-version-check.js";

const supported = assertNodeVersion({
	version: process.versions.node,
	log: console.error,
	exit: (code) => process.exit(code),
});

if (supported) {
	// The cli-main static graph is several MB; runCli() only enables the compile
	// cache after that graph has already been compiled. Enabling it here lets the
	// cache cover those chunks too. Namespace import + optional call: on Node
	// builds without enableCompileCache this is a no-op, never a link error.
	try {
		nodeModule.enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}
	const { runCli } = await import("./cli-main.js");
	await runCli();
}
