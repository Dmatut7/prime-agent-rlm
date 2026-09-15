import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-manager.js";

/**
 * DAT-4 (fsync gap): settings writes were tmp+rename without fsync. A power loss
 * right after the rename can resurrect the old settings bytes from an unflushed page
 * cache. The write must fsync the temp before the rename exposes it - the same
 * durability policy writePrivateFileAtomic and the cron store already follow.
 */

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const fsyncSync = ((descriptor: number) => {
		calls.order.push("fsync");
		return actual.fsyncSync(descriptor);
	}) as typeof actual.fsyncSync;
	const renameSync = ((...args: unknown[]) => {
		calls.order.push("rename");
		return (actual.renameSync as unknown as (...renameArgs: unknown[]) => void)(...args);
	}) as typeof actual.renameSync;
	return { ...actual, fsyncSync, renameSync };
});

const roots: string[] = [];

afterEach(() => {
	calls.order.length = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FileSettingsStorage.withLock durability", () => {
	it("fsyncs the temp file before renaming it into place", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-dat4-settings-"));
		roots.push(root);
		const storage = new FileSettingsStorage(root, join(root, "agent"));

		storage.withLock("global", () => '{"theme":"dark"}');

		const firstRename = calls.order.indexOf("rename");
		expect(firstRename).toBeGreaterThan(-1);
		const fsyncsBeforeRename = calls.order.slice(0, firstRename).filter((call) => call === "fsync").length;
		expect(fsyncsBeforeRename).toBeGreaterThan(0);
	});
});
