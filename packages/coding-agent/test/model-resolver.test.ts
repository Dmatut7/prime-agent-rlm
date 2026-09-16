import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	defaultModelPerProvider,
	findInitialModel,
	resolveCliModel,
	resolveModelScopeFromModels,
} from "../src/core/model-resolver.js";

const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const mockOpenRouterModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const allModels = [...mockModels, ...mockOpenRouterModels];

describe("resolveModelScopeFromModels", () => {
	test("resolves scope patterns against the supplied model list", () => {
		const daemonModel: Model<"anthropic-messages"> = {
			id: "daemon-only-model",
			name: "Daemon Only Model",
			api: "anthropic-messages",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const result = resolveModelScopeFromModels(
			["prime-inference/daemon-only-model:high", "openai/gpt-4o"],
			[...allModels, daemonModel],
		);

		expect(result).toHaveLength(2);
		expect(result[0]?.model).toBe(daemonModel);
		expect(result[0]?.thinkingLevel).toBe("high");
		expect(result[1]?.model.provider).toBe("openai");
		expect(result[1]?.model.id).toBe("gpt-4o");
	});

	test("resolves a thinking level after a colon-bearing model id", () => {
		const result = resolveModelScopeFromModels(["openrouter/qwen/qwen3-coder:exacto:high"], allModels);

		expect(result).toEqual([{ model: mockOpenRouterModels[0], thinkingLevel: "high" }]);
	});

	test("keeps the model, warns, and drops an invalid thinking suffix", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveModelScopeFromModels(["sonnet:random"], allModels);

			expect(result).toEqual([{ model: mockModels[0], thinkingLevel: undefined }]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid thinking level "random"'));
		} finally {
			warn.mockRestore();
		}
	});

	test("preserves provider-qualified selections when model names overlap", () => {
		const primeInferenceModel: Model<"anthropic-messages"> = {
			...mockModels[0]!,
			id: "z-ai/glm-5.2",
			name: "GLM 5.2",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
		};
		const huggingFaceModel: Model<"anthropic-messages"> = {
			...primeInferenceModel,
			id: "zai-org/GLM-5.2",
			provider: "huggingface",
			baseUrl: "https://router.huggingface.co/v1",
		};

		const result = resolveModelScopeFromModels(
			["huggingface/zai-org/GLM-5.2"],
			[primeInferenceModel, huggingFaceModel],
		);

		expect(result).toEqual([{ model: huggingFaceModel, thinkingLevel: undefined }]);
	});
});

describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});

	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getAll: () => [],
			getAvailable: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("prefers provider/model split over gateway model with matching id", () => {
		const zaiModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const gatewayModel: Model<"anthropic-messages"> = {
			id: "zai/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAll: () => [...allModels, zaiModel, gatewayModel],
			getAvailable: () => [...allModels, zaiModel, gatewayModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getAll: () => allModels,
			getAvailable: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});
});

describe("default model selection", () => {
	test("openai defaults track current models", () => {
		expect(defaultModelPerProvider.openai).toBe("gpt-5.4");
		expect(defaultModelPerProvider["openai-codex"]).toBe("gpt-5.5");
		expect(defaultModelPerProvider["prime-inference"]).toBe("z-ai/glm-5.2");
	});

	test("zai, minimax, and cerebras defaults track current models", () => {
		expect(defaultModelPerProvider.zai).toBe("glm-5.1");
		expect(defaultModelPerProvider.minimax).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider["minimax-cn"]).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider.cerebras).toBe("gpt-oss-120b");
	});

	test("ai-gateway default tracks current model", () => {
		expect(defaultModelPerProvider["vercel-ai-gateway"]).toBe("zai/glm-5.1");
	});

	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("findInitialModel uses medium as the built-in default thinking level", async () => {
		const reasoningModel = mockModels[0];
		const registry = {
			refreshAvailableModels: async () => [reasoningModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model).toBe(reasoningModel);
		expect(result.thinkingLevel).toBe("medium");
	});

	test("findInitialModel prefers GLM 5.2 when Prime Inference is configured", async () => {
		const anthropicModel: Model<"anthropic-messages"> = {
			...mockModels[0],
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
		};
		const primeModel: Model<"anthropic-messages"> = {
			id: "z-ai/glm-5.2",
			name: "GLM 5.2",
			api: "anthropic-messages",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 101376,
		};
		const registry = {
			refreshAvailableModels: async () => [anthropicModel, primeModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model).toBe(primeModel);
	});

	test("findInitialModel uses another provider default when Prime Inference is not configured", async () => {
		const anthropicModel: Model<"anthropic-messages"> = {
			...mockModels[0],
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
		};
		const registry = {
			refreshAvailableModels: async () => [anthropicModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model).toBe(anthropicModel);
	});

	test("findInitialModel selects ai-gateway default when available", async () => {
		const aiGatewayModel: Model<"anthropic-messages"> = {
			id: "anthropic/claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8192,
		};

		const registry = {
			refreshAvailableModels: async () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});

	test("findInitialModel skips saved defaults without configured auth", async () => {
		const savedDefault = mockModels[0];
		const primeModel: Model<"anthropic-messages"> = {
			id: "openai/gpt-5.5",
			name: "GPT 5.5 (Prime Inference)",
			api: "anthropic-messages",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			find: (provider: string, modelId: string) =>
				[savedDefault, primeModel].find((model) => model.provider === provider && model.id === modelId),
			hasConfiguredAuth: (model: Model<"anthropic-messages">) => model.provider === "prime-inference",
			refreshAvailableModels: async () => [primeModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: savedDefault.provider,
			defaultModelId: savedDefault.id,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("prime-inference");
		expect(result.model?.id).toBe("openai/gpt-5.5");
	});

	test("findInitialModel rebuilds a saved default missing from the model snapshot when the provider is authed", async () => {
		const primeSnapshotModel: Model<"anthropic-messages"> = {
			id: "openai/gpt-5.5",
			name: "GPT 5.5 (Prime Inference)",
			api: "anthropic-messages",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			find: () => undefined,
			getAll: () => [primeSnapshotModel],
			hasConfiguredAuth: (model: Model<"anthropic-messages">) => model.provider === "prime-inference",
			refreshAvailableModels: async () => [primeSnapshotModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "prime-inference",
			defaultModelId: "anthropic/claude-opus-4.6",
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("prime-inference");
		expect(result.model?.id).toBe("anthropic/claude-opus-4.6");
	});

	test("findInitialModel does not rebuild a saved default for an unauthed provider", async () => {
		const primeSnapshotModel: Model<"anthropic-messages"> = {
			id: "openai/gpt-5.5",
			name: "GPT 5.5 (Prime Inference)",
			api: "anthropic-messages",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			find: () => undefined,
			getAll: () => [...mockModels, primeSnapshotModel],
			hasConfiguredAuth: (model: Model<"anthropic-messages">) => model.provider === "prime-inference",
			refreshAvailableModels: async () => [primeSnapshotModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-ghost-9",
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("prime-inference");
		expect(result.model?.id).toBe("openai/gpt-5.5");
	});
});

describe("resolveCliModel auth-filtered candidate pool (r43 MC-1)", () => {
	const anthropicSonnet: Model<"anthropic-messages"> = {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const bedrockSonnet: Model<"anthropic-messages"> = {
		...anthropicSonnet,
		id: "us.anthropic.claude-sonnet-5",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	};
	const azureGpt5: Model<"anthropic-messages"> = {
		...anthropicSonnet,
		id: "gpt-5",
		provider: "azure-openai-responses",
		baseUrl: "https://resource.openai.azure.com",
	};

	function registryWithAuth(authed: Model<"anthropic-messages">[], all: Model<"anthropic-messages">[]) {
		return {
			getAll: () => all,
			getAvailable: () => authed,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];
	}

	test("a fuzzy pattern without --provider resolves inside the authenticated face (not amazon-bedrock)", () => {
		const registry = registryWithAuth([anthropicSonnet], [anthropicSonnet, bedrockSonnet]);

		const result = resolveCliModel({ cliModel: "sonnet", modelRegistry: registry });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});

	test("an unauthenticated-only fuzzy hit without --api-key fails with the configured provider list", () => {
		const registry = registryWithAuth([anthropicSonnet], [anthropicSonnet, azureGpt5]);

		const result = resolveCliModel({ cliModel: "gpt-5", modelRegistry: registry });

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("anthropic");
		expect(result.error).toContain("--provider");
	});

	test("allowUnauthenticated keeps the --api-key first-time setup path resolvable", () => {
		const registry = registryWithAuth([anthropicSonnet], [anthropicSonnet, azureGpt5]);

		const result = resolveCliModel({ cliModel: "gpt-5", modelRegistry: registry, allowUnauthenticated: true });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("azure-openai-responses");
	});

	test("an explicit --provider still resolves against the full catalog (custom ids, warnings)", () => {
		const registry = registryWithAuth([anthropicSonnet], [anthropicSonnet, azureGpt5]);

		const result = resolveCliModel({
			cliProvider: "azure-openai-responses",
			cliModel: "gpt-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("azure-openai-responses");
		expect(result.model?.id).toBe("gpt-5");
	});

	test("zero configured credentials fails with /login and --api-key guidance instead of resolving", () => {
		const registry = registryWithAuth([], [anthropicSonnet, azureGpt5]);

		const result = resolveCliModel({ cliModel: "sonnet", modelRegistry: registry });

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("/login");
		expect(result.error).toContain("--api-key");
	});

	test("an authenticated exact id keeps resolving byte-identically", () => {
		const registry = registryWithAuth([anthropicSonnet], [anthropicSonnet, bedrockSonnet]);

		const result = resolveCliModel({ cliModel: "claude-sonnet-4-5", modelRegistry: registry });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});
});

describe("resolveCliModel equivalence corpus (r43 MC-1, probe-fuzzy)", () => {
	// Baseline captured at frozen SHA b908e9acf with only-anthropic credentials
	// (r42 probe-fuzzy.ts). Equivalence contract: rows whose baseline pick had
	// pickedHasAuth=false may change (to an authenticated hit or an error); the
	// authenticated row must stay byte-identical.
	const baseline = [
		{ q: "sonnet", picked: "amazon-bedrock/us.anthropic.claude-sonnet-5", pickedHasAuth: false },
		{ q: "opus", picked: "amazon-bedrock/us.anthropic.claude-opus-5", pickedHasAuth: false },
		{ q: "haiku", picked: "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", pickedHasAuth: false },
		{ q: "gpt-5", picked: "azure-openai-responses/gpt-5", pickedHasAuth: false },
		{ q: "kimi", picked: "vercel-ai-gateway/moonshotai/kimi-k3-fast", pickedHasAuth: false },
		{ q: "glm", picked: "vercel-ai-gateway/zai/glm-5v-turbo", pickedHasAuth: false },
		{ q: "gemini", picked: "openrouter/google/gemini-3.7-flash", pickedHasAuth: false },
		{ q: "deepseek", picked: "amazon-bedrock/us.deepseek.r1-v1:0", pickedHasAuth: false },
		{ q: "o3", picked: "azure-openai-responses/o3", pickedHasAuth: false },
		{ q: "qwen", picked: "opencode-go/qwen3.8-max", pickedHasAuth: false },
		{ q: "claude-sonnet-4-5", picked: "anthropic/claude-sonnet-4-5", pickedHasAuth: true },
		{ q: "sonnet:high", picked: "amazon-bedrock/us.anthropic.claude-sonnet-5", pickedHasAuth: false },
		{ q: "claude", picked: "amazon-bedrock/us.anthropic.claude-sonnet-5", pickedHasAuth: false },
	];

	const dir = mkdtempSync(join(tmpdir(), "mc1-equiv-"));
	mkdirSync(dir, { recursive: true });
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "sk-ant-probe");
	const registry = ModelRegistry.create(authStorage, join(dir, "models.json"));
	const authedProviders = [...new Set(registry.getAvailable().map((m) => m.provider))];
	// The corpus semantics assume a machine where anthropic is the only
	// authenticated provider; anything else changes the allowed outcome set.
	const onlyAnthropicAuth = authedProviders.length === 1 && authedProviders[0] === "anthropic";

	test.skipIf(!onlyAnthropicAuth)(
		"authenticated rows stay byte-identical and changed rows stay inside the authenticated face",
		() => {
			expect(baseline.length).toBeGreaterThan(0);
			for (const row of baseline) {
				const result = resolveCliModel({ cliModel: row.q, modelRegistry: registry });
				if (row.pickedHasAuth) {
					expect(`${result.model?.provider}/${result.model?.id}`).toBe(row.picked);
					expect(result.error).toBeUndefined();
				} else if (result.model) {
					// Changed rows must land on an authenticated provider/model.
					expect(registry.hasConfiguredAuth(result.model)).toBe(true);
					expect(result.error).toBeUndefined();
				} else {
					expect(result.error).toBeDefined();
				}
			}
		},
	);

	test.skipIf(!onlyAnthropicAuth)("the thinking suffix keeps flowing through on changed rows", () => {
		const result = resolveCliModel({ cliModel: "sonnet:high", modelRegistry: registry });
		if (result.model) {
			expect(registry.hasConfiguredAuth(result.model)).toBe(true);
			expect(result.thinkingLevel).toBe("high");
		} else {
			expect(result.error).toBeDefined();
		}
	});
});
