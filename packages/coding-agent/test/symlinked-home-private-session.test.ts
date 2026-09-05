import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("session storage beneath a symlinked home layout", () => {
	let realStore = "";
	let home = "";

	beforeEach(() => {
		realStore = mkdtempSync(join(tmpdir(), "pi-real-store-"));
		home = mkdtempSync(join(tmpdir(), "pi-home-"));
		// A relocated ~/.prime: the agent dir lives behind a symlink. This used to
		// make every private-storage append throw "non-directory private path".
		symlinkSync(realStore, join(home, ".prime"));
	});

	afterEach(() => {
		rmSync(realStore, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	it("appends session entries through the symlinked agent dir", () => {
		const sessionDir = join(home, ".prime", "agent", "sessions");
		const manager = SessionManager.create(home, sessionDir);
		manager.appendSessionState({ status: "active" });
		manager.flushNow();
		manager.appendSessionInfo("follow-up");

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Missing session file");
		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain('"status":"active"');
		expect(content).toContain("follow-up");
		expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
		expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
		// The symlink resolves to the real store; storage must land there privately.
		expect(statSync(join(realStore, "agent", "sessions")).mode & 0o777).toBe(0o700);
	});
});
