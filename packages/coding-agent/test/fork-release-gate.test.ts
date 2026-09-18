import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FORK_MARKER_FILE as CODING_AGENT_FORK_MARKER_FILE } from "../src/fork-self-update.js";

/**
 * Release gate for the fork checkout (scripts/lib/fork-gate.mjs) and the marker it shares
 * with the fork self-update gate.
 *
 * That module is plain ESM run by bare `node` (from scripts/release.mjs and the pre-push
 * self-test), so it ships no type declarations and tsgo cannot resolve a literal import of
 * it. The specifier is built at runtime and the module's shape is declared below, which
 * keeps the pin on the *real* module (vitest imports and evaluates it) instead of on a copy
 * of its source text.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GATE_MODULE_URL = new URL("../../../scripts/lib/fork-gate.mjs", import.meta.url).href;

interface ForkCheckoutDetection {
	isForkCheckout: boolean;
	repoRoot: string | null;
	scanError: string | null;
}

interface ReleaseGateOptions {
	startDir?: string;
	env?: Record<string, string | undefined>;
	warn?: (line: string) => void;
	exists?: (path: string) => boolean;
}

interface ReleaseGateModule {
	FORK_MARKER_FILE: string;
	RELEASE_GATE_ENV_VAR: string;
	ReleaseGateRefusal: new (lines: string[]) => Error & { lines: string[]; exitCode: number };
	detectForkCheckout: (startDir?: string, options?: { exists?: (path: string) => boolean }) => ForkCheckoutDetection;
	assertReleaseAllowed: (options?: ReleaseGateOptions) => ForkCheckoutDetection;
	releaseGateRefusalLines: (detection: ForkCheckoutDetection, options?: { anchors?: string[] }) => string[];
	releaseBanAnchors: (startDir?: string) => string[];
}

const gate = (await import(GATE_MODULE_URL)) as ReleaseGateModule;

describe("fork release gate", () => {
	let forkRoot = "";
	let nestedDir = "";
	let plainRoot = "";

	beforeAll(() => {
		forkRoot = mkdtempSync(join(tmpdir(), "release-gate-fork-"));
		nestedDir = join(forkRoot, "packages", "coding-agent", "scripts", "lib");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(forkRoot, CODING_AGENT_FORK_MARKER_FILE), "# fork notes\n");
		plainRoot = mkdtempSync(join(tmpdir(), "release-gate-plain-"));
	});

	afterAll(() => {
		rmSync(forkRoot, { recursive: true, force: true });
		rmSync(plainRoot, { recursive: true, force: true });
	});

	it("pins the gate's marker to the one the self-update gate uses", () => {
		// Two gates decide "is this a fork checkout?" from a marker file. If the two
		// constants ever diverge, one of them silently stops firing.
		expect(gate.FORK_MARKER_FILE).toBe(CODING_AGENT_FORK_MARKER_FILE);
		expect(gate.FORK_MARKER_FILE).toBe("FORK_NOTES.md");
	});

	it("pins the escape hatch name", () => {
		expect(gate.RELEASE_GATE_ENV_VAR).toBe("PRIME_AGENT_ALLOW_RELEASE");
	});

	it("does not fire for a checkout that is not a fork", () => {
		const warned: string[] = [];
		const detection = gate.assertReleaseAllowed({ startDir: plainRoot, env: {}, warn: (line) => warned.push(line) });
		expect(detection.isForkCheckout).toBe(false);
		// An official checkout must stay silent: this gate is not about its release surface.
		expect(warned).toEqual([]);
	});

	it("refuses a release from a fork checkout and names the ban", () => {
		let refusal: (Error & { lines: string[]; exitCode: number }) | undefined;
		try {
			gate.assertReleaseAllowed({ startDir: nestedDir, env: {}, warn: () => {} });
		} catch (error) {
			refusal = error as Error & { lines: string[]; exitCode: number };
		}
		expect(refusal).toBeInstanceOf(gate.ReleaseGateRefusal);
		expect(refusal?.exitCode).toBe(2);
		const text = refusal?.lines.join("\n") ?? "";
		expect(text).toContain("v*");
		expect(text).toContain("npm publish");
		expect(text).toContain(`${gate.RELEASE_GATE_ENV_VAR}=1`);
		expect(text).toContain("CHANGELOG.md:");
		expect(text).toContain("merge-upstream-20260917.md:");
		expect(text).toContain("build-binaries.yml");
		// The refusal names the checkout it refused, resolved from the nested start dir.
		expect(text).toContain(forkRoot);
	});

	it("lifts the ban only for the literal 1, and says so", () => {
		for (const value of ["", "0", "true", "yes", "1 "]) {
			expect(() =>
				gate.assertReleaseAllowed({ startDir: nestedDir, env: { [gate.RELEASE_GATE_ENV_VAR]: value } }),
			).toThrow(gate.ReleaseGateRefusal);
		}
		const warned: string[] = [];
		const detection = gate.assertReleaseAllowed({
			startDir: nestedDir,
			env: { [gate.RELEASE_GATE_ENV_VAR]: "1" },
			warn: (line) => warned.push(line),
		});
		expect(detection.isForkCheckout).toBe(true);
		// The override is never silent: a leaked variable has to leave a trace.
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(gate.RELEASE_GATE_ENV_VAR);
		expect(warned[0]).toContain("warning:");
	});

	it("fails closed when the marker walk itself fails", () => {
		const exists = () => {
			throw new Error("EIO injected");
		};
		const detection = gate.detectForkCheckout("/", { exists });
		expect(detection.isForkCheckout).toBe(true);
		expect(detection.scanError).toContain("EIO injected");
		let refusal: (Error & { lines: string[] }) | undefined;
		try {
			gate.assertReleaseAllowed({ startDir: "/", env: {}, exists, warn: () => {} });
		} catch (error) {
			refusal = error as Error & { lines: string[] };
		}
		expect(refusal).toBeInstanceOf(gate.ReleaseGateRefusal);
		expect(refusal?.lines.join("\n")).toContain("marker walk failed");
	});

	it("resolves the ban anchors from the lines that state the ban", () => {
		const anchors = gate.releaseBanAnchors(REPO_ROOT);
		expect(anchors.some((anchor) => anchor.startsWith("CHANGELOG.md:"))).toBe(true);
		expect(anchors.some((anchor) => anchor.startsWith("docs/fork/merge-upstream-20260917.md:"))).toBe(true);
		for (const anchor of anchors) {
			const match = /^(.*):(\d+)$/.exec(anchor);
			expect(match, `${anchor} must be file:line`).not.toBeNull();
			const [, file, line] = match as RegExpExecArray;
			const cited = readFileSync(join(REPO_ROOT, file), "utf-8").split("\n")[Number(line) - 1] ?? "";
			expect(/禁推|禁止在 origin 推/.test(cited), `${anchor} no longer states the ban: ${cited}`).toBe(true);
		}
	});

	it("detects the checkout this test run itself comes from", () => {
		// Positive control: the argument-less call reads the module's own location, which in
		// this repository is a fork checkout. Without this the cases above could pass against
		// a detector the release path never uses.
		const detection = gate.detectForkCheckout();
		expect(detection.isForkCheckout).toBe(true);
		// realpath on both sides: the marker walk resolves lexically, a module URL may be the
		// real path already (/tmp -> /private/tmp on this platform).
		expect(realpathSync(detection.repoRoot ?? "")).toBe(realpathSync(REPO_ROOT));
	});
});
