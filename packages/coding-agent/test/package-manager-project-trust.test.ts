import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { ProjectTrustStore } from "../src/core/project-trust.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * The extension trust gate: project-scoped extension sources must not load
 * unless the project directory is trusted, while user-scoped sources stay
 * untouched. The scenarios mirror GHSA-mqxh-6gq7-558m: a cloned repository
 * that carries .prime/agent/extensions must not get its code executed just
 * because prime-agent started in it.
 */
describe("project extension trust gate", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	const writeProjectExtension = (name: string) => {
		const extDir = join(cwd, ".prime/agent/extensions");
		mkdirSync(extDir, { recursive: true });
		const file = join(extDir, name);
		writeFileSync(
			file,
			`export default function (pi) { pi.registerCommand("${name}", { handler: async () => {} }); }\n`,
		);
		return file;
	};

	const writeUserExtension = (name: string) => {
		const extDir = join(agentDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		const file = join(extDir, name);
		writeFileSync(
			file,
			`export default function (pi) { pi.registerCommand("${name}", { handler: async () => {} }); }\n`,
		);
		return file;
	};

	const projectExtensionPaths = async (options?: {
		projectTrusted?: boolean;
		store?: ProjectTrustStore;
	}): Promise<string[]> => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
			...(options?.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
		});
		const resolved = await packageManager.resolve();
		return resolved.extensions.filter((r) => r.enabled).map((r) => r.path);
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-trust-gate-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("DefaultPackageManager gate", () => {
		it("loads project extensions when the project is trusted", async () => {
			const projectExtension = writeProjectExtension("project-ext.ts");

			const paths = await projectExtensionPaths({ projectTrusted: true });

			expect(paths).toContain(projectExtension);
		});

		it("skips auto-discovered project extensions when the project is untrusted", async () => {
			writeProjectExtension("project-ext.ts");

			const paths = await projectExtensionPaths({ projectTrusted: false });

			expect(paths).toEqual([]);
		});

		it("skips project extensions declared by project settings when untrusted", async () => {
			const extDir = join(cwd, ".prime/agent");
			mkdirSync(extDir, { recursive: true });
			const declared = join(extDir, "declared.ts");
			writeFileSync(
				declared,
				'export default function (pi) { pi.registerCommand("declared", { handler: async () => {} }); }\n',
			);
			writeFileSync(join(extDir, "settings.json"), JSON.stringify({ extensions: ["./declared.ts"] }), "utf-8");

			const paths = await projectExtensionPaths({ projectTrusted: false });

			expect(paths).toEqual([]);
		});

		it("keeps loading user-scope extensions when the project is untrusted", async () => {
			writeProjectExtension("project-ext.ts");
			const userExtension = writeUserExtension("user-ext.ts");

			const paths = await projectExtensionPaths({ projectTrusted: false });

			expect(paths).toEqual([userExtension]);
		});

		it("keeps a user-scope alias when the same files also appear under the project scope", async () => {
			// The user symlinks one shared extension dir into both scopes; the
			// gate holds back the project alias, not the user's own alias.
			const sharedDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedDir, { recursive: true });
			writeFileSync(
				join(sharedDir, "shared.ts"),
				'export default function (pi) { pi.registerCommand("shared", { handler: async () => {} }); }\n',
			);
			symlinkSync(sharedDir, join(agentDir, "extensions"), "dir");
			mkdirSync(join(cwd, ".prime/agent"), { recursive: true });
			symlinkSync(sharedDir, join(cwd, ".prime/agent/extensions"), "dir");

			const settingsManager = SettingsManager.create(cwd, agentDir);
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: null,
				projectTrusted: false,
			});
			const resolved = await packageManager.resolve();

			const enabledPaths = resolved.extensions.filter((r) => r.enabled).map((r) => r.path);
			expect(enabledPaths).toEqual([join(agentDir, "extensions", "shared.ts")]);
			expect(packageManager.getLastSkippedProjectExtensions()).toHaveLength(1);
		});

		it("records the held-back extensions so callers can explain the refusal", async () => {
			const projectExtension = writeProjectExtension("project-ext.ts");

			const settingsManager = SettingsManager.create(cwd, agentDir);
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: null,
				projectTrusted: false,
			});
			await packageManager.resolve();

			const skipped = packageManager.getLastSkippedProjectExtensions();
			expect(skipped).toHaveLength(1);
			expect(skipped[0]?.path).toBe(projectExtension);
			expect(skipped[0]?.metadata.scope).toBe("project");
		});
	});

	describe("service-level surfacing", () => {
		it("carries the trust-gate refusal into session diagnostics so no mode stays silent", async () => {
			writeProjectExtension("project-ext.ts");

			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: { projectTrusted: false },
				watchSettingsFile: false,
			});

			const warning = services.diagnostics.find((d) => d.type === "warning" && d.message.includes("not trusted"));
			expect(warning).toBeDefined();
			expect(warning?.message).toContain("project-ext.ts");
			expect(warning?.message).toContain("--approve");
		});
	});

	describe("DefaultResourceLoader trust resolution", () => {
		it("defaults to untrusted for an undecided directory (fail closed)", async () => {
			writeProjectExtension("project-ext.ts");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getLoadedExtensionPaths()).toEqual([]);
		});

		it("reads the saved trust decision from the agent dir store", async () => {
			const projectExtension = writeProjectExtension("project-ext.ts");
			new ProjectTrustStore(agentDir).set(cwd, true);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getLoadedExtensionPaths()).toContain(projectExtension);
		});

		it("honors an explicit untrusted flag over a saved trust decision", async () => {
			writeProjectExtension("project-ext.ts");
			new ProjectTrustStore(agentDir).set(cwd, true);

			const loader = new DefaultResourceLoader({ cwd, agentDir, projectTrusted: false });
			await loader.reload();

			expect(loader.getLoadedExtensionPaths()).toEqual([]);
		});

		it("surfaces a warning diagnostic when project extensions were skipped", async () => {
			writeProjectExtension("project-ext.ts");

			const loader = new DefaultResourceLoader({ cwd, agentDir, projectTrusted: false });
			await loader.reload();

			const diagnostics = loader.getProjectTrustDiagnostics();
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.type).toBe("warning");
			expect(diagnostics[0]?.message).toContain("not trusted");
			expect(diagnostics[0]?.message).toContain("project-ext.ts");
		});

		it("emits no trust diagnostic when nothing was skipped", async () => {
			writeUserExtension("user-ext.ts");

			const loader = new DefaultResourceLoader({ cwd, agentDir, projectTrusted: false });
			await loader.reload();

			expect(loader.getProjectTrustDiagnostics()).toEqual([]);
		});

		it("still loads project skills and prompts when untrusted (gate scope is extensions only)", async () => {
			const skillsDir = join(cwd, ".prime/agent/skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "project-skill.md"),
				"---\nname: project-skill\ndescription: A project skill\n---\nSkill content.\n",
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, projectTrusted: false });
			await loader.reload();

			const skillNames = loader.getSkills().skills.map((s) => s.name);
			expect(skillNames).toContain("project-skill");
		});
	});
});
