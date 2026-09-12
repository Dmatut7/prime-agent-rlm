import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadSkillsFromDir } from "../src/core/skills.js";
import {
	createDiscoveryWalk,
	enterDiscoveryDirectory,
	leaveDiscoveryDirectory,
	MAX_DISCOVERY_DEPTH,
} from "../src/utils/discovery-walk.js";

// Directory symlinks are the shape under test; creating them unprivileged is not a
// given on Windows.
const describeSymlinks = process.platform === "win32" ? describe.skip : describe;

const tempDirs: string[] = [];

afterEach(() => {
	setLogSink(undefined);
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDir(prefix = "discovery-walk-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function skillFile(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: ${name} discovery fixture\n---\n\nbody\n`);
	return path;
}

function nestedChain(root: string, depth: number): string {
	let dir = root;
	for (let level = 1; level <= depth; level++) {
		dir = join(dir, `deep${level}`);
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

describe("discovery walk bounds", () => {
	it("refuses a directory whose real identity is already on the branch", () => {
		const root = makeDir();
		mkdirSync(join(root, "a", "b"), { recursive: true });
		symlinkSync(root, join(root, "a", "loop"));

		const walk = createDiscoveryWalk();
		expect(enterDiscoveryDirectory(walk, root)).toBeUndefined();
		expect(enterDiscoveryDirectory(walk, join(root, "a"))).toBeUndefined();
		// One symlink hop resolves fine, so the kernel never reports ELOOP here: only the
		// walk's own bookkeeping can see that this is the root again.
		expect(enterDiscoveryDirectory(walk, join(root, "a", "loop"))).toBe("cycle");
		expect(enterDiscoveryDirectory(walk, join(root, "a", "loop", "a"))).toBe("cycle");
	});

	it("lets sibling branches share a real directory", () => {
		const root = makeDir();
		mkdirSync(join(root, "a"), { recursive: true });
		mkdirSync(join(root, "b"), { recursive: true });

		const walk = createDiscoveryWalk();
		expect(enterDiscoveryDirectory(walk, root)).toBeUndefined();
		expect(enterDiscoveryDirectory(walk, join(root, "a"))).toBeUndefined();
		leaveDiscoveryDirectory(walk);
		expect(enterDiscoveryDirectory(walk, join(root, "a"))).toBeUndefined();
		leaveDiscoveryDirectory(walk);
		expect(enterDiscoveryDirectory(walk, join(root, "b"))).toBeUndefined();
	});

	it("caps the branch depth", () => {
		const root = makeDir();
		const bottom = nestedChain(root, MAX_DISCOVERY_DEPTH + 5);
		const levels: string[] = [];
		let dir = bottom;
		while (dir !== root) {
			levels.unshift(dir);
			dir = join(dir, "..");
		}

		const walk = createDiscoveryWalk();
		expect(enterDiscoveryDirectory(walk, root)).toBeUndefined();
		for (let index = 0; index < MAX_DISCOVERY_DEPTH - 1; index++) {
			expect(enterDiscoveryDirectory(walk, levels[index]!)).toBeUndefined();
		}
		expect(enterDiscoveryDirectory(walk, levels[MAX_DISCOVERY_DEPTH - 1]!)).toBe("depth");
	});
});

describeSymlinks("skill discovery walk", () => {
	it("scans each real skill once when a symlink points back at an ancestor", () => {
		const root = makeDir("skills-cycle-");
		const realSkill = skillFile(join(root, "real"), "real");
		const nestedSkill = skillFile(join(root, "nested", "inner"), "inner");
		const external = makeDir("skills-external-");
		skillFile(join(external, "linked"), "linked");
		symlinkSync(external, join(root, "external-link"));
		symlinkSync(root, join(root, "loop"));
		// Discovery reports the path it walked, not the link target's realpath.
		const linkedSkill = join(root, "external-link", "linked", "SKILL.md");

		const result = loadSkillsFromDir({ dir: root, source: "path" });

		// Pre-fix the walk follows `loop` until the kernel refuses the path name, picking
		// up the same three skills once per level on the way down.
		expect(result.skills.map((skill) => skill.filePath).sort()).toEqual([linkedSkill, nestedSkill, realSkill].sort());
		const cycleDiagnostics = result.diagnostics.filter((entry) => entry.path === join(root, "loop"));
		expect(cycleDiagnostics).toHaveLength(1);
		expect(cycleDiagnostics[0]).toMatchObject({ type: "warning" });
		expect(String(cycleDiagnostics[0]?.message)).toMatch(/cycle/i);
	});

	it("stops at the depth cap, reports it, and keeps the shallow skills", () => {
		const root = makeDir("skills-depth-");
		const shallowSkill = skillFile(join(root, "shallow"), "shallow");
		const deepBottom = nestedChain(root, MAX_DISCOVERY_DEPTH + 8);
		skillFile(deepBottom, "too-deep");

		const result = loadSkillsFromDir({ dir: root, source: "path" });

		expect(result.skills.map((skill) => skill.filePath)).toEqual([shallowSkill]);
		const depthDiagnostics = result.diagnostics.filter((entry) => String(entry.message).match(/depth/i));
		expect(depthDiagnostics.length).toBeGreaterThan(0);
		expect(depthDiagnostics[0]?.path).toBe(
			join(root, ...Array.from({ length: MAX_DISCOVERY_DEPTH }, (_v, i) => `deep${i + 1}`)),
		);
	});

	it("still follows a legitimate symlinked skill directory", () => {
		const root = makeDir("skills-link-");
		const external = makeDir("skills-link-target-");
		skillFile(join(external, "linked"), "linked");
		symlinkSync(join(external, "linked"), join(root, "linked"));
		const linkedSkill = join(root, "linked", "SKILL.md");

		const result = loadSkillsFromDir({ dir: root, source: "path" });

		expect(result.skills.map((skill) => skill.filePath)).toEqual([linkedSkill]);
		expect(result.diagnostics).toEqual([]);
	});
});

describeSymlinks("package manager resource discovery walk", () => {
	function captureLogs(): LogEntry[] {
		const entries: LogEntry[] = [];
		setLogSink((entry) => {
			entries.push(entry);
		});
		return entries;
	}

	it("skips an ancestor symlink, says so, and still resolves the real skills", async () => {
		const workDir = makeDir("pm-cycle-");
		const agentDir = join(workDir, "agent");
		const skillsDir = join(agentDir, "skills");
		const realSkill = skillFile(join(skillsDir, "real"), "real");
		symlinkSync(skillsDir, join(skillsDir, "loop"));
		const logs = captureLogs();

		const packageManager = new DefaultPackageManager({
			cwd: workDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			bundledSkillsDir: null,
		});
		const resolved = await packageManager.resolve();

		expect(resolved.skills.some((resource) => resource.path === realSkill && resource.enabled)).toBe(true);
		const cycleLogs = logs.filter(
			(entry) => entry.component === "coding-agent.package-manager" && entry.reason === "cycle",
		);
		expect(cycleLogs.length).toBeGreaterThan(0);
		expect(String(cycleLogs[0]?.path)).toBe(join(skillsDir, "loop"));
	});

	it("does not resolve resources below the depth cap", async () => {
		const workDir = makeDir("pm-depth-");
		const agentDir = join(workDir, "agent");
		const skillsDir = join(agentDir, "skills");
		const shallowSkill = skillFile(join(skillsDir, "shallow"), "shallow");
		skillFile(nestedChain(skillsDir, MAX_DISCOVERY_DEPTH + 8), "too-deep");
		const logs = captureLogs();

		const packageManager = new DefaultPackageManager({
			cwd: workDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			bundledSkillsDir: null,
		});
		const resolved = await packageManager.resolve();

		expect(resolved.skills.some((resource) => resource.path === shallowSkill)).toBe(true);
		expect(
			resolved.skills.some((resource) => resource.path.endsWith("SKILL.md") && resource.path.includes("deep32")),
		).toBe(false);
		expect(
			logs.filter((entry) => entry.component === "coding-agent.package-manager" && entry.reason === "depth").length,
		).toBeGreaterThan(0);
	});
});
