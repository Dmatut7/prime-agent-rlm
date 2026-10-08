import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.js";
import { handleConfigCommand, isSelfUpdateSource } from "../src/package-manager-cli.js";

/**
 * The interactive /update parser (interactive-mode's isSelfUpdatePositionalArg)
 * lowercases its comparison; the CLI side must agree or `/update Prime-Agent`
 * means self-update to one and a package name to the other.
 */
describe("isSelfUpdateSource", () => {
	it("matches the interactive parser's case-insensitive self targets", () => {
		expect(isSelfUpdateSource("self")).toBe(true);
		expect(isSelfUpdateSource("Self")).toBe(true);
		expect(isSelfUpdateSource("SELF")).toBe(true);
		expect(isSelfUpdateSource("pi")).toBe(true);
		expect(isSelfUpdateSource("Pi")).toBe(true);
		expect(isSelfUpdateSource(APP_NAME)).toBe(true);
		expect(isSelfUpdateSource(APP_NAME.toUpperCase())).toBe(true);
		expect(isSelfUpdateSource("npm:@foo/bar")).toBe(false);
	});
});

describe("handleConfigCommand", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("refuses a non-TTY run instead of leaking the interactive selector's escape sequences", async () => {
		// The selector writes raw TUI frames to stdout; piped, that is garbage plus
		// an odd exit code. The gate answers on stderr and leaves a clean failure.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit must not run for the gated path");
		});
		const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		try {
			const handled = await handleConfigCommand(["config"]);
			expect(handled).toBe(true);
			expect(process.exitCode).toBe(1);
			expect(exitSpy).not.toHaveBeenCalled();
			const text = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(text).toContain("interactive terminal");
		} finally {
			if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
			if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
		}
	});

	it("ignores unrelated commands", async () => {
		expect(await handleConfigCommand(["update"])).toBe(false);
	});
});
