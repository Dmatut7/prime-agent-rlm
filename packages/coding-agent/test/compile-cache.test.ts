import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	COMPILE_CACHE_DIR_NAME,
	COMPILE_CACHE_MANIFEST_NAME,
	selectCompileCacheDir,
} from "../src/cli/compile-cache.js";

let bundleDir: string;

function cacheDir() {
	return join(bundleDir, COMPILE_CACHE_DIR_NAME);
}

function writeManifest(content: string) {
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(join(cacheDir(), COMPILE_CACHE_MANIFEST_NAME), content);
}

beforeEach(() => {
	bundleDir = mkdtempSync(join(tmpdir(), "pi-compile-cache-test-"));
});

afterEach(() => {
	rmSync(bundleDir, { recursive: true, force: true });
});

describe("selectCompileCacheDir", () => {
	test("returns the shipped cache dir when the manifest matches the running Node", () => {
		writeManifest(JSON.stringify({ format: 1, node: "v22.22.0", v8: "12.4.254.21" }));
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBe(cacheDir());
	});

	test("rejects a cache built by a different Node version", () => {
		writeManifest(JSON.stringify({ format: 1, node: "v24.12.0" }));
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("rejects when the manifest is missing", () => {
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("rejects a manifest that is not valid JSON", () => {
		writeManifest("{not json");
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("rejects a manifest that is not an object", () => {
		writeManifest(JSON.stringify("v22.22.0"));
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("rejects a manifest with an unknown format", () => {
		writeManifest(JSON.stringify({ format: 2, node: "v22.22.0" }));
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("rejects a manifest without a node field", () => {
		writeManifest(JSON.stringify({ format: 1 }));
		expect(selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0" })).toBeUndefined();
	});

	test("a user-set NODE_COMPILE_CACHE always wins over the shipped cache", () => {
		writeManifest(JSON.stringify({ format: 1, node: "v22.22.0" }));
		expect(
			selectCompileCacheDir({ bundleDir, nodeVersion: "v22.22.0", envDir: "/tmp/my-own-cache" }),
		).toBeUndefined();
	});

	test("an unreadable manifest degrades to the default cache instead of throwing", () => {
		mkdirSync(cacheDir(), { recursive: true });
		expect(
			selectCompileCacheDir({
				bundleDir,
				nodeVersion: "v22.22.0",
				readFile: () => {
					throw new Error("EACCES");
				},
			}),
		).toBeUndefined();
	});

	test("the build-time generator writes a manifest the runtime gate accepts", () => {
		// The generator is plain JS and the gate is TS; this pins their shared
		// manifest contract (dir layout, file name, format, node field).
		writeFileSync(join(bundleDir, "chunk-fixture.js"), "export const fixture = 1;\n");
		writeFileSync(join(bundleDir, "cli.js"), "console.log('must not be imported');\n");
		const generator = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "generate-compile-cache.mjs");
		const home = mkdtempSync(join(tmpdir(), "pi-compile-cache-gen-home-"));
		const tmp = mkdtempSync(join(tmpdir(), "pi-compile-cache-gen-tmp-"));
		try {
			const out = execFileSync(process.execPath, [generator, bundleDir], {
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					TMPDIR: tmp,
					NODE_COMPILE_CACHE: cacheDir(),
				},
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30_000,
			});
			expect(out.toString()).not.toContain("must not be imported");
			expect(selectCompileCacheDir({ bundleDir, nodeVersion: process.version })).toBe(cacheDir());
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(tmp, { recursive: true, force: true });
		}
	}, 45_000);
});
