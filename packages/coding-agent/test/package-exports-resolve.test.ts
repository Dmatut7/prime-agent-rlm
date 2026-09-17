import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * F28 guard: every subpath of the package manifest's `exports` map must resolve.
 * The `./hooks` export outlived the hooks system (merged into extensions in
 * c6fc08453): it kept pointing at dist/core/hooks/* after both the source and
 * the build output were deleted, so importing
 * "@earendil-works/pi-coding-agent/hooks" resolved to nothing while the manifest
 * still advertised it. This walk names the exact export and target the next time
 * one is orphaned, instead of leaving the breakage to whoever imports it first.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface ExportTarget {
	subpath: string;
	target: string;
}

function collectExportTargets(exportsField: unknown, subpath: string, targets: ExportTarget[]): void {
	if (typeof exportsField === "string") {
		targets.push({ subpath, target: exportsField });
		return;
	}
	if (Array.isArray(exportsField)) {
		for (const entry of exportsField) collectExportTargets(entry, subpath, targets);
		return;
	}
	if (typeof exportsField === "object" && exportsField !== null) {
		for (const [key, entry] of Object.entries(exportsField as Record<string, unknown>)) {
			// A "."-prefixed key names a subpath; other keys are conditions
			// ("types", "import", "default") that keep the enclosing subpath.
			const nestedSubpath = key.startsWith(".") ? key : subpath;
			collectExportTargets(entry, nestedSubpath, targets);
		}
	}
}

/**
 * A dist target resolves when the built file exists, or when its source
 * counterpart does (a fresh checkout has no dist). Anything else is a dead
 * export.
 */
function distTargetResolves(target: string): boolean {
	if (existsSync(join(packageRoot, target))) return true;
	const distMatch = /^\.\/dist\/(.*)\.(?:d\.ts|js)$/.exec(target);
	if (!distMatch) return false;
	return existsSync(join(packageRoot, "src", `${distMatch[1]}.ts`));
}

describe("package.json exports resolve", () => {
	it("every exports subpath target resolves to a built file or its source counterpart", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
			exports?: unknown;
		};
		const targets: ExportTarget[] = [];
		collectExportTargets(manifest.exports, ".", targets);
		// A manifest rewrite that drops the exports map must not pass vacuously.
		expect(targets.length).toBeGreaterThan(0);

		const unresolved = targets.filter((entry) => !distTargetResolves(entry.target));
		expect(unresolved.map((entry) => `${entry.subpath} -> ${entry.target}`)).toEqual([]);
	});
});
