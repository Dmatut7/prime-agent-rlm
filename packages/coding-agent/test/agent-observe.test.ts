import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	type AgentFamilyRosterResult,
	buildAgentFamilyRosterFromDirectory,
	createAgentMessageHostHandlers,
	selectAgentFamilyDirectory,
} from "../src/core/agent-messages.js";
import {
	AGENT_OBSERVE_PREVIEW_MAX_CHARS,
	type AgentObserveAgentSummary,
	type AgentObserveListResult,
	createAgentObserveFamilyList,
	createAgentObserveHostHandlers,
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../src/core/agent-observe.js";

describe("agent observe helpers", () => {
	it("creates bounded text previews", () => {
		const preview = createAgentObserveMessagePreview(
			{
				role: "user",
				content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
				timestamp: 123,
			},
			4,
			8,
		);

		expect(preview).toEqual({
			index: 4,
			role: "user",
			timestamp: 123,
			text: "abcdefgh",
			truncated: true,
		});
	});

	it("includes assistant tool call names without exposing arguments", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxToolCall("bash", { command: "secret" }), { stopReason: "toolUse" }),
			2,
			200,
		);

		expect(preview.text).toBe("[tool_call:bash]");
		expect(preview.toolCalls).toEqual(["bash"]);
		expect(preview.text).not.toContain("secret");
	});

	it("includes assistant thinking text in previews", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxThinking("working through the plan")),
			1,
			200,
		);

		expect(preview.text).toBe("working through the plan");
		expect(preview.truncated).toBe(false);
	});

	it("validates bounds", () => {
		expect(normalizeObserveLimit(undefined)).toBe(8);
		expect(normalizeObserveLimit(50)).toBe(50);
		expect(() => normalizeObserveLimit(0)).toThrow("between 1 and 50");
		expect(normalizeObserveMaxChars(undefined)).toBe(800);
		expect(normalizeObserveMaxChars(80)).toBe(80);
		expect(() => normalizeObserveMaxChars(2_001)).toThrow("between 80 and 2000");
	});
});

describe("one family directory, two entries", () => {
	// The catalog `send` resolves targets against: this agent's parent, a live child, a
	// sibling that exists only on disk, a peer live in another worker, and a cousin that is
	// outside the nuclear family.
	const rootEntry: AgentFamilyCatalogEntry = {
		id: "session-root",
		name: "Root",
		depth: 0,
		status: "running",
		sessionPath: "/tmp/root.jsonl",
		cwd: "/tmp/root",
	};
	const liveChildEntry: AgentFamilyCatalogEntry = {
		id: "session-child",
		name: "Child",
		depth: 1,
		status: "running",
		parentSessionId: "session-root",
		parentSessionPath: "/tmp/root.jsonl",
		sessionPath: "/tmp/child.jsonl",
		cwd: "/tmp/child",
		rlmChildId: "child-1",
		repliedSinceTask: true,
	};
	const archivedSiblingEntry: AgentFamilyCatalogEntry = {
		id: "session-archived",
		name: "archivist",
		depth: 0,
		status: "inactive",
		sessionPath: "/tmp/archivist.jsonl",
		cwd: "/tmp/archivist",
		messageCount: 3,
		firstMessage: "x".repeat(1_000),
	};
	const peerSiblingEntry: AgentFamilyCatalogEntry = {
		id: "session-peer",
		name: "peer",
		depth: 0,
		status: "running",
		sessionPath: "/tmp/peer.jsonl",
		cwd: "/tmp/peer",
		activeSessionId: "remote-active",
	};
	const cousinEntry: AgentFamilyCatalogEntry = {
		id: "session-cousin",
		name: "cousin",
		depth: 2,
		status: "idle",
		parentSessionId: "session-other",
		parentSessionPath: "/tmp/other.jsonl",
		sessionPath: "/tmp/cousin.jsonl",
	};
	const catalog = [rootEntry, liveChildEntry, archivedSiblingEntry, peerSiblingEntry, cousinEntry];

	const currentSummary: AgentObserveAgentSummary = {
		activeSessionId: "active-root",
		sessionId: "session-root",
		sessionName: "Root",
		runtimeKind: "top-level",
		cwd: "/tmp/root",
		status: "idle",
		isCurrent: true,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 7,
		queuedCount: 0,
		isSessionActive: false,
	};
	const liveChildSummary: AgentObserveAgentSummary = {
		activeSessionId: "active-child",
		sessionId: "session-child",
		sessionName: "Child",
		runtimeKind: "subagent",
		cwd: "/tmp/child",
		status: "busy",
		isCurrent: false,
		isStreaming: true,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 5,
		queuedCount: 0,
		isSessionActive: true,
		latestMessage: { index: 4, role: "assistant", text: "working", truncated: false },
	};

	async function listFromBothEntries() {
		const directory = selectAgentFamilyDirectory(rootEntry, catalog);
		const observeHandlers = createAgentObserveHostHandlers({
			listAgents: () =>
				createAgentObserveFamilyList({
					current: currentSummary,
					directory,
					// Only the live child is resident in this daemon.
					liveSummary: (member) => (member.entry.id === liveChildSummary.sessionId ? liveChildSummary : undefined),
				}),
			getAgent: () => {
				throw new Error("agent_observe.get is not exercised");
			},
			recentMessages: () => {
				throw new Error("agent_observe.recent is not exercised");
			},
		});
		const messageHandlers = createAgentMessageHostHandlers({
			roster: async () => buildAgentFamilyRosterFromDirectory(directory),
			sendAgentMessage: async () => {
				throw new Error("agent_message.send is not exercised");
			},
		});
		return {
			directory,
			observed: (await observeHandlers["agent_observe.list"]!()) as unknown as AgentObserveListResult,
			roster: (await messageHandlers["agent_message.list_agents"]!({})) as unknown as AgentFamilyRosterResult,
		};
	}

	it("selects the family directory from the catalog, once", async () => {
		const { directory } = await listFromBothEntries();
		// Positive control with an explicit expected set: the two sibling roots ordered by
		// name, then the child. A non-family cousin at the same depth as a child of a
		// sibling stays out, so this is not "whatever the catalog holds".
		expect(directory.members.map((member) => [member.relationship, member.entry.id])).toEqual([
			["sibling", "session-archived"],
			["sibling", "session-peer"],
			["child", "session-child"],
		]);
		expect(directory.current).toEqual({ name: "Root", id: "session-root", depth: 0 });
		expect(catalog.map((entry) => entry.id)).toContain("session-cousin");
		expect(directory.members.map((member) => member.entry.id)).not.toContain("session-cousin");
	});

	it("returns the same members from agent_observe.list and agent_message.list_agents", async () => {
		const { observed, roster } = await listFromBothEntries();
		// Membership identity and relationship: the legacy roster row and the observe row for
		// the same member must name the same agent in the same family position.
		expect(roster.entries).toHaveLength(3);
		expect(observed.agents.map((agent) => [agent.relationship, agent.sessionName, agent.sessionId])).toEqual(
			roster.entries.map((entry) => [entry.relationship, entry.name, entry.id]),
		);
		// Status granularity is deliberately different: the roster carries the coarse family
		// status (running/idle/inactive) that reachability is decided on, while the observe row
		// carries the live runtime status of a resident session. A member with no live session
		// here reads inactive in both.
		expect(roster.entries.map((entry) => entry.status)).toEqual(["inactive", "running", "running"]);
		expect(observed.agents.map((agent) => [agent.status, agent.isSessionActive])).toEqual([
			["inactive", false],
			["running", true],
			["busy", true],
		]);
		// Self is not its own family member; both entries report it as the current agent.
		expect(observed.agents.map((agent) => agent.sessionId)).not.toContain("session-root");
		// Both entries report the same current agent, each in its own field names.
		expect(observed.current).toMatchObject({
			sessionId: roster.current.id,
			sessionName: roster.current.name,
			isCurrent: true,
		});
		expect(roster.entries.map((entry) => entry.depth)).toEqual([0, 0, 1]);
	});

	it("reports a member with no live session from persisted facts only", async () => {
		const { observed } = await listFromBothEntries();
		const archived = observed.agents.find((agent) => agent.sessionId === "session-archived");
		// The row an agent could previously only see through agent_message: it is now in the
		// observe list too, marked inactive and without a live session id.
		expect(archived).toMatchObject({
			relationship: "sibling",
			sessionName: "archivist",
			runtimeKind: "top-level",
			cwd: "/tmp/archivist",
			status: "inactive",
			isSessionActive: false,
			messageCount: 3,
		});
		expect(archived).not.toHaveProperty("activeSessionId");
		expect(archived).not.toHaveProperty("latestMessage");
		// A saved session's opening prompt is capped, so one roster reply cannot carry it whole.
		expect(archived?.firstMessage).toHaveLength(AGENT_OBSERVE_PREVIEW_MAX_CHARS);
		expect(archived?.firstMessage).not.toBe(catalog[2]!.firstMessage);
	});

	it("keeps live detail and the peer's active session id where the catalog has them", async () => {
		const { observed } = await listFromBothEntries();
		const live = observed.agents.find((agent) => agent.sessionId === "session-child");
		expect(live).toMatchObject({
			activeSessionId: "active-child",
			relationship: "child",
			status: "busy",
			isStreaming: true,
			messageCount: 5,
			repliedSinceTask: true,
		});
		expect(live?.latestMessage).toMatchObject({ text: "working" });
		const peer = observed.agents.find((agent) => agent.sessionId === "session-peer");
		// A peer live in another worker is live: only its active id is known, never its detail.
		expect(peer).toMatchObject({ activeSessionId: "remote-active", relationship: "sibling", status: "running" });
		expect(peer).not.toHaveProperty("latestMessage");
	});
});
