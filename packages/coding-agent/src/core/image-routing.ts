/**
 * Image-routing + override cluster extracted from agent-session.ts: the routing
 * decision for image-attaching turn batches on session models without image
 * input (batch images route to settings.imageModel, a recent undescribed image
 * in context re-routes a bounded number of times), the run's routed override
 * lifecycle (begin, handback once the image model put the image into words,
 * mid-run reroute when a tool result delivers new images), the request-context
 * hook that briefs and trims a routed request, the synchronous routing on the
 * agent event stream, and the image-delivery suspicion notice. The moved
 * methods keep exactly the same bodies; they read the session through
 * {@link ImageRoutingHost}, which `AgentSession` satisfies structurally, so the
 * move changes no runtime behavior. `batchCarriesImages`,
 * `messageCarriesImages` and the `ImageRouteDecision` type moved here with the
 * cluster: agent-session.ts imports them back, and this module never imports an
 * agent-session value, so the layering stays acyclic.
 */

import type { AgentEvent, AgentMessage, AgentModelOverride } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import type { AgentSession, PreparedTurnPayload, QueuedAgentMessage } from "./agent-session.js";
import {
	findImageNeedingLook,
	IMAGE_LOOK_MAX_ATTEMPTS,
	IMAGE_ROUTE_BRIEF,
	IMAGE_ROUTE_MAX_REQUESTS,
	IMAGE_ROUTE_TRIMMED_NOTE,
	type ImageModelRoutingInputs,
	isImageDescription,
	messageHasImage,
	resolveImageModelOverride,
	resolveImageModelRoute,
	trimContextForImageModel,
	withRequestNote,
} from "./image-model-routing.js";
import { createImageDeliverySuspicionMessage } from "./messages.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";
import type { SessionAction } from "./session-action-store.js";

/**
 * The seam of `AgentSession` the extracted image routing reads and mutates.
 * Member names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; members whose signatures are wide are indexed
 * access types so they stay single-sourced on the class.
 * `AgentSession._imageRouteForTurns`, `_imageModelRoutingInputs`,
 * `_beginImageRoute`, `_installImageRouteContextHook`, `_routeImagesOnAgentEvent`,
 * `_runModel`, `_maybeNoticeImageDeliverySuspicion`, `_isImageRoutedRun` and
 * `_imageRouteModel` keep one-line shells that delegate with `this` (the
 * dispatch paths, the constructor wiring, the agent-event callback, the
 * message_end suspicion check and the fallback/reconcile paths all call them
 * there). The cluster-internal helpers have no shells.
 */
export interface ImageRoutingHost {
	readonly agent: AgentSession["agent"];
	readonly model: AgentSession["model"];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	readonly serviceTier: AgentSession["serviceTier"];
	readonly settingsManager: AgentSession["settingsManager"];
	readonly _modelRegistry: AgentSession["_modelRegistry"];
	_dispatchedBatchCarriedImages: AgentSession["_dispatchedBatchCarriedImages"];
	_runToolResultsCarriedImages: AgentSession["_runToolResultsCarriedImages"];
	_imageDeliverySuspicionNotified: AgentSession["_imageDeliverySuspicionNotified"];
	readonly _imageLookAttempts: AgentSession["_imageLookAttempts"];
	readonly _imageDescriptions: AgentSession["_imageDescriptions"];
	_imageRoute: AgentSession["_imageRoute"];
	_appendCustomMessageToTranscript: AgentSession["_appendCustomMessageToTranscript"];
	_reportSessionPersistFailure: AgentSession["_reportSessionPersistFailure"];
}

/**
 * Whether a delivered message attaches image content. Used to route
 * image-carrying turns off session models without image input.
 */
function messageCarriesImages(message: QueuedAgentMessage | AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) && content.some((part: { type?: string }) => part?.type === "image");
}

/**
 * Whether the messages a dispatch commits (its turn records plus any prepared
 * extra messages) attach image content. Image routing and the image-delivery
 * suspicion check both read this off the committed batch; the suspicion check
 * additionally counts image blocks that tool results deliver mid-run
 * (attach_image replies), so a run that only receives images in-turn still
 * reports on them.
 */
export function batchCarriesImages(
	turns: SessionAction<PreparedTurnPayload>[],
	extraMessages: AgentMessage[],
): boolean {
	return (
		extraMessages.some((message) => messageCarriesImages(message)) ||
		turns.some((action) => action.payload.records.some((record) => messageCarriesImages(record.message)))
	);
}

/** Image routing for a dispatched batch: the image model, the image it reads, and why. */
export interface ImageRouteDecision {
	override: AgentModelOverride;
	/** Latest image message the route is for; the routed request brief keys off it. */
	anchor: AgentMessage | undefined;
	/** The batch attaches no image: the route is for a recent image already in context. */
	contextOnly: boolean;
}

/**
 * Routing decision for a dispatched turn batch, for a session model without image
 * input: serve the turn on the user-configured imageModel (settings.imageModel) when
 * a delivered message attaches images, and also when the context holds a recent image
 * that still needs a look - one no image-capable model has put into words (the image
 * turn was interrupted, failed, or the session restarted), or one the owner asks
 * about again. Without that second case the session model answers from a placeholder
 * and guesses. A batch that attaches images cannot be served honestly without an
 * image model, so that case throws with setup guidance; the context-only case just
 * stays on the session model when no image model is usable, and a picture is retried
 * this way only a few times, so a broken image model cannot hold every later turn.
 *
 * The override is stored on the agent, so retries and post-compaction
 * continuations of the routed turn keep serving it; the next dispatch
 * re-evaluates it. A missing session model is reported by _validateCanStartAgentRun.
 */
export function imageRouteForTurns(
	host: ImageRoutingHost,
	turns: SessionAction<PreparedTurnPayload>[],
	extraMessages: AgentMessage[] = [],
): ImageRouteDecision | undefined {
	const sessionModel = host.model;
	if (!sessionModel || sessionModel.input.includes("image")) return undefined;
	if (batchCarriesImages(turns, extraMessages)) {
		const override = resolveImageModelOverride(imageModelRoutingInputs(host, sessionModel));
		if (!override) return undefined;
		const batchMessages: AgentMessage[] = [
			...turns.flatMap((action) => action.payload.records.map((record) => record.message)),
			...extraMessages,
		];
		return {
			override,
			anchor: batchMessages.filter((message) => messageHasImage(message)).at(-1),
			contextOnly: false,
		};
	}
	const look = findImageNeedingLook({
		messages: host.agent.state.messages,
		promptText: turns.map((action) => action.payload.text ?? "").join("\n"),
		couldSeeImages: (message) => assistantCouldSeeImages(host, message),
	});
	if (!look || (host._imageLookAttempts.get(look.anchor) ?? 0) >= IMAGE_LOOK_MAX_ATTEMPTS) return undefined;
	const route = resolveImageModelRoute(imageModelRoutingInputs(host, sessionModel));
	return route.kind === "routed" ? { override: route.override, anchor: look.anchor, contextOnly: true } : undefined;
}

/** Whether the model that wrote `message` took image input (it saw the images before it). */
function assistantCouldSeeImages(host: ImageRoutingHost, message: AssistantMessage): boolean {
	if (host._imageDescriptions.has(message)) return true;
	return host._modelRegistry.find(message.provider, message.model)?.input.includes("image") === true;
}

export function imageModelRoutingInputs(host: ImageRoutingHost, sessionModel: Model<any>): ImageModelRoutingInputs {
	return {
		sessionModel,
		thinkingLevel: host.thinkingLevel,
		serviceTier: host.serviceTier,
		imageModelReference: host.settingsManager.getImageModel(),
		availableModels: host._modelRegistry.getAvailable(),
		hasConfiguredAuth: (model) => host._modelRegistry.hasConfiguredAuth(model),
		blockImages: host.settingsManager.getBlockImages(),
	};
}

/** Start the current run's image route (dispatch) or clear it for an image-free run. */
export function beginImageRoute(host: ImageRoutingHost, route: ImageRouteDecision | undefined): void {
	host.agent.modelOverride = route?.override;
	host._imageRoute = route
		? { override: route.override, handedBack: false, anchor: route.anchor, requests: 0 }
		: undefined;
	if (route?.contextOnly && route.anchor) {
		host._imageLookAttempts.set(route.anchor, (host._imageLookAttempts.get(route.anchor) ?? 0) + 1);
	}
}

/**
 * An image-routed run exists so the image model can read the images, not so it does
 * the whole task: once it has put what it saw into words, the rest of the run goes
 * back to the session model the owner chose (a screenshot must not move a long task
 * onto the cheaper image model). A short preamble in front of a tool call ("我来看看")
 * describes nothing, so the handback waits for a real description; an image model
 * that only calls tools still hands back after a few requests. During a fallback
 * episode the session model is the fallback model serving the session
 * (agent.state.model), and the run goes back to that. Runs synchronously on the
 * message_end event, before the loop takes the next request's model.
 */
function maybeHandBackFromImageModel(host: ImageRoutingHost, message: AssistantMessage): void {
	const route = host._imageRoute;
	const sessionModel = host.model;
	if (!route || route.handedBack || !sessionModel || !host.agent.modelOverride) return;
	if (message.stopReason === "error" || message.stopReason === "aborted") return;
	route.requests += 1;
	const described = isImageDescription(message);
	if (!described && route.requests < IMAGE_ROUTE_MAX_REQUESTS) return;
	if (described) host._imageDescriptions.add(message);
	route.handedBack = true;
	route.handback = {
		model: sessionModel,
		thinkingLevel: host.thinkingLevel,
		serviceTier: host.agent.state.serviceTier,
	};
	host.agent.pendingTurnModel = route.handback;
	host.agent.modelOverride = undefined;
}

/**
 * The image model a run that started image-free would switch to once a tool result
 * brings in images, or undefined when the session model sees images itself or no
 * usable imageModel is configured (attach_image then rejects with its own guidance).
 * During a fallback episode the session model is the fallback model now serving.
 */
function midRunImageModelOverride(host: ImageRoutingHost): AgentModelOverride | undefined {
	const sessionModel = host.model;
	if (!sessionModel) return undefined;
	const route = resolveImageModelRoute(imageModelRoutingInputs(host, sessionModel));
	return route.kind === "routed" ? route.override : undefined;
}

/**
 * A tool result delivered new images the session model cannot read, so the next
 * request goes to the image model. That covers a run handed back after an image
 * turn, and a run that started image-free: the owner pasted a file path as text and
 * the session model loaded it with attach_image. Runs synchronously on the
 * tool result's message_end: the loop takes the next request's model right after
 * that event, without waiting for the session's event queue.
 */
function rerouteToImageModelForNewImages(host: ImageRoutingHost, message: AgentMessage): void {
	const route = host._imageRoute;
	if (route && !route.handedBack) {
		route.anchor = message;
		return;
	}
	const override = midRunImageModelOverride(host);
	if (!override) return;
	host._imageRoute = { override, handedBack: false, anchor: message, requests: 0 };
	host.agent.modelOverride = override;
	host.agent.pendingTurnModel = override;
}

/**
 * The request context of a routed image-model request: the stored context plus a
 * brief that tells the image model why it got this request (never persisted), cut
 * to the image model's context window when the owner's session is larger than it.
 * Only this session's own loop is touched: a side question or subagent that shares
 * the hook sees a context without the routed image message and passes through.
 */
function imageRouteRequestContext(host: ImageRoutingHost, messages: AgentMessage[]): AgentMessage[] {
	const route = host._imageRoute;
	const serving = host.agent.modelOverride?.model;
	if (!route || route.handedBack || !serving || !route.anchor || !messages.includes(route.anchor)) {
		return messages;
	}
	const trimmed = trimContextForImageModel(messages, route.anchor, serving.contextWindow);
	const brief = trimmed ? `${IMAGE_ROUTE_BRIEF}\n${IMAGE_ROUTE_TRIMMED_NOTE}` : IMAGE_ROUTE_BRIEF;
	return withRequestNote(trimmed ?? messages, brief);
}

export function installImageRouteContextHook(host: ImageRoutingHost): void {
	const inner = host.agent.transformContext;
	// Before the inner hook: the routed image message is recognized by identity, and an
	// extension's context hook may hand back copies.
	host.agent.transformContext = async (messages, signal) => {
		const routed = imageRouteRequestContext(host, messages);
		return inner ? inner(routed, signal) : routed;
	};
}

/**
 * Image routing on the agent's event stream, decided synchronously: the loop takes
 * the next request's model right after a message_end, and the session's event queue
 * may still be working through earlier events, so a decision made there can come too
 * late and send the request after attach_image to the text-only model.
 */
export function routeImagesOnAgentEvent(host: ImageRoutingHost, event: AgentEvent): void {
	if (event.type !== "message_start" && event.type !== "message_end") return;
	const message = event.message;
	const deliversImages =
		(message.role === "toolResult" || message.role === "user" || message.role === "custom") &&
		messageHasImage(message);
	if (deliversImages) {
		// Mid-run tool results (attach_image through the kernel) and steering messages
		// (a Ctrl+V image sent while the run goes on) attach image blocks to this run's
		// continuation requests without a dispatch deciding the route; the suspicion
		// check counts them as carried images even when the committed batch had none.
		host._runToolResultsCarriedImages = true;
		if (event.type === "message_end") rerouteToImageModelForNewImages(host, message);
	} else if (message.role === "assistant" && event.type === "message_end") {
		maybeHandBackFromImageModel(host, message);
	}
}

/**
 * Model serving the current run: the routed image model while a routed
 * turn (or its retries/continuations) is active, the session model
 * otherwise. Overflow recovery compares against the model that actually
 * serves the requests, so a routed run accepts its assistant messages as its
 * own. Threshold compaction does not: it sizes the owner's session, which the
 * session model carries on with (see _sessionContextWindow).
 */
export function runModel(host: ImageRoutingHost): Model<any> | undefined {
	return host.agent.modelOverride?.model ?? host.model;
}

/**
 * Level-one image-delivery suspicion: this run's requests carried image
 * content (the committed batch, or image blocks a tool result delivered
 * mid-run), the response completed cleanly on an OpenAI-completions API (the
 * only usage schema that carries image token counts), and the usage frame had
 * no image token count - the provider may have silently dropped the images.
 * Observed both ways: a catalog entry claiming image input can serve 2xx
 * and answer blind, while some vision-capable providers never report the
 * count (stepfun), so this stays a suspicion, fires at most once per
 * committed batch, and never changes configuration.
 */
export function maybeNoticeImageDeliverySuspicion(host: ImageRoutingHost, message: AssistantMessage): void {
	if (
		(!host._dispatchedBatchCarriedImages && !host._runToolResultsCarriedImages) ||
		host._imageDeliverySuspicionNotified
	) {
		return;
	}
	// blockImages replaces every image with a text placeholder before the
	// request, so the provider truthfully counts no image tokens.
	if (host.settingsManager.getBlockImages()) return;
	if (message.api !== "openai-completions") return;
	if (message.usage.imageTokens !== undefined) {
		// Delivery confirmed for this batch: a later response in the same run
		// (the text-only session model after the image model hands back) was
		// never sent the images, so its missing count is not evidence.
		host._imageDeliverySuspicionNotified = true;
		return;
	}
	// A model without image input gets placeholders, never images; it has no
	// image tokens to count.
	if (host._modelRegistry.find(message.provider, message.model)?.input.includes("image") === false) return;
	host._imageDeliverySuspicionNotified = true;
	try {
		host._appendCustomMessageToTranscript(
			createImageDeliverySuspicionMessage({
				model: message.model,
				provider: message.provider,
				stopReason: message.stopReason,
			}),
		);
	} catch (error) {
		// Same contract as the message persist above: a failed transcript
		// write is reported and must not fail the turn.
		host._reportSessionPersistFailure(error);
	}
}

/** Whether the run is served by a routed image model rather than the session model. */
export function isImageRoutedRun(host: ImageRoutingHost): boolean {
	const override = host.agent.modelOverride;
	return override !== undefined && !modelsAreEqual(override.model, host.agent.state.model);
}

/** The configured image-route helper, resolved against what can serve right now. */
export function imageRouteModel(host: ImageRoutingHost): Model<any> | undefined {
	const reference = host.settingsManager.getImageModel();
	if (!reference) return undefined;
	return findExactModelReferenceMatch(reference, host._modelRegistry.getAvailable());
}
