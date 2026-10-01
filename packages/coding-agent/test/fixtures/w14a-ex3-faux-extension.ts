/**
 * Scripted faux provider for the W14-A EX-3 recovery-chain regression
 * (test/suite/regressions/w14a-ex3-recovery-chain.test.ts). The exam's two
 * phases are two response scripts, selected by W14A_EX3_PHASE:
 *
 *   A: write phase-a.txt (the token is lifted out of the prompt, as a real
 *      model would read it), then start the heartbeat loop the test
 *      SIGTERMs mid-cell.
 *   B: prove the resumed context still carries the phase-A prompt, probe the
 *      on-disk artifacts through the kernel, then write phase-b.txt from the
 *      probe's tool result.
 *
 * The ipython codes are protocol markers (#w14a:*) for the fake kernel the
 * test installs via PRIME_AGENT_KERNEL_PYTHON; the kernel performs the file
 * IO, the extension only assembles the cells.
 */
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerFauxProvider,
} from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

const TOKEN_PATTERN = /W14A-[A-Z0-9]{6}/;

function userTexts(context: Context): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
		)
		.join("\n");
}

function tokenFromContext(context: Context): string {
	const token = TOKEN_PATTERN.exec(userTexts(context))?.[0];
	if (!token) {
		throw new Error("resumed session lost the phase-A prompt token");
	}
	return token;
}

function lastToolResultText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "toolResult") continue;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	throw new Error("phase B probe produced no tool result");
}

function phaseAResponses(): FauxResponseStep[] {
	return [
		(context) =>
			fauxAssistantMessage(fauxToolCall("ipython", { code: `#w14a:write-phase-a\n${tokenFromContext(context)}` }), {
				stopReason: "toolUse",
			}),
		fauxAssistantMessage(fauxToolCall("ipython", { code: "#w14a:heartbeat" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("PHASE-A-DONE"),
	];
}

function phaseBResponses(): FauxResponseStep[] {
	return [
		(context) => {
			tokenFromContext(context);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "#w14a:probe" }), { stopReason: "toolUse" });
		},
		(context) => {
			const probe = lastToolResultText(context);
			const token = /TOKEN=(\S+)/.exec(probe)?.[1];
			const ticks = /TICKS=(\d+)/.exec(probe)?.[1];
			if (!token || !ticks) {
				throw new Error(`phase B probe result malformed: ${probe}`);
			}
			return fauxAssistantMessage(fauxToolCall("ipython", { code: `#w14a:write-phase-b\n${token}\n${ticks}` }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("PHASE-B-DONE"),
	];
}

export default function registerW14aEx3FauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	faux.setResponses(process.env.W14A_EX3_PHASE === "B" ? phaseBResponses() : phaseAResponses());
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
