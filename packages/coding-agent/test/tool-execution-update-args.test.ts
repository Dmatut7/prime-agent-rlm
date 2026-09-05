import { parseStreamingJson } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Regression coverage for the O(1) args change detection in
 * ToolExecutionComponent.updateArgs (previously a per-update JSON.stringify
 * signature, O(len(args)) per delta).
 *
 * The acceptance criterion is a superset relation: the set of updateArgs calls
 * that trigger a rebuild after the change must cover the set that triggered a
 * rebuild before it (never miss a re-render; extra rebuilds are tolerated).
 * These tests replay realistic delta sequences against both the component and
 * a reference implementation of the old signature guard, and compare the
 * resulting trigger sets plus the rendered arguments text.
 */

function createFakeTui() {
	return { requestRender: () => {} } as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5];
}

/** Reference implementation of the pre-change signature guard. */
function legacyRebuildTrace(initialArgs: unknown, updates: unknown[]): number[] {
	const signature = (args: unknown): string | undefined => {
		try {
			return JSON.stringify(args) ?? "undefined";
		} catch {
			return undefined;
		}
	};
	let previous = signature(initialArgs);
	const rebuilds: number[] = [];
	for (let i = 0; i < updates.length; i++) {
		const current = signature(updates[i]);
		if (current !== undefined && current === previous) {
			continue;
		}
		previous = current;
		rebuilds.push(i);
	}
	return rebuilds;
}

interface Harness {
	component: ToolExecutionComponent;
	/** Arguments handed to renderCall, one entry per rebuild (first = constructor). */
	renderedArgs: unknown[];
}

function createComponent(toolName: string, toolCallId: string, initialArgs: unknown): Harness {
	const renderedArgs: unknown[] = [];
	const toolDefinition: ToolDefinition = {
		name: toolName,
		label: toolName,
		description: "test tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: (args) => {
			renderedArgs.push(args);
			return new Text(JSON.stringify(args) ?? "undefined", 0, 0);
		},
	};
	const component = new ToolExecutionComponent(
		toolName,
		toolCallId,
		initialArgs,
		{},
		toolDefinition,
		createFakeTui(),
		process.cwd(),
	);
	return { component, renderedArgs };
}

/** Rebuild indices of the component over the given update sequence. */
function componentRebuildTrace(harness: Harness, updates: unknown[]): number[] {
	const rebuilds: number[] = [];
	let seen = harness.renderedArgs.length;
	for (let i = 0; i < updates.length; i++) {
		harness.component.updateArgs(updates[i]);
		if (harness.renderedArgs.length > seen) {
			rebuilds.push(i);
			seen = harness.renderedArgs.length;
		}
	}
	return rebuilds;
}

/** Build the fresh-object-per-delta sequence the streaming path produces. */
function streamingArgsSequence(finalArgs: Record<string, unknown>, deltaCount: number): unknown[] {
	const json = JSON.stringify(finalArgs);
	const size = Math.ceil(json.length / deltaCount);
	const updates: unknown[] = [];
	let partial = "";
	for (let i = 0; i < json.length; i += size) {
		partial += json.slice(i, i + size);
		updates.push(parseStreamingJson(partial));
	}
	return updates;
}

function largeArgs(targetBytes = 40_000): Record<string, unknown> {
	const cell = `const data = "${"0123456789".repeat(100)}";\n`;
	let code = "";
	while (code.length < targetBytes) {
		code += cell;
	}
	return { code };
}

describe("ToolExecutionComponent.updateArgs change detection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("rebuild trigger set covers the legacy signature guard over a streaming delta sequence", () => {
		const finalArgs = largeArgs();
		const advancing = streamingArgsSequence(finalArgs, 397);
		expect(advancing.length).toBeGreaterThan(300);

		// Interleave same-reference redeliveries, matching message_update events
		// triggered by unrelated text deltas while this tool call stands still.
		const updates: unknown[] = [];
		for (let i = 0; i < advancing.length; i++) {
			updates.push(advancing[i]);
			if (i % 3 === 0) {
				updates.push(advancing[i]);
			}
			if (i % 7 === 0 && i + 1 < advancing.length) {
				updates.push(advancing[i]); // repeated reference again before advancing
			}
		}

		const initialArgs = {};
		const harness = createComponent("custom_tool", "tc-stream", initialArgs);
		const actual = componentRebuildTrace(harness, updates);
		const expected = legacyRebuildTrace(initialArgs, updates);

		// Superset: every legacy rebuild index must still rebuild.
		for (const index of expected) {
			expect(actual).toContain(index);
		}
		// This sequence contains no same-content-fresh-object steps, so the
		// trigger sets must match exactly - no unexpected extra rebuilds either.
		expect(actual).toEqual(expected);

		// The legacy guard skips every same-reference redelivery here.
		const sameReferenceCalls = updates.length - advancing.length;
		expect(sameReferenceCalls).toBeGreaterThan(0);
		expect(expected.length).toBe(advancing.length);

		// Rendered arguments text is byte-identical to the serialized final args.
		const lastRendered = harness.renderedArgs[harness.renderedArgs.length - 1];
		expect(JSON.stringify(lastRendered)).toBe(JSON.stringify(finalArgs));
	});

	test("never misses a rebuild when the arguments advance", () => {
		// Capability floor: every content change must re-render, so the user
		// always sees the latest streamed arguments.
		const updates = streamingArgsSequence({ code: "print(1)" }, 20);
		expect(updates.length).toBeGreaterThan(5);
		const harness = createComponent("custom_tool", "tc-advance", {});
		const actual = componentRebuildTrace(harness, updates);
		expect(actual).toEqual(updates.map((_, i) => i));
		const lastRendered = harness.renderedArgs[harness.renderedArgs.length - 1];
		expect(lastRendered).toEqual({ code: "print(1)" });
	});

	test("skips same-reference redelivery without rebuilding", () => {
		const args = { command: "ls -la" };
		const harness = createComponent("custom_tool", "tc-same-ref", {});
		const updates = Array.from({ length: 100 }, () => args);
		const actual = componentRebuildTrace(harness, updates);
		// First delivery is a fresh reference and must render; the 99 same
		// reference redeliveries must not rebuild.
		expect(actual).toEqual([0]);
		expect(JSON.stringify(harness.renderedArgs[harness.renderedArgs.length - 1])).toBe(JSON.stringify(args));
	});

	test("still rebuilds when a fresh object carries identical content", () => {
		// Tolerated direction of the superset: equal content under a new
		// reference rebuilds (the old guard skipped it), never the reverse.
		const harness = createComponent("custom_tool", "tc-fresh-same", {});
		const actual = componentRebuildTrace(harness, [{ a: 1 }, { a: 1 }, { a: 1 }]);
		expect(actual).toEqual([0, 1, 2]);
		expect(legacyRebuildTrace({}, [{ a: 1 }, { a: 1 }, { a: 1 }])).toEqual([0]);
	});

	test("keeps rebuilding unconditionally for unserializable constructor args", () => {
		// Exotic fallback of the old guard: an unserializable initial value never
		// compares equal, so every update rebuilds - even a same-reference one.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const harness = createComponent("custom_tool", "tc-exotic", circular);
		const before = harness.renderedArgs.length;
		harness.component.updateArgs(circular);
		expect(harness.renderedArgs.length).toBeGreaterThan(before);
	});
});
