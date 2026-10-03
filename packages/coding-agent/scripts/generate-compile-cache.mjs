#!/usr/bin/env node
/**
 * Pre-warms a V8 compile cache for the bundled CLI. Invoked by bundle.mjs
 * after bundling, in a child process with an isolated HOME/TMPDIR and
 * NODE_COMPILE_CACHE pointing at <outdir>/compile-cache.
 *
 * Coverage strategy: statically import every chunk in the bundle except the
 * cli.js entry (importing the entry would run the CLI itself). Importing a
 * chunk executes module top-level code, so the child must stay throwaway:
 * bundle.mjs gives it a throwaway HOME/TMPDIR and this script force-exits.
 *
 * Usage: node generate-compile-cache.mjs <bundleOutdir> <buildId>
 */
import { flushCompileCache } from "node:module";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WATCHDOG_MS = 90_000;

const [outdir, buildId] = process.argv.slice(2);
if (!outdir) {
	console.error("usage: node generate-compile-cache.mjs <bundleOutdir> [buildId]");
	process.exit(2);
}

const watchdog = setTimeout(() => {
	console.error(`generate-compile-cache: timed out after ${WATCHDOG_MS}ms`);
	process.exit(2);
}, WATCHDOG_MS);

let imported = 0;
let failed = 0;
for (const file of readdirSync(outdir)) {
	if (!file.endsWith(".js") || file === "cli.js") {
		continue;
	}
	try {
		await import(pathToFileURL(join(outdir, file)).href);
		imported++;
	} catch (error) {
		// A chunk whose top-level code throws is still partially cached; skip it.
		failed++;
		console.error(`generate-compile-cache: ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
flushCompileCache();

// The runtime entry (src/cli/compile-cache.ts) only serves this cache when the
// Node version matches; keep the shape in sync with CompileCacheManifest.
const cacheDir = join(outdir, "compile-cache");
mkdirSync(cacheDir, { recursive: true });
writeFileSync(
	join(cacheDir, "manifest.json"),
	`${JSON.stringify({ format: 1, node: process.version, v8: process.versions.v8, buildId: buildId ?? null })}\n`,
);
console.log(`generate-compile-cache: imported=${imported} failed=${failed}`);
clearTimeout(watchdog);
process.exit(0);
