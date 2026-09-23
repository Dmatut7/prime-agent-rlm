import { describe, expect, it, vi } from "vitest";
import type { QueuedMessageMutation } from "../src/core/session-action-store.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import type { DaemonTransportClient } from "../src/modes/daemon/daemon-client.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type QueueState = { steering: string[]; followUp: string[] };

type Harness = {
	queueSelection: QueueSelection;
	connectionState: {
		sessionActions: {
			queuedCount: number;
			steering: readonly string[];
			followUps: readonly string[];
		};
	};
	editor: { getText: () => string; setText: (text: string) => void; addToHistory?: (text: string) => void };
	isApplyingQueueSelectionText: boolean;
	pastedImages: Map<number, unknown>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	agentConnection: {
		mutateQueuedMessage: ReturnType<typeof vi.fn>;
		abort?: ReturnType<typeof vi.fn>;
	};
	sessionEventGeneration: number;
	sessionEventQueue: Promise<void>;
	inputSubmissionGeneration: number;
	pendingQueueEdit: symbol | undefined;
	pendingQueueMove: boolean;
	queueMutationChain: Promise<void>;
	enqueueQueueMutation: <T>(run: () => Promise<T>) => Promise<T>;
	applyQueueSelection: (text: string, targetLane: "steering" | "followUp") => Promise<boolean>;
	browseQueueSelection: (direction: -1 | 1) => void;
	moveQueueSelection: (direction: -1 | 1) => void;
	getConnectionQueue: () => QueueState;
	refreshQueueSelectionAt: (
		queue: QueueState,
		selected: { lane: "steering" | "followUp"; index: number; text: string },
		index: number,
	) => void;
	refreshQueueSelectionFromState: () => void;
	updateConnectionStateFromEvent: (event: AgentConnectionSessionEvent) => void;
	patchConnectionState: (patch: Partial<Harness["connectionState"]>) => void;
	setEditorTextFromQueueSelection: (text: string) => void;
	collectQueueReplaceImages: (text: string) => unknown;
};

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function createHarness(queue: { steering: string[]; followUp: string[] }, mutateResult = "applied"): Harness {
	let editorText = "";
	const harness = {
		queueSelection: new QueueSelection(),
		connectionState: {
			sessionActions: {
				queuedCount: queue.steering.length + queue.followUp.length,
				steering: queue.steering,
				followUps: queue.followUp,
			},
		},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
			addToHistory: vi.fn(),
		},
		isApplyingQueueSelectionText: false,
		pastedImages: new Map(),
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		agentConnection: {
			mutateQueuedMessage: vi.fn(async () => mutateResult),
			abort: vi.fn(async () => {}),
		},
		sessionEventGeneration: 0,
		sessionEventQueue: Promise.resolve(),
		inputSubmissionGeneration: 0,
		pendingQueueEdit: undefined,
		pendingQueueMove: false,
		queueMutationChain: Promise.resolve(),
		enqueueQueueMutation: proto.enqueueQueueMutation,
		applyQueueSelection: proto.applyQueueSelection,
		browseQueueSelection: proto.browseQueueSelection,
		moveQueueSelection: proto.moveQueueSelection,
		getConnectionQueue: proto.getConnectionQueue,
		refreshQueueSelectionAt: proto.refreshQueueSelectionAt,
		refreshQueueSelectionFromState: proto.refreshQueueSelectionFromState,
		updateConnectionStateFromEvent: proto.updateConnectionStateFromEvent,
		patchConnectionState: () => {},
		setEditorTextFromQueueSelection: proto.setEditorTextFromQueueSelection,
		collectQueueReplaceImages: proto.collectQueueReplaceImages,
	} as unknown as Harness;
	harness.patchConnectionState = (patch) => {
		harness.connectionState = { ...harness.connectionState, ...patch };
	};
	return harness;
}

function setQueue(harness: Harness, queue: QueueState): void {
	harness.connectionState.sessionActions = {
		...harness.connectionState.sessionActions,
		queuedCount: queue.steering.length + queue.followUp.length,
		steering: queue.steering,
		followUps: queue.followUp,
	};
}

function emitQueueUpdate(harness: Harness, queue: QueueState): void {
	harness.updateConnectionStateFromEvent({
		type: "session_action_update",
		actions: {
			queuedCount: queue.steering.length + queue.followUp.length,
			steering: queue.steering,
			followUps: queue.followUp,
		},
	});
}

describe("interactive queued-message editing", () => {
	it("browses into the queue and applies an enter edit as steering", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: ["f1"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("f1");

		const consumed = await harness.applyQueueSelection("f1 edited", "steering");
		expect(consumed).toBe(true);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "f1", {
			type: "replace",
			text: "f1 edited",
			images: [],
			lane: "steering",
		});
		expect(harness.editor.getText()).toBe("draft"); // draft restored after apply
		expect(harness.editor.addToHistory).toHaveBeenCalledWith("f1 edited");
	});

	it("applies an alt+enter edit to the follow-up lane and deletes on empty text", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("kept follow-up", "followUp");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("steering", 0, "s1", {
			type: "replace",
			text: "kept follow-up",
			images: [],
			lane: "followUp",
		});

		setQueue(harness, { steering: ["s1"], followUp: [] });
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("   ", "steering");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenLastCalledWith("steering", 0, "s1", {
			type: "delete",
		});
	});

	it("restores the edited text when the mutation is rejected after enter cleared the editor", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] }, "rejected");
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Editor.submitValue clears before onSubmit runs.
		await harness.applyQueueSelection("s1 edited", "steering");
		expect(harness.editor.getText()).toBe("s1 edited");
		expect(harness.showStatus).toHaveBeenCalledWith("排队消息已变化，修改保留在输入框里");
	});

	it("reports when the daemon does not support queue editing", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] }, "unsupported");
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("s1 edited", "steering");
		expect(harness.showStatus).toHaveBeenCalledWith("修改排队消息需要更新后台服务");
	});

	it("does not consume submissions when nothing is selected", async () => {
		const harness = createHarness({ steering: [], followUp: [] });
		expect(await harness.applyQueueSelection("new prompt", "steering")).toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("moves the selected item within its lane", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() =>
			expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("steering", 1, "s2", {
				type: "move",
				direction: -1,
			}),
		);
	});

	it("does not clobber typing that happened while the mutation was in flight", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Enter cleared the editor
		const pending = harness.applyQueueSelection("s1 edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());
		harness.editor.setText("newer typing");
		resolveMutation("rejected");
		await pending;
		expect(harness.editor.getText()).toBe("newer typing");
	});

	it.each([
		["replace", "queued edited"],
		["delete", "   "],
	])("restores the stashed draft when a %s queue event lands before the response", async (_operation, text) => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection(text, "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		setQueue(harness, {
			steering: text.trim() ? [text.trim()] : [],
			followUp: [],
		});
		resolveMutation("applied");
		await pending;

		expect(harness.editor.getText()).toBe("draft");
	});

	it("routes another submission as new while a queue edit is pending", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("edited", "steering");
		expect(harness.queueSelection.isBrowsing).toBe(true);
		await expect(harness.applyQueueSelection("new prompt", "steering")).resolves.toBe(false);
		harness.inputSubmissionGeneration++;
		harness.editor.setText("");
		resolveMutation("applied");
		await pending;
		expect(harness.editor.getText()).toBe("");
	});

	it.each(["rejected", "invalid", "unsupported"])(
		"keeps the selection and stashed draft when a queue edit is %s",
		async (status) => {
			const harness = createHarness({ steering: ["queued"], followUp: [] }, status);
			harness.editor.setText("draft");
			harness.browseQueueSelection(-1);
			harness.editor.setText("");

			await harness.applyQueueSelection("edited", "steering");

			expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
			expect(harness.queueSelection.hasDraft).toBe(true);
			expect(harness.editor.getText()).toBe("edited");
		},
	);

	it("keeps the selection and stashed draft when a queue edit request fails", async () => {
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockRejectedValue(new Error("connection lost"));
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");

		await expect(harness.applyQueueSelection("edited", "steering")).rejects.toThrow("connection lost");

		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
		expect(harness.queueSelection.hasDraft).toBe(true);
		expect(harness.editor.getText()).toBe("edited");
	});

	it("does not reset queue browsing in a replacement session when an old mutation completes", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["old queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("old draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Enter cleared the old session's editor.
		const pending = harness.applyQueueSelection("old edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());

		// A session replacement resets queue state, then the user starts browsing
		// the replacement session before the old daemon response arrives.
		harness.sessionEventGeneration++;
		harness.pendingQueueEdit = undefined;
		harness.queueSelection.reset();
		setQueue(harness, { steering: ["new queued"], followUp: [] });
		harness.editor.setText("new draft");
		harness.browseQueueSelection(-1);

		resolveMutation("applied");
		await pending;
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "new queued" });
		expect(harness.editor.getText()).toBe("new queued");
	});

	it("discards an old queue selection when the session changes before its mutation completes", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["old queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("old edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		// session_replaced advances the generation before its queued render reset.
		harness.sessionEventGeneration++;
		resolveMutation("applied");
		await pending;

		expect(harness.pendingQueueEdit).toBeUndefined();
		expect(harness.queueSelection.isBrowsing).toBe(false);
		await expect(harness.applyQueueSelection("new session prompt", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
	});

	it("exits browsing when an external event removes the selected item", async () => {
		const harness = createHarness({ steering: [], followUp: ["queued"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);

		emitQueueUpdate(harness, { steering: [], followUp: [] });

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
		await expect(harness.applyQueueSelection("draft", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("refreshes browse navigation from external queue events", () => {
		const harness = createHarness({ steering: ["s1"], followUp: ["f1", "f2"] });
		harness.browseQueueSelection(-1);

		emitQueueUpdate(harness, { steering: ["s1"], followUp: ["f0", "f2", "f3"] });
		harness.browseQueueSelection(-1);

		expect(harness.editor.getText()).toBe("f0");
	});

	it("refreshes selection from event-driven queue state after a move", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s2", "s1"], followUp: [] });
			return "applied";
		});
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.getConnectionQueue()).toEqual({ steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
	});

	it("leaves browse mode when the moved tuple is absent from the event snapshot", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "applied";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("refreshes selection after a failed move suppresses an external event", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] }, "rejected");
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "rejected";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("keeps a chained edit when the preceding move loses its selection", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "applied";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		harness.editor.setText("");
		await harness.applyQueueSelection("s2 edited", "steering");

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
		expect(harness.editor.getText()).toBe("s2 edited");
		expect(harness.showStatus).toHaveBeenCalledWith("排队消息已变化，修改保留在输入框里");
	});

	it("uses canonical post-move positions for consecutive moves and an edit", async () => {
		const queue = ["s1", "s2", "s3"];
		const harness = createHarness({ steering: queue, followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			async (
				_lane: "steering" | "followUp",
				index: number,
				expectedText: string,
				mutation: QueuedMessageMutation,
			) => {
				const item = queue[index];
				if (item !== expectedText) return "rejected";
				if (mutation.type === "move") {
					const target = index + mutation.direction;
					const neighbor = queue[target];
					if (neighbor === undefined) return "rejected";
					queue[index] = neighbor;
					queue[target] = item;
				} else if (mutation.type === "replace") {
					queue[index] = mutation.text;
				}
				emitQueueUpdate(harness, { steering: [...queue], followUp: [] });
				return "applied";
			},
		);
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		harness.moveQueueSelection(-1);
		const edited = harness.applyQueueSelection("s3 edited", "steering");
		await edited;

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(1, "steering", 2, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(2, "steering", 1, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(3, "steering", 0, "s3", {
			type: "replace",
			text: "s3 edited",
			images: [],
			lane: "steering",
		});
		expect(harness.getConnectionQueue()).toEqual({ steering: ["s3 edited", "s1", "s2"], followUp: [] });
	});

	it("keeps the selected index when duplicate text shifts before an edit", async () => {
		let releaseMutationChain: () => void = () => {};
		const harness = createHarness({ steering: [], followUp: ["dup", "dup"] }, "rejected");
		harness.queueMutationChain = new Promise<void>((resolve) => {
			releaseMutationChain = resolve;
		});
		harness.browseQueueSelection(-1);
		const pending = harness.applyQueueSelection("edited", "followUp");
		setQueue(harness, { steering: [], followUp: ["dup"] });
		releaseMutationChain();
		await pending;

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 1, "dup", {
			type: "replace",
			text: "edited",
			images: [],
			lane: "followUp",
		});
	});

	it("ignores browse keys while a queue move is pending", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("s2");

		resolveMutation("applied");
		await harness.queueMutationChain;
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
	});

	it("keeps the moved selection when the queue event lands after the response", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.getConnectionQueue()).toEqual({ steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });

		emitQueueUpdate(harness, { steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
		expect(harness.editor.getText()).toBe("s2");
	});

	it("drops a stale selection after a rejected edit so enter returns to normal submission", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		// The item is consumed while the edit is pending; event reconciliation is suppressed.
		emitQueueUpdate(harness, { steering: [], followUp: [] });
		resolveMutation("rejected");
		await pending;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("edited");
		await expect(harness.applyQueueSelection("edited", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
	});

	it("drops a stale selection when a move request fails after the item was consumed", async () => {
		let rejectMutation: (error: Error) => void = () => {};
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectMutation = reject;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
		rejectMutation(new Error("connection lost"));
		await vi.waitFor(() => expect(harness.showError).toHaveBeenCalledWith("connection lost"));

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("deduplicates repeated image markers in a replace", () => {
		const harness = createHarness({ steering: [], followUp: [] });
		harness.pastedImages.set(1, { type: "image", data: "a", mimeType: "image/png" });
		expect(harness.collectQueueReplaceImages("[image #1] and again [image #1]")).toEqual([
			{ type: "image", data: "a", mimeType: "image/png" },
		]);
	});
});

describe("interactive interrupt sends the queued messages", () => {
	/**
	 * This describe replaced a pin on the pre-#2426 behaviour ("aborts without clearing or
	 * restoring queued messages", harness offering `abort` only). Upstream e2fb7bfa1 changed the
	 * Esc call site and that pin in the same commit; the merge took the src half of every other
	 * file in it and resolved this hunk back to `abort()`, which left `abort_and_send_queued`
	 * with zero producers in the shipping path while CHANGELOG.md 0.10.0 advertised it (final-review seat B,
	 * B3-01/B3-02). The conflict is resolved in the open, in the direction the merge document
	 * already ruled (#2426 移植, merge-upstream-20260917.md §3.1): the interrupt sends the queue,
	 * the draft is still untouched, and a daemon too old for the command says so on screen.
	 */
	function createInterruptHarness(agentConnection: unknown) {
		return {
			traceUploadAllAbortController: undefined,
			sideQuestionEvent: undefined,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => true,
			agentConnection,
			showError: vi.fn(),
			showWarning: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
		};
	}

	/**
	 * A daemon transport that records the commands the connection writes. `capabilities` is what
	 * the peer advertises in its hello; `unknownCommand` makes it answer the way a peer whose
	 * capability list is newer than its command table does - it does not know that one command,
	 * while every other command (including the fallback abort) still works.
	 */
	function fakeDaemonTransport(options: { capabilities: readonly string[]; unknownCommand?: boolean }) {
		const requests: string[] = [];
		const client = {
			hello: undefined,
			isConnected: true,
			supportsServerCapability: (capability: string) => options.capabilities.includes(capability),
			onMessage: () => () => {},
			onClose: () => () => {},
			request: async (command: { type: string }) => {
				requests.push(command.type);
				return options.unknownCommand === true && command.type === "abort_and_send_queued"
					? {
							type: "response",
							command: command.type,
							success: false,
							error: `Unknown daemon command: ${command.type}`,
						}
					: { type: "response", command: command.type, success: true };
			},
		} as unknown as DaemonTransportClient;
		return { requests, client };
	}

	const interrupt = (harness: unknown) => (proto.interruptOrClearInput as (this: unknown) => void).call(harness);

	it("aborts by sending the queued messages instead of leaving them for the next submit", () => {
		const abort = vi.fn(async () => {});
		const abortAndSendQueued = vi.fn(async () => ({}));
		const harness = createInterruptHarness({ abort, abortAndSendQueued });
		interrupt(harness);
		expect(abortAndSendQueued).toHaveBeenCalledOnce();
		expect(abort).not.toHaveBeenCalled();
		expect(harness.editor.setText).not.toHaveBeenCalled();
		expect(harness.showWarning).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("puts abort_and_send_queued on the daemon wire from the interrupt key", async () => {
		// Cross-layer on purpose: the real interrupt method over the real daemon adapter, so
		// "the Esc path produces this command" is a claim about the shipping call graph and not
		// about a mock shaped to match it (the zero-producer hole B3-01 found was exactly the
		// difference between those two).
		const { requests, client } = fakeDaemonTransport({ capabilities: ["abort_and_send_queued"] });
		const harness = createInterruptHarness(new DaemonAgentConnection(client, "active-1"));
		interrupt(harness);
		await vi.waitFor(() => expect(requests).toEqual(["abort_and_send_queued"]));
		expect(harness.showWarning).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("warns the user when the daemon cannot send the queued messages with the interrupt", async () => {
		// Degradation is loud (P5 ruling, merge-upstream-20260917.md §13.4). A log line is not a
		// notice: without this the queued words silently wait for the next submit and the person
		// who pressed Esc retypes them (final-review seat B, B3-04).
		const { requests, client } = fakeDaemonTransport({ capabilities: [] });
		const harness = createInterruptHarness(new DaemonAgentConnection(client, "active-1"));
		interrupt(harness);
		await vi.waitFor(() => expect(requests).toEqual(["abort"]));
		await vi.waitFor(() => expect(harness.showWarning).toHaveBeenCalledOnce());
		expect(harness.showWarning.mock.calls[0]?.[0]).toContain("queued messages stay queued");
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("warns the user when the daemon answers Unknown daemon command", async () => {
		const { requests, client } = fakeDaemonTransport({
			capabilities: ["abort_and_send_queued"],
			unknownCommand: true,
		});
		const harness = createInterruptHarness(new DaemonAgentConnection(client, "active-1"));
		interrupt(harness);
		await vi.waitFor(() => expect(requests).toEqual(["abort_and_send_queued", "abort"]));
		await vi.waitFor(() => expect(harness.showWarning).toHaveBeenCalledOnce());
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("reports a failed interrupt as an error, not as a degradation", async () => {
		// The other half of the same face: a real failure must still reach showError, or the new
		// warn branch would have swallowed it.
		const failing = {
			abortAndSendQueued: async () => {
				throw new Error("connection is closed");
			},
		};
		const harness = createInterruptHarness(failing);
		interrupt(harness);
		await vi.waitFor(() => expect(harness.showError).toHaveBeenCalledWith("connection is closed"));
		expect(harness.showWarning).not.toHaveBeenCalled();
	});
});
