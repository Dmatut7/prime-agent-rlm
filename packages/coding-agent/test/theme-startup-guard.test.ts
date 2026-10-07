import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, loadThemeFromPath, setTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * A custom theme missing required color tokens used to pass the startup
 * minimal check, then crash the first render when theme.fg() hit an unknown
 * token — taking the whole interactive process down (no uncaughtException
 * handler on that path). The startup guard must refuse such a theme up front.
 */

describe("theme startup guard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		initTheme("dark");
	});

	it("refuses a theme missing required color tokens during the minimal startup check", () => {
		const dir = mkdtempSync(join(tmpdir(), "broken-theme-"));
		tempDirs.push(dir);
		const themePath = join(dir, "broken.json");
		writeFileSync(
			themePath,
			JSON.stringify({ name: "broken", colors: { accent: "#ff0000", border: "#00ff00" } }),
			"utf8",
		);

		// Before the validator is warm (it is lazy), the minimal structural check
		// runs: missing required tokens must throw at parse time, not at the
		// first fg() render.
		expect(() => loadThemeFromPath(themePath)).toThrow(/Invalid theme/);
	});

	it("refuses a theme whose color values cannot render", () => {
		const dir = mkdtempSync(join(tmpdir(), "badvalue-theme-"));
		tempDirs.push(dir);
		const themePath = join(dir, "bad-value.json");
		// Start from a complete, valid theme (the built-in dark) so only the
		// value shape is broken.
		const base = JSON.parse(
			readFileSync(join(import.meta.dirname, "../src/modes/interactive/theme/dark.json"), "utf8"),
		) as { colors: Record<string, string> };
		const colors = { ...base.colors, accent: { not: "a color" } as unknown as string };
		writeFileSync(themePath, JSON.stringify({ name: "bad-value", colors }), "utf8");

		expect(() => loadThemeFromPath(themePath)).toThrow(/Invalid theme/);
	});

	it("falls back to a working theme after a failed load instead of crashing on render", () => {
		const result = setTheme("no-such-theme");
		expect(result.success).toBe(false);
		// The fallback theme must be fully usable: fg() for a core token must not
		// throw (this is the exact call that used to crash the process).
		expect(() => theme.fg("text", "hello")).not.toThrow();
	});

	it("initTheme survives a name that cannot load", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => initTheme("no-such-theme")).not.toThrow();
			expect(() => theme.fg("text", "hello")).not.toThrow();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
