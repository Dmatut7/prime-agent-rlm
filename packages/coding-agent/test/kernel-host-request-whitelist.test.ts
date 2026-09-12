import { describe, expect, it } from "vitest";
import { CANCELLABLE_KERNEL_HOST_REQUEST_TYPES } from "../src/core/agent-session.js";
import { hostRequestTypeIsCancellable } from "../src/core/kernel/index.js";

/**
 * The whitelist is the single decision that keeps "Esc on the spawning cell" from killing work the
 * model was promised would outlive the turn. A wrong entry is not a bug, it is lost work, so the
 * classification is pinned from both directions here.
 */
describe("cancellable kernel host request whitelist (P1-2a)", () => {
	const cancellable = (type: string): boolean =>
		hostRequestTypeIsCancellable(CANCELLABLE_KERNEL_HOST_REQUEST_TYPES, type);

	it("is not empty, so the mechanism is actually armed", () => {
		expect(CANCELLABLE_KERNEL_HOST_REQUEST_TYPES.length).toBeGreaterThan(0);
	});

	it("declares the read-only types cancellable", () => {
		const readOnly = [
			"rlm.find_models",
			"rlm.list_subagents",
			"rlm.collect", // bounded read-only wait; cancelling it cancels no child
			"model.info",
			"agent_message.list_agents",
			"agent_observe.list",
			"agent_observe.get",
			"agent_observe.recent",
		];
		expect(readOnly.length).toBeGreaterThan(0);
		for (const type of readOnly) {
			expect(cancellable(type), type).toBe(true);
		}
	});

	it("keeps every side-effecting type on the teardown-only signal", () => {
		const sideEffecting = [
			"rlm.run", // admits a child that must outlive the turn (M7)
			"rlm.delete_subagent", // deletes a child and its artifacts
			"agent_message.send", // delivers a message the recipient may act on
			"goal.create",
			"goal.complete",
			"compact.run",
			"refine.run",
			"rlm_heartbeat.create",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
			"mcp.some_server.some_tool", // unknown to the host, so never declared read-only
		];
		expect(sideEffecting.length).toBeGreaterThan(0);
		for (const type of sideEffecting) {
			expect(cancellable(type), type).toBe(false);
		}
	});

	it("does not smuggle in a wildcard that would cancel everything", () => {
		for (const pattern of CANCELLABLE_KERNEL_HOST_REQUEST_TYPES) {
			expect(pattern === "*", pattern).toBe(false);
			if (!pattern.endsWith("*")) continue;
			// A prefix pattern has to name a family, not the empty prefix.
			expect(pattern.length).toBeGreaterThan(1);
			expect(cancellable("rlm.run"), pattern).toBe(false);
			expect(cancellable("agent_message.send"), pattern).toBe(false);
		}
	});
});
