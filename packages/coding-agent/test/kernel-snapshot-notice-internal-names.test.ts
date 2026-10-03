/**
 * Kernel snapshot notices must not list the host's own internal names.
 *
 * Every healthy snapshot skips the same routine set: the `_prime_agent_*` helpers
 * the bootstrap re-binds on every kernel start, and the `_PrimeAgent*` skill wrapper
 * classes the host re-injects over a restore. Older payloads and manifests on disk
 * still carry those entries, so the model-visible notices
 * (`compactionKernelStateLines`, `restoreNoticeLines`) filter them at render time via
 * the existing routine-skip classification (`isExpectedSnapshotSkip`). A genuinely
 * lost user name must still be listed.
 */
import { describe, expect, it } from "vitest";
import { compactionKernelStateLines, restoreNoticeLines } from "../src/core/kernel/state-snapshot.js";

const PRIVATE_SKIP = "private-name convention: leading-underscore names are not persisted";

describe("snapshot notices filter routine internal names", () => {
	it("compaction notice omits internal skips but keeps real losses", () => {
		const lines = compactionKernelStateLines({
			snapshot: {
				saved: ["df"],
				skipped: [
					{ name: "_prime_agent_os", reason: PRIVATE_SKIP },
					{ name: "websearch", reason: "TypeError: cannot pickle '_PrimeAgentCallableSkillModule' object" },
					{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" },
				],
				bytes: 10,
				path: "/tmp/kernel-state.dill",
			},
			names: ["df"],
		});
		const text = lines.join("\n");
		expect(text).toContain("gen (TypeError: cannot pickle 'generator' object)");
		expect(text).not.toContain("_prime_agent_os");
		expect(text).not.toContain("websearch");
	});

	it("compaction notice drops the skipped line when every skip is routine", () => {
		const lines = compactionKernelStateLines({
			snapshot: {
				saved: ["df"],
				skipped: [
					{ name: "_prime_agent_os", reason: PRIVATE_SKIP },
					{ name: "websearch", reason: "TypeError: cannot pickle '_PrimeAgentCallableSkillModule' object" },
				],
				bytes: 10,
				path: "/tmp/kernel-state.dill",
			},
			names: ["df"],
		});
		expect(lines.join("\n")).not.toContain("could not be saved into the snapshot");
	});

	it("restore notice omits internal names from the never-saved line", () => {
		const lines = restoreNoticeLines({
			restored: ["kept"],
			failed: [],
			notSaved: [
				{ name: "_prime_agent_header_importlib", reason: PRIVATE_SKIP },
				{ name: "gen", reason: "TypeError: cannot pickle 'generator' object" },
			],
			path: "/tmp/kernel-state.dill",
		});
		const text = lines.join("\n");
		expect(text).toContain("never saved into it");
		expect(text).toContain("gen (TypeError: cannot pickle 'generator' object)");
		expect(text).not.toContain("_prime_agent_header_importlib");
	});

	it("restore notice drops the never-saved line when every unsaved name is routine", () => {
		const lines = restoreNoticeLines({
			restored: ["kept"],
			failed: [],
			notSaved: [{ name: "_prime_agent_rlm_module", reason: PRIVATE_SKIP }],
			path: "/tmp/kernel-state.dill",
		});
		expect(lines.join("\n")).not.toContain("never saved into it");
	});
});
