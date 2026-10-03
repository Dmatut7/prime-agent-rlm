// Dependency-free (node:fs/node:path only) and never throws: this runs on the
// cli.ts entry path before the cli-main import graph, so any failure must
// degrade to the default cache behavior instead of breaking startup.
//
// `npm run build` (scripts/bundle.mjs + scripts/generate-compile-cache.mjs)
// pre-warms a V8 compile cache into <bundleDir>/compile-cache with a manifest
// recording the Node version that generated it. The cache is keyed by absolute
// path and is not portable across Node versions, so the entry only uses it
// when the running Node matches the manifest; anything else falls back to
// `enableCompileCache()`'s default directory. Node additionally partitions
// cache entries by version/arch/uid on its own, so a stale or foreign cache
// can only miss (and be recompiled), never crash.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const COMPILE_CACHE_DIR_NAME = "compile-cache";
export const COMPILE_CACHE_MANIFEST_NAME = "manifest.json";
export const COMPILE_CACHE_FORMAT = 1;

export interface CompileCacheManifest {
	format: number;
	node: string;
}

export interface CompileCacheSelection {
	bundleDir: string;
	nodeVersion: string;
	/** process.env.NODE_COMPILE_CACHE; a user-set directory always wins. */
	envDir?: string | undefined;
	readFile?: (path: string) => string;
}

/**
 * Returns the shipped cache directory when it exists and matches the running
 * Node, or undefined when the caller should use enableCompileCache()'s default
 * directory resolution.
 */
export function selectCompileCacheDir(selection: CompileCacheSelection): string | undefined {
	if (selection.envDir) {
		return undefined;
	}
	try {
		const cacheDir = join(selection.bundleDir, COMPILE_CACHE_DIR_NAME);
		const readFile = selection.readFile ?? ((path: string) => readFileSync(path, "utf8"));
		const manifest: unknown = JSON.parse(readFile(join(cacheDir, COMPILE_CACHE_MANIFEST_NAME)));
		if (typeof manifest !== "object" || manifest === null) {
			return undefined;
		}
		const { format, node } = manifest as Partial<CompileCacheManifest>;
		if (format !== COMPILE_CACHE_FORMAT || node !== selection.nodeVersion) {
			return undefined;
		}
		return cacheDir;
	} catch {
		return undefined;
	}
}
