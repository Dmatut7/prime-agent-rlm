import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawn: mocks.spawn };
});

import { killProcessTree } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalSystemRoot = process.env.SystemRoot;

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	if (originalSystemRoot === undefined) {
		delete process.env.SystemRoot;
	} else {
		process.env.SystemRoot = originalSystemRoot;
	}
	mocks.spawn.mockReset();
});

describe("killProcessTree on win32", () => {
	it("spawns the absolute System32 taskkill with an error listener", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.SystemRoot = "D:\\Win";
		const on = vi.fn();
		mocks.spawn.mockReturnValue({ on });

		killProcessTree(4321);

		// A bare "taskkill" resolves through PATH/CWD and a planted taskkill.exe
		// can win; the absolute System32 path cannot. spawn failures surface as
		// async "error" events, so without a listener they crash the host.
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		const [command, args] = mocks.spawn.mock.calls[0] as unknown as [string, string[]];
		expect(command).toBe("D:\\Win\\System32\\taskkill.exe");
		expect(args).toEqual(["/F", "/T", "/PID", "4321"]);
		expect(on).toHaveBeenCalledWith("error", expect.any(Function));
	});

	it("falls back to the default SystemRoot when unset", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		delete process.env.SystemRoot;
		mocks.spawn.mockReturnValue({ on: vi.fn() });

		killProcessTree(7);
		const [command] = mocks.spawn.mock.calls[0] as unknown as [string, string[]];
		expect(command).toBe("C:\\Windows\\System32\\taskkill.exe");
	});
});
