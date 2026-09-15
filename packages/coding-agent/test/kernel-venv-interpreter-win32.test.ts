import { win32 as win32Path } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kernelInstallArgs, kernelVenvInterpreter } from "../src/core/kernel/bootstrap.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
});

describe("kernel venv interpreter path per platform", () => {
	it("builds the uv install argv against Scripts\\python.exe on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const venv = "C:\\Users\\u\\.prime\\agent\\kernel-venv\\g-1";
		const python = kernelVenvInterpreter(venv);

		// uv lays a Windows venv out as Scripts\\python.exe (with the extension);
		// the old bin/python literal never exists there, so the readiness check
		// fails and the kernel cannot start.
		expect(python).toBe(win32Path.join(venv, "Scripts", "python.exe"));
		expect(kernelInstallArgs(python, "prime-agent-runtime @ file:///runtime")).toContain(python);
	});

	it("keeps bin/python on posix", () => {
		const venv = "/home/u/.prime/agent/kernel-venv/g-1";
		expect(kernelVenvInterpreter(venv)).toBe(`${venv}/bin/python`);
	});
});
