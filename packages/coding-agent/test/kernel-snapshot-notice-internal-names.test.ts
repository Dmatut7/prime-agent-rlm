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
	it("a user's own underscore name is reported, not filtered as routine", () => {
		// W8 1.9: the runtime reports user-bound leading-underscore names with the
		// same "private-name convention" reason the internals used to carry, so a
		// reason-string filter hid them from every notice. The filter must classify
		// by name (bootstrap prefixes, dunders), so a user's `_cache` stays visible.
		const lines = compactionKernelStateLines({
			snapshot: {
				saved: ["df"],
				skipped: [{ name: "_cache", reason: PRIVATE_SKIP }],
				bytes: 10,
				path: "/tmp/kernel-state.dill",
			},
			names: ["df"],
		});
		const text = lines.join("\n");
		expect(text).toContain("_cache");
		expect(text).toContain("private-name convention");

		const restoreLines = restoreNoticeLines({
			restored: ["kept"],
			failed: [],
			notSaved: [{ name: "_cache", reason: PRIVATE_SKIP }],
			path: "/tmp/kernel-state.dill",
		});
		expect(restoreLines.join("\n")).toContain("_cache");
	});

	it("a user alias of a host wrapper is reported, not filtered as routine", () => {
		// Section-9 item 12 / backlog 79: the model binds `helper = websearch` in a
		// cell; the snapshot cannot pickle either binding, so both drops carry the
		// same "cannot pickle '_PrimeAgentCallableSkillModule'" reason. The
		// bootstrap re-injects only the skill import names, so `helper` is a real
		// loss the notice must report - classifying by the drop reason hid it.
		const wrapperReason = "TypeError: cannot pickle '_PrimeAgentCallableSkillModule' object";
		const lines = compactionKernelStateLines({
			snapshot: {
				saved: ["df"],
				skipped: [
					{ name: "websearch", reason: wrapperReason },
					{ name: "helper", reason: wrapperReason },
				],
				bytes: 10,
				path: "/tmp/kernel-state.dill",
			},
			names: ["df"],
			reboundNames: new Set(["websearch"]),
		});
		const text = lines.join("\n");
		expect(text).toContain("helper");
		expect(text).toContain(wrapperReason);
		expect(text).not.toContain("websearch (");

		const restoreLines = restoreNoticeLines(
			{
				restored: ["kept"],
				failed: [],
				notSaved: [
					{ name: "websearch", reason: wrapperReason },
					{ name: "helper", reason: wrapperReason },
				],
				path: "/tmp/kernel-state.dill",
			},
			new Set(["websearch"]),
		);
		const restoreText = restoreLines.join("\n");
		expect(restoreText).toContain("helper");
		expect(restoreText).toContain(wrapperReason);
		expect(restoreText).not.toMatch(/websearch \(/);
	});

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
			reboundNames: new Set(["websearch"]),
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
			reboundNames: new Set(["websearch"]),
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
