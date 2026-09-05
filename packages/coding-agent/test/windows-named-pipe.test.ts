import { describe, expect, it, vi } from "vitest";
import {
	applyWindowsNamedPipeSddl,
	daemonIpcListenOptions,
	isWindowsNamedPipePath,
	parseWhoamiUserSid,
	queryWindowsUserSid,
	restrictWindowsNamedPipeAccess,
	windowsDaemonPipePath,
	windowsNamedPipeAclCommand,
	windowsNamedPipeOwnerSddl,
} from "../src/modes/daemon/windows-named-pipe.js";

const SID = "S-1-5-21-3623811015-3361044348-30300820-1013";
const PIPE = `\\\\.\\pipe\\prime-agent-${SID}`;

describe("windows named pipe ACL helpers", () => {
	it("parses the SID from whoami /user output", () => {
		expect(
			parseWhoamiUserSid(`
USER INFORMATION
----------------

User Name           SID
=================== ============================================
desktop-abc\\alice   ${SID}
`),
		).toBe(SID);
	});

	it("rejects an invalid SID in the pipe path and SDDL builders", () => {
		expect(() => windowsDaemonPipePath("not-a-sid")).toThrow(/Invalid Windows user SID/);
		expect(() => windowsNamedPipeOwnerSddl("S-1")).toThrow(/Invalid Windows user SID/);
	});

	it("builds a per-user pipe path and owner-only SDDL", () => {
		expect(windowsDaemonPipePath(SID)).toBe(PIPE);
		expect(windowsNamedPipeOwnerSddl(SID)).toBe(`D:P(A;;GA;;;${SID})(A;;GA;;;SY)`);
		expect(isWindowsNamedPipePath(PIPE)).toBe(true);
		expect(isWindowsNamedPipePath("/tmp/daemon.sock")).toBe(false);
	});

	it("never opens IPC sockets to all users", () => {
		expect(daemonIpcListenOptions(PIPE)).toEqual({
			path: PIPE,
			readableAll: false,
			writableAll: false,
		});
	});

	it("reads the current user SID through whoami", () => {
		const run = vi.fn(() => `User Name  SID\nfoo\\bar  ${SID}\n`);
		expect(queryWindowsUserSid(run)).toBe(SID);
		expect(run).toHaveBeenCalledWith("whoami.exe", ["/user"]);
	});

	it("restricts a named pipe with the current-user SDDL", () => {
		const applied: Array<[string, string]> = [];
		const sddl = restrictWindowsNamedPipeAccess(PIPE, {
			userSid: SID,
			applySddl: (pipePath, next) => {
				applied.push([pipePath, next]);
			},
		});
		expect(sddl).toBe(`D:P(A;;GA;;;${SID})(A;;GA;;;SY)`);
		expect(applied).toEqual([[PIPE, sddl]]);
	});

	it("refuses to emit a PowerShell ACL command for a non-pipe path", () => {
		expect(() => windowsNamedPipeAclCommand("/tmp/daemon.sock", windowsNamedPipeOwnerSddl(SID))).toThrow(
			/non-pipe path/,
		);
	});

	it("embeds the pipe path and SDDL in the PowerShell apply command", () => {
		const sddl = windowsNamedPipeOwnerSddl(SID);
		const command = windowsNamedPipeAclCommand(PIPE, sddl);
		expect(command).toContain("SetNamedSecurityInfo");
		expect(command).toContain(PIPE);
		expect(command).toContain(sddl);
		expect(command).not.toContain("SeKernelObject");
	});

	it("invokes powershell.exe to apply the SDDL", () => {
		const run = vi.fn();
		const sddl = windowsNamedPipeOwnerSddl(SID);
		applyWindowsNamedPipeSddl(PIPE, sddl, run);
		expect(run).toHaveBeenCalledTimes(1);
		const [command, args] = run.mock.calls[0]!;
		expect(command).toBe("powershell.exe");
		expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
		expect(args[4]).toContain(PIPE);
		expect(args[4]).toContain(sddl);
	});
});
