import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasProjectExtensionInputs,
	PROJECT_TRUST_FILE_NAME,
	type ProjectTrustPrompt,
	type ProjectTrustPromptChoice,
	ProjectTrustStore,
	resolveProjectTrust,
} from "../src/core/project-trust.js";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-trust-store-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for a cwd with no saved decision", () => {
		const store = new ProjectTrustStore(agentDir);
		expect(store.get(join(tempDir, "some-project"))).toBeNull();
	});

	it("round-trips a decision keyed by the canonical cwd", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const store = new ProjectTrustStore(agentDir);

		store.set(projectDir, true);
		expect(store.get(projectDir)).toBe(true);

		store.set(projectDir, false);
		expect(store.get(projectDir)).toBe(false);
	});

	it("treats a symlinked cwd and its target as the same project", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const linkDir = join(tempDir, "link");
		symlinkSync(projectDir, linkDir);
		const store = new ProjectTrustStore(agentDir);

		store.set(linkDir, true);

		expect(store.get(projectDir)).toBe(true);
		expect(store.get(linkDir)).toBe(true);
	});

	it("persists decisions across store instances", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		new ProjectTrustStore(agentDir).set(projectDir, true);

		const reopened = new ProjectTrustStore(agentDir);
		expect(reopened.get(projectDir)).toBe(true);
	});

	it("writes a JSON file whose values are only booleans", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const store = new ProjectTrustStore(agentDir);
		store.set(projectDir, true);

		const raw = JSON.parse(readFileSync(join(agentDir, PROJECT_TRUST_FILE_NAME), "utf-8")) as Record<string, unknown>;
		const decisions = raw.decisions as Record<string, unknown>;
		expect(decisions[realpathSync(projectDir)]).toBe(true);
		for (const value of Object.values(decisions)) {
			expect(typeof value).toBe("boolean");
		}
	});

	it("treats a malformed store as having no decisions instead of crashing", () => {
		writeFileSync(join(agentDir, PROJECT_TRUST_FILE_NAME), "not json {", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);

		expect(store.get(projectDir)).toBeNull();
		// A malformed store must still be writable so the prompt answer can repair it.
		expect(() => store.set(projectDir, true)).not.toThrow();
		expect(store.get(projectDir)).toBe(true);
	});

	it("keeps unrelated decisions when writing a new one", () => {
		const projectA = join(tempDir, "a");
		const projectB = join(tempDir, "b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const store = new ProjectTrustStore(agentDir);

		store.set(projectA, true);
		store.set(projectB, false);

		expect(store.get(projectA)).toBe(true);
		expect(store.get(projectB)).toBe(false);
	});

	it("pins the store creation timestamp once instead of refreshing it", () => {
		const store = new ProjectTrustStore(agentDir);
		expect(store.createdAt()).toBeNull();

		store.ensureCreated();
		const first = store.createdAt();
		expect(first).not.toBeNull();

		// A later run of a newer binary must not restart the grandfather window.
		const reopened = new ProjectTrustStore(agentDir);
		reopened.ensureCreated();
		expect(reopened.createdAt()).toBe(first);
	});
});

describe("hasProjectExtensionInputs", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-trust-inputs-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports no inputs for a directory without .prime/agent", () => {
		expect(hasProjectExtensionInputs(tempDir, {})).toBe(false);
	});

	it("reports no inputs for an empty extensions directory", () => {
		mkdirSync(join(tempDir, ".prime/agent/extensions"), { recursive: true });
		expect(hasProjectExtensionInputs(tempDir, {})).toBe(false);
	});

	it("reports inputs for a discovered .ts extension in the extensions directory", () => {
		const extDir = join(tempDir, ".prime/agent/extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "evil.ts"), "export default () => {}");

		expect(hasProjectExtensionInputs(tempDir, {})).toBe(true);
	});

	it("reports inputs for an extension declared by project settings", () => {
		mkdirSync(join(tempDir, ".prime/agent"), { recursive: true });

		expect(hasProjectExtensionInputs(tempDir, { extensions: ["./custom.ts"] })).toBe(true);
	});

	it("reports inputs for a package declared by project settings", () => {
		mkdirSync(join(tempDir, ".prime/agent"), { recursive: true });

		expect(hasProjectExtensionInputs(tempDir, { packages: ["npm:some-package"] })).toBe(true);
	});
});

describe("resolveProjectTrust", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let store: ProjectTrustStore;
	const projectSettingsWithExtensions = { extensions: ["./custom.ts"] };

	const promptRecording = (): {
		prompt: ProjectTrustPrompt;
		calls: string[];
	} => {
		const calls: string[] = [];
		const prompt: ProjectTrustPrompt = async (cwd) => {
			calls.push(cwd);
			return { trusted: true, remember: true } satisfies ProjectTrustPromptChoice;
		};
		return { prompt, calls };
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-trust-resolve-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".prime/agent/extensions"), { recursive: true });
		writeFileSync(join(projectDir, ".prime/agent/extensions", "a.ts"), "export default () => {}");
		store = new ProjectTrustStore(agentDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("treats a directory without project extension inputs as trusted", async () => {
		const bareDir = join(tempDir, "bare");
		mkdirSync(bareDir);
		const { prompt, calls } = promptRecording();

		const resolution = await resolveProjectTrust({
			cwd: bareDir,
			projectSettings: {},
			store,
			interactive: false,
			prompt,
		});

		expect(resolution).toEqual({ trusted: true, reason: "no-inputs" });
		expect(calls).toEqual([]);
		expect(store.get(bareDir)).toBeNull();
	});

	it("honors an explicit --approve override without prompting or saving", async () => {
		const { prompt, calls } = promptRecording();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			override: true,
			interactive: true,
			prompt,
		});

		expect(resolution).toEqual({ trusted: true, reason: "override" });
		expect(calls).toEqual([]);
		expect(store.get(projectDir)).toBeNull();
	});

	it("honors an explicit --no-approve override and explains the refusal", async () => {
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			override: false,
			interactive: true,
			prompt,
			notify,
		});

		expect(resolution).toEqual({ trusted: false, reason: "override" });
		expect(calls).toEqual([]);
		expect(store.get(projectDir)).toBeNull();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("not trusted");
	});

	it("reuses a saved decision in both directions without prompting", async () => {
		const { prompt, calls } = promptRecording();
		store.set(projectDir, true);

		const trusted = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: false,
			prompt,
		});
		expect(trusted).toEqual({ trusted: true, reason: "saved" });
		expect(calls).toEqual([]);

		store.set(projectDir, false);
		const notify = vi.fn();
		const untrusted = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: false,
			prompt,
			notify,
		});
		expect(untrusted).toEqual({ trusted: false, reason: "saved" });
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0]?.[0])).toContain("not trusted");
	});

	it("never prompts and refuses by default in machine mode, explaining why", async () => {
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: false,
			prompt,
			notify,
		});

		expect(resolution).toEqual({ trusted: false, reason: "machine-default" });
		// The whole point of the machine-mode branch: no prompt call may happen.
		expect(calls).toEqual([]);
		// A machine run never writes a decision, so a later interactive run can still ask.
		expect(store.get(projectDir)).toBeNull();
		expect(notify).toHaveBeenCalledTimes(1);
		const message = String(notify.mock.calls[0]?.[0]);
		expect(message).toContain(projectDir);
		expect(message).toContain("--approve");
	});

	it("prompts once in interactive mode and remembers the trust answer", async () => {
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: projectSettingsWithExtensions,
			store,
			interactive: true,
			prompt,
			notify,
		});

		expect(resolution).toEqual({ trusted: true, reason: "prompt" });
		expect(calls).toEqual([projectDir]);
		expect(store.get(projectDir)).toBe(true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("remembers an interactive refusal", async () => {
		store.ensureCreated();
		const prompt: ProjectTrustPrompt = async () => ({ trusted: false, remember: true });

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
		});

		expect(resolution).toEqual({ trusted: false, reason: "prompt" });
		expect(store.get(projectDir)).toBe(false);
	});

	it("does not announce an explicit interactive refusal: the in-app warning already covers it", async () => {
		store.ensureCreated();
		const prompt: ProjectTrustPrompt = async () => ({ trusted: false, remember: true });
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			notify,
		});

		// The user just answered the question; the resource loader's refreshed
		// in-app warning is the one announcement of the held-back extensions.
		expect(resolution).toEqual({ trusted: false, reason: "prompt" });
		expect(store.get(projectDir)).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("honors a session-only trust answer without persisting it", async () => {
		store.ensureCreated();
		const prompt: ProjectTrustPrompt = async () => ({ trusted: true, remember: false });

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
		});

		expect(resolution).toEqual({ trusted: true, reason: "prompt" });
		expect(store.get(projectDir)).toBeNull();
	});

	it("treats a dismissed prompt as untrusted for this session without saving", async () => {
		store.ensureCreated();
		const prompt: ProjectTrustPrompt = async () => undefined;
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			notify,
		});

		expect(resolution).toEqual({ trusted: false, reason: "prompt-cancelled" });
		expect(store.get(projectDir)).toBeNull();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("skips the prompt and the refusal notice when extensions are disabled for the run", async () => {
		store.ensureCreated();
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			notify,
			// --no-extensions: the answer cannot change this run, so there is
			// nothing a human could usefully decide and nothing to announce.
			extensionsDisabled: true,
		});

		expect(resolution).toEqual({ trusted: false, reason: "machine-default" });
		expect(calls).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
		expect(store.get(projectDir)).toBeNull();
	});

	it("still grandfathers a prior-use directory when extensions are disabled for the run", async () => {
		store.ensureCreated();
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			notify,
			extensionsDisabled: true,
			hasPriorSession: () => true,
		});

		// Grandfathering persists a decision for future (extension-enabled)
		// runs, so it still applies - and its notice still explains what was
		// persisted and where to change it.
		expect(resolution).toEqual({ trusted: true, reason: "grandfathered" });
		expect(calls).toEqual([]);
		expect(store.get(projectDir)).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("auto-trusts a directory with prior sessions during the upgrade grandfather window", async () => {
		store.ensureCreated();
		const { prompt, calls } = promptRecording();
		const notify = vi.fn();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			notify,
			hasPriorSession: () => true,
		});

		expect(resolution).toEqual({ trusted: true, reason: "grandfathered" });
		expect(calls).toEqual([]);
		expect(store.get(projectDir)).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		const grandfatherNotice = String(notify.mock.calls[0]?.[0]);
		expect(grandfatherNotice).toContain("trusted automatically once for this upgrade");
		expect(grandfatherNotice).toContain(store.filePath());
	});

	it("auto-trusts in machine mode too when prior sessions exist (unattended self-recovery)", async () => {
		store.ensureCreated();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: false,
			hasPriorSession: () => true,
		});

		expect(resolution).toEqual({ trusted: true, reason: "grandfathered" });
		expect(store.get(projectDir)).toBe(true);
	});

	it("does not grandfather a directory with no prior sessions", async () => {
		store.ensureCreated();
		const { prompt, calls } = promptRecording();

		const resolution = await resolveProjectTrust({
			cwd: projectDir,
			projectSettings: {},
			store,
			interactive: true,
			prompt,
			hasPriorSession: () => false,
		});

		expect(resolution.reason).toBe("prompt");
		expect(calls).toEqual([projectDir]);
	});

	it("does not grandfather when the clock reads before the store was created", async () => {
		store.ensureCreated();
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
		const { prompt, calls } = promptRecording();
		try {
			const resolution = await resolveProjectTrust({
				cwd: projectDir,
				projectSettings: {},
				store,
				interactive: true,
				prompt,
				hasPriorSession: () => true,
			});

			// A skewed clock must not reopen or extend the grandfather window.
			expect(resolution.reason).toBe("prompt");
			expect(calls).toEqual([projectDir]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not grandfather after the window has elapsed", async () => {
		store.ensureCreated();
		// 15 days after the gate landed: the one-time upgrade grace is over.
		const stale = Date.now() + 15 * 24 * 60 * 60 * 1000;
		vi.useFakeTimers();
		vi.setSystemTime(stale);
		const { prompt, calls } = promptRecording();
		try {
			const resolution = await resolveProjectTrust({
				cwd: projectDir,
				projectSettings: {},
				store,
				interactive: true,
				prompt,
				hasPriorSession: () => true,
			});

			expect(resolution.reason).toBe("prompt");
			expect(calls).toEqual([projectDir]);
		} finally {
			vi.useRealTimers();
		}
	});
});
