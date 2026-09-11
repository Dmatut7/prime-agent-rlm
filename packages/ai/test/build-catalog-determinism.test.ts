/**
 * Pins the deterministic-build invariant: a build compiles the committed model
 * catalog and never refetches it. While `packages/ai`'s build ran
 * `generate-models` first, every build (and every CI/release build) fetched the
 * live catalogs and rewrote the committed `src/models.generated.ts` in place, so
 * a model dropped by an upstream source broke unrelated builds and releases
 * shipped a catalog nobody reviewed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const generatedCatalog = join(packageRoot, "src", "models.generated.ts");

function readScripts(dir: string): Record<string, string> {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};
	return manifest.scripts ?? {};
}

function workspacePackageDirs(): string[] {
	return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, "packages", entry.name, "package.json")))
		.map((entry) => join(repoRoot, "packages", entry.name));
}

describe("model catalog build determinism", () => {
	it("builds packages/ai from the committed catalog", () => {
		const scripts = readScripts(packageRoot);

		expect(scripts.build).toBeTruthy();
		expect(scripts.build).not.toContain("generate-models");
		expect(scripts.build).toContain("tsgo");
		// Refreshing the catalog stays an explicit, reviewed step.
		expect(scripts["generate-models"]).toContain("scripts/generate-models.ts");
		expect(existsSync(generatedCatalog)).toBe(true);
	});

	it("keeps every workspace build script from refetching the catalog", () => {
		const dirs = workspacePackageDirs();
		expect(dirs.length).toBeGreaterThan(0);
		expect(dirs).toContain(packageRoot);

		for (const dir of dirs) {
			const scripts = readScripts(dir);
			for (const [name, command] of Object.entries(scripts)) {
				if (!name.includes("build")) continue;
				expect(command, `${relative(repoRoot, dir)} npm run ${name}`).not.toContain("generate-models");
			}
		}
	});

	it("writes the committed catalog as the generator's only output", () => {
		const generator = readFileSync(join(packageRoot, "scripts", "generate-models.ts"), "utf8");
		const writeTargets = [...generator.matchAll(/writeFileSync\(\s*join\(packageRoot,\s*"([^"]+)"/g)].map(
			(match) => match[1],
		);

		expect(writeTargets).toEqual(["src/models.generated.ts"]);
		expect(readFileSync(generatedCatalog, "utf8").length).toBeGreaterThan(0);
	});
});
