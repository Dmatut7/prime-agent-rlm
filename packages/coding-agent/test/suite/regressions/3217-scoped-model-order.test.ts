import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import {
	type ModelsConfig,
	ScopedModelsSelectorComponent,
} from "../../../src/modes/interactive/components/scoped-models-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("issue #3217 scoped model ordering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates reordered scoped models back to the session state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: orderedIds,
			},
			{
				onChange: (enabledModelIds) => {
					changes.push(enabledModelIds);
				},
				onPersist: () => undefined,
				onCancel: () => {},
			},
		);

		selector.handleInput("\x1b[1;3B");

		expect(changes).toEqual([[orderedIds[1], orderedIds[0], orderedIds[2]]]);
	});

	it("preserves scoped model order in the /model scoped tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		const modelThree = harness.getModel("faux-3")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			modelOne,
			harness.session.modelRegistry,
			[{ model: modelTwo }, { model: modelOne }, { model: modelThree }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const renderedLines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const orderedIds = renderedLines
			.flatMap((line, index) => {
				if (line.trim() !== modelOne.provider) {
					return [];
				}
				const [modelId] = renderedLines[index - 1]?.trim().split(/\s{2,}/) ?? [];
				return modelId ? [modelId.trim()] : [];
			})
			.slice(0, 3);

		expect(orderedIds).toEqual([modelTwo.id, modelOne.id, modelThree.id]);
	});
});

describe("ScopedModelsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	const fakeModels = (...ids: string[]) =>
		ids.map((id) => ({ provider: "p", id, name: id })) as unknown as ModelsConfig["allModels"];

	it("keeps the highlight on the reordered model when the filter hides the swapped neighbor", () => {
		// Filtered view [alpha, beta] hides "mid"; moving beta up swaps it with mid
		// in the enabled order, which leaves beta's filtered position unchanged. The
		// highlight must follow beta by identity, not drift by one row.
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: fakeModels("alpha", "mid", "beta"),
				enabledModelIds: ["p/alpha", "p/mid", "p/beta"],
			},
			{ onChange: () => {}, onPersist: () => undefined, onCancel: () => {} },
		);

		selector.handleInput("a"); // filter: alpha + beta, mid hidden
		selector.handleInput("\x1b[B"); // down: select beta
		selector.handleInput("\x1b[1;3A"); // alt+up: reorder beta up over the hidden mid

		const selectedLine = stripAnsi(selector.render(100).join("\n"))
			.split("\n")
			.find((line) => line.includes("›"));
		expect(selectedLine).toBeDefined();
		expect(selectedLine).toContain("beta");
	});

	it("keeps the (unsaved) marker until the persist actually lands", async () => {
		let resolvePersist: ((value?: boolean) => void) | undefined;
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: fakeModels("alpha", "beta"),
				enabledModelIds: ["p/alpha", "p/beta"],
			},
			{
				onChange: () => {},
				onPersist: () => new Promise<boolean | undefined>((resolve) => (resolvePersist = resolve)),
				onCancel: () => {},
			},
		);
		const footer = () => stripAnsi(selector.render(100).join("\n"));

		selector.handleInput("\r"); // toggle alpha off → dirty
		expect(footer()).toContain("(unsaved)");

		selector.handleInput("\x13"); // ctrl+s: persist starts but has not landed
		expect(footer()).toContain("(unsaved)");

		resolvePersist?.();
		await waitForAsyncRender();
		expect(footer()).not.toContain("(unsaved)");
	});

	it("keeps the (unsaved) marker when the persist reports failure", async () => {
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: fakeModels("alpha", "beta"),
				enabledModelIds: ["p/alpha", "p/beta"],
			},
			{
				onChange: () => {},
				onPersist: () => false,
				onCancel: () => {},
			},
		);
		const footer = () => stripAnsi(selector.render(100).join("\n"));

		selector.handleInput("\r");
		selector.handleInput("\x13");
		await waitForAsyncRender();

		expect(footer()).toContain("(unsaved)");
	});

	it("treats left as back while the search field is empty", () => {
		let cancelled = 0;
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: fakeModels("alpha", "beta"),
				enabledModelIds: null,
			},
			{
				onChange: () => {},
				onPersist: () => undefined,
				onCancel: () => {
					cancelled++;
				},
			},
		);

		selector.handleInput("\x1b[D");

		expect(cancelled).toBe(1);
	});
});
