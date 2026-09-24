/**
 * Routing for image-attaching turns on session models without image input.
 */

import type { AgentMessage, AgentModelOverride, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	type Model,
	type ServiceTier,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { formatImageModelRequiredMessage, formatImageModelUnusableMessage } from "./auth-guidance.js";
import { estimateTokensByContent } from "./compaction/compaction.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";

/** Session state the routing decision needs when a turn batch commits. */
export interface ImageModelRoutingInputs {
	/** Model selected for the session; the routed turns carry images it cannot see. */
	sessionModel: Model<any>;
	/** Session thinking level; clamped to what the routed model supports. */
	thinkingLevel: ThinkingLevel;
	/** Session service tier; clamped to what the routed model supports. */
	serviceTier: ServiceTier;
	/** settings.imageModel reference ("provider/model-id" or a bare id). */
	imageModelReference: string | undefined;
	/** Registry models the reference may resolve to. */
	availableModels: Model<Api>[];
	/** Whether the registry has working credentials for a model. */
	hasConfiguredAuth: (model: Model<any>) => boolean;
	/** settings.images.blockImages: no image reaches any provider, so no turn routes. */
	blockImages: boolean;
}

/**
 * Who reads the images of a turn:
 * - `native`: the session model has image input;
 * - `blocked`: settings.images.blockImages replaces every image with a placeholder;
 * - `routed`: the configured imageModel serves the turn;
 * - `missing` / `unusable`: nobody can, because imageModel is unset, or names a model
 *   that is unknown, has no image input, or has no credentials.
 */
export type ImageModelRoute =
	| { kind: "native" }
	| { kind: "blocked" }
	| { kind: "routed"; override: AgentModelOverride }
	| { kind: "missing" }
	| { kind: "unusable"; reference: string };

export function resolveImageModelRoute(inputs: ImageModelRoutingInputs): ImageModelRoute {
	const { sessionModel } = inputs;
	if (sessionModel.input.includes("image")) return { kind: "native" };
	if (inputs.blockImages) return { kind: "blocked" };
	if (!inputs.imageModelReference) return { kind: "missing" };
	const imageModel = findExactModelReferenceMatch(inputs.imageModelReference, inputs.availableModels);
	if (!imageModel || !imageModel.input.includes("image") || !inputs.hasConfiguredAuth(imageModel)) {
		return { kind: "unusable", reference: inputs.imageModelReference };
	}
	return {
		kind: "routed",
		override: {
			model: imageModel,
			thinkingLevel: clampThinkingLevel(imageModel, inputs.thinkingLevel) as ThinkingLevel,
			serviceTier:
				inputs.serviceTier === "priority" && !supportsFastMode(imageModel) ? "default" : inputs.serviceTier,
		},
	};
}

/**
 * Resolve the model that serves turns attaching images: the configured image
 * model when the session model has no image input, undefined when the session
 * model serves them natively. Throws an actionable error when the turn cannot
 * be served honestly: a text-only session model would otherwise downgrade the
 * images to an "(image omitted)" placeholder.
 */
export function resolveImageModelOverride(inputs: ImageModelRoutingInputs): AgentModelOverride | undefined {
	const route = resolveImageModelRoute(inputs);
	switch (route.kind) {
		case "native":
		case "blocked":
			return undefined;
		case "routed":
			return route.override;
		case "missing":
			throw new Error(formatImageModelRequiredMessage(`${inputs.sessionModel.provider}/${inputs.sessionModel.id}`));
		case "unusable":
			throw new Error(formatImageModelUnusableMessage(route.reference));
	}
}

/** Whether a message attaches image content (user prompt, custom message or tool result). */
export function messageHasImage(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) && content.some((part: { type?: string }) => part?.type === "image");
}

/**
 * A short opening that announces a look instead of reporting one ("我来看看这张图",
 * "Let me check the screenshot"). Next to a tool call it describes nothing the session
 * model could continue from. Length alone cannot tell: a Chinese description of a
 * screenshot is often shorter than an English preamble.
 */
const PREAMBLE_MAX_CHARS = 60;
const PREAMBLE_OPENING =
	/^(?:(?:好的|好|嗯|收到|ok(?:ay)?|sure|alright)[\s,，.。!！:：]*)?(?:我来|让我|我先|我去|我要|我需要|首先|接下来|let me|let's|i'll|i will|i'm going to|i am going to|i need to|first,? i)/i;

/**
 * Whether an image model's reply put what it saw into words: a completed reply with
 * text, where text next to a tool call must be more than a preamble announcing the look.
 */
export function isImageDescription(message: AssistantMessage): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	if (text.length === 0) return false;
	if (!message.content.some((block) => block.type === "toolCall")) return true;
	return !(Array.from(text).length < PREAMBLE_MAX_CHARS && PREAMBLE_OPENING.test(text));
}

/**
 * Requests the image model may serve in one routed stretch before the run goes back to
 * the session model anyway: an image model that only calls tools must not keep the task.
 */
export const IMAGE_ROUTE_MAX_REQUESTS = 3;

/** Owner prompts after an image within which it still counts as the image being talked about. */
export const IMAGE_LOOK_RECENT_PROMPTS = 2;

/**
 * Dispatches that may route for an image already in context. Esc and "继续" retry it,
 * but an image model that keeps failing must not hold every later turn.
 */
export const IMAGE_LOOK_MAX_ATTEMPTS = 3;

/** A prompt that asks about a picture (Chinese and English wording). */
const IMAGE_REFERENCE =
	/图里|图中|图上|图片|截图|照片|图像|[这那张个幅上]图|看图|\bimages?\b|\bscreenshots?\b|\bpictures?\b|\bphotos?\b/i;

export function refersToImage(text: string): boolean {
	return IMAGE_REFERENCE.test(text);
}

export interface ImageLookInputs {
	/** Conversation context the next request is built from. */
	messages: readonly AgentMessage[];
	/** Text of the owner prompt being dispatched. */
	promptText: string;
	/** Whether the model that wrote an assistant reply could see images. */
	couldSeeImages: (message: AssistantMessage) => boolean;
}

/**
 * The recent image the next request should hand to the image model although the
 * dispatched prompt attaches none:
 * - `unanswered`: no image-capable model has put it into words yet (the image turn was
 *   interrupted by Esc, a provider error, a crash or a restart), so the session model
 *   would only get a placeholder and guess;
 * - `follow_up`: it was described, but the owner now asks about it again
 *   ("图里右下角那个数字是多少？"), and the description may not hold that detail.
 * Only the latest image counts, and only while it is recent: an old picture the
 * conversation has moved on from must not pull every later turn onto the image model.
 */
export function findImageNeedingLook(
	inputs: ImageLookInputs,
): { anchor: AgentMessage; reason: "unanswered" | "follow_up" } | undefined {
	const { messages } = inputs;
	let imageIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messageHasImage(messages[index])) {
			imageIndex = index;
			break;
		}
	}
	if (imageIndex < 0) return undefined;
	let promptsAfter = 0;
	let answered = false;
	for (let index = imageIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") promptsAfter++;
		if (message.role === "assistant" && inputs.couldSeeImages(message) && isImageDescription(message)) {
			answered = true;
		}
	}
	if (promptsAfter > IMAGE_LOOK_RECENT_PROMPTS) return undefined;
	const anchor = messages[imageIndex];
	if (!answered) return { anchor, reason: "unanswered" };
	if (refersToImage(inputs.promptText)) return { anchor, reason: "follow_up" };
	return undefined;
}

/**
 * Said to the image model inside its request only (never persisted): it was handed this
 * request because it can see, and the owner's main model continues from its words alone.
 */
export const IMAGE_ROUTE_BRIEF =
	"[Image hand-off] The model that normally runs this conversation cannot see images, so this request was " +
	"sent to you because you can. After your reply the conversation goes back to that model, and it only " +
	"knows what you put into words: describe what the image shows that matters for the request - exact " +
	"text, numbers, labels and where things are - then answer or continue the task as usual.";

export const IMAGE_ROUTE_TRIMMED_NOTE =
	"Older conversation was left out of this request to fit your context window; the main model still has it.";

/** Append `note` to the request's last message (a copy; the stored context is untouched). */
export function withRequestNote(messages: AgentMessage[], note: string): AgentMessage[] {
	const last = messages.at(-1);
	if (last && (last.role === "user" || last.role === "toolResult" || last.role === "custom")) {
		const content = last.content;
		const extended =
			typeof content === "string"
				? [
						{ type: "text" as const, text: content },
						{ type: "text" as const, text: note },
					]
				: [...content, { type: "text" as const, text: note }];
		return [...messages.slice(0, -1), { ...last, content: extended } as AgentMessage];
	}
	return [...messages, { role: "user", content: [{ type: "text", text: note }], timestamp: Date.now() }];
}

/** Share of the image model's window a routed request may fill; the rest is headroom for the reply. */
const ROUTED_CONTEXT_WINDOW_SHARE = 0.75;

/**
 * Fit a routed request into the image model's context window without touching the
 * session: drop the oldest turns (cutting only at an owner prompt, so no tool result
 * loses its call) until the rest fits, never cutting past the turn that holds `anchor`.
 * Returns undefined when nothing needs trimming or no cut can help.
 */
export function trimContextForImageModel(
	messages: AgentMessage[],
	anchor: AgentMessage | undefined,
	contextWindow: number,
): AgentMessage[] | undefined {
	if (contextWindow <= 0 || messages.length === 0) return undefined;
	const budget = contextWindow * ROUTED_CONTEXT_WINDOW_SHARE;
	const suffixTokens: number[] = new Array(messages.length + 1).fill(0);
	for (let index = messages.length - 1; index >= 0; index--) {
		suffixTokens[index] = suffixTokens[index + 1] + estimateTokensByContent(messages[index]);
	}
	if (suffixTokens[0] <= budget) return undefined;
	const anchorIndex = anchor ? messages.indexOf(anchor) : messages.length - 1;
	const lastAllowedCut = anchorIndex >= 0 ? anchorIndex : messages.length - 1;
	let cut = -1;
	for (let index = 1; index <= lastAllowedCut; index++) {
		if (messages[index].role !== "user") continue;
		cut = index;
		if (suffixTokens[index] <= budget) break;
	}
	return cut > 0 ? messages.slice(cut) : undefined;
}
