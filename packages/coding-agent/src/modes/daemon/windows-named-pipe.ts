import { execFileSync } from "node:child_process";

const WINDOWS_SID_PATTERN = /^S-\d+(?:-\d+)+$/;
const WINDOWS_NAMED_PIPE_PATH_PATTERN = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;

export const WINDOWS_NAMED_PIPE_ACL_UNVERIFIED = "Windows named-pipe ACL application is not hardware-verified in CI";

export function isWindowsSid(value: string): boolean {
	return WINDOWS_SID_PATTERN.test(value);
}

export function parseWhoamiUserSid(output: string): string | undefined {
	const matches = output.match(/\bS-\d+(?:-\d+)+\b/g);
	return matches?.at(-1);
}

export function windowsNamedPipeOwnerSddl(userSid: string): string {
	if (!isWindowsSid(userSid)) {
		throw new Error(`Invalid Windows user SID: ${userSid}`);
	}
	// Protected DACL: current user and SYSTEM only. Administrators are omitted on
	// purpose so a second logged-on account cannot attach to this daemon.
	return `D:P(A;;GA;;;${userSid})(A;;GA;;;SY)`;
}

export function windowsDaemonPipePath(userSid: string): string {
	if (!isWindowsSid(userSid)) {
		throw new Error(`Invalid Windows user SID: ${userSid}`);
	}
	return `\\\\.\\pipe\\prime-agent-${userSid}`;
}

export function isWindowsNamedPipePath(path: string): boolean {
	return WINDOWS_NAMED_PIPE_PATH_PATTERN.test(path);
}

export function daemonIpcListenOptions(socketPath: string): {
	path: string;
	readableAll: false;
	writableAll: false;
} {
	return { path: socketPath, readableAll: false, writableAll: false };
}

export function queryWindowsUserSid(run: (command: string, args: string[]) => string = runWhoamiUser): string {
	const sid = parseWhoamiUserSid(run("whoami.exe", ["/user"]));
	if (!sid) {
		throw new Error("Could not determine the current Windows user SID");
	}
	return sid;
}

function runWhoamiUser(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function assertSafeNamedPipeAclInput(pipePath: string, sddl: string): void {
	if (!isWindowsNamedPipePath(pipePath)) {
		throw new Error(`Refusing to set ACL on a non-pipe path: ${pipePath}`);
	}
	if (/[\r\n'"$`]/.test(pipePath) || /[\r\n'"$`]/.test(sddl)) {
		throw new Error("Refusing to apply named-pipe SDDL with unsafe characters");
	}
	if (!sddl.startsWith("D:P") || !sddl.includes("(A;;GA;;;")) {
		throw new Error(`Refusing to apply unexpected named-pipe SDDL: ${sddl}`);
	}
}

/** PowerShell body that calls SetNamedSecurityInfo on a named pipe. */
export function windowsNamedPipeAclCommand(pipePath: string, sddl: string): string {
	assertSafeNamedPipeAclInput(pipePath, sddl);
	return [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -TypeDefinition @'",
		"using System;",
		"using System.ComponentModel;",
		"using System.Runtime.InteropServices;",
		"public static class PrimeAgentNamedPipeAcl {",
		"  const uint SeFileObject = 1;",
		"  const uint DaclSecurityInformation = 4;",
		'  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
		"  static extern uint SetNamedSecurityInfo(string pObjectName, uint objectType, uint securityInfo, IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl);",
		'  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
		"  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string StringSecurityDescriptor, uint StringSDRevision, out IntPtr SecurityDescriptor, IntPtr SecurityDescriptorSize);",
		'  [DllImport("advapi32.dll", SetLastError = true)]',
		"  static extern bool GetSecurityDescriptorDacl(IntPtr pSecurityDescriptor, out bool lpbDaclPresent, out IntPtr pDacl, out bool lpbDaclDefaulted);",
		'  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr hMem);',
		"  public static void Apply(string name, string sddl) {",
		"    IntPtr sd;",
		"    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, IntPtr.Zero)) throw new Win32Exception();",
		"    try {",
		"      bool present, isDefault; IntPtr dacl;",
		'      if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out isDefault) || !present) throw new InvalidOperationException("SDDL produced no DACL");',
		"      uint err = SetNamedSecurityInfo(name, SeFileObject, DaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);",
		"      if (err != 0) throw new Win32Exception(unchecked((int)err));",
		"    } finally { LocalFree(sd); }",
		"  }",
		"}",
		"'@",
		`[PrimeAgentNamedPipeAcl]::Apply('${pipePath}', '${sddl}')`,
	].join("\n");
}

export function applyWindowsNamedPipeSddl(
	pipePath: string,
	sddl: string,
	run: (command: string, args: readonly string[]) => void = runPowerShell,
): void {
	run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		windowsNamedPipeAclCommand(pipePath, sddl),
	]);
}

function runPowerShell(command: string, args: readonly string[]): void {
	execFileSync(command, [...args], {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function restrictWindowsNamedPipeAccess(
	pipePath: string,
	options: {
		userSid?: string;
		applySddl?: (pipePath: string, sddl: string) => void;
	} = {},
): string {
	const userSid = options.userSid ?? queryWindowsUserSid();
	const sddl = windowsNamedPipeOwnerSddl(userSid);
	(options.applySddl ?? applyWindowsNamedPipeSddl)(pipePath, sddl);
	return sddl;
}
