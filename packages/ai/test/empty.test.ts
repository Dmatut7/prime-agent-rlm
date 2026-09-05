import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "../src/providers/faux.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.js";
import { getKimiCodingTestModel } from "./kimi-test-model.js";
import { getZaiTestModel } from "./zai-test-model.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";

const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * Assert the proposition this file covers: an empty / whitespace-only user message is handled
 * deliberately, meaning the provider either rejects it with a diagnosable error or answers with
 * real content.
 *
 * The previous shape of this check only asserted facts that hold by construction - an error
 * response always carries `errorMessage`, and `content` is always an array - so a hollow success
 * (`content: []` with `stopReason: "stop"`), a stringified-`undefined` error, and an aborted
 * response nobody asked for all counted as passes. The offline describe at the bottom of this file
 * pins each of those cases down with the faux provider.
 */
function expectEmptyInputHandled(response: AssistantMessage): void {
	expect(response.role).toBe("assistant");
	// No abort signal is passed anywhere in this file, so an aborted response is a fault.
	expect(response.stopReason).not.toBe("aborted");

	if (response.stopReason === "error") {
		// Rejecting an empty message is a legitimate outcome, but only if the rejection says why.
		const trimmed = (response.errorMessage ?? "").trim();
		expect(typeof response.errorMessage).toBe("string");
		expect(trimmed.length).toBeGreaterThan(0);
		expect(trimmed).not.toMatch(/^(undefined|null|NaN|\[object Object\])$/i);
		return;
	}

	// The provider tolerated the empty input, so it has to have produced something real.
	expect(response.content.length).toBeGreaterThan(0);
	expect(hasSubstantiveContent(response.content)).toBe(true);
}

function hasSubstantiveContent(content: AssistantMessage["content"]): boolean {
	return content.some((block) => {
		if (block.type === "text") {
			return block.text.trim().length > 0;
		}
		if (block.type === "thinking") {
			return block.thinking.trim().length > 0 || block.redacted === true;
		}
		return block.name.length > 0;
	});
}

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	expectEmptyInputHandled(response);
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expectEmptyInputHandled(response);
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expectEmptyInputHandled(response);
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expectEmptyInputHandled(response);
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Empty Messages", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, azureOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, azureOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm, azureOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Empty Messages", () => {
		const llm = getModel("xai", "grok-4.3");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Empty Messages", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Empty Messages", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider Empty Messages", () => {
		const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Empty Messages", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Empty Messages", () => {
		const llm = getZaiTestModel();

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Empty Messages", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Empty Messages", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider Empty Messages", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider Empty Messages",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider Empty Messages",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider Empty Messages",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Empty Messages", () => {
		const llm = getKimiCodingTestModel();

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Empty Messages", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Empty Messages", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe("Anthropic OAuth Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testWhitespaceOnlyMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testEmptyAssistantMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Empty Messages", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider Empty Messages", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyStringMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testWhitespaceOnlyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyAssistantMessage(llm, { apiKey: openaiCodexToken });
			},
		);
	});

	describe("empty-input contract (offline, faux provider, no API key)", () => {
		const registrations: Array<{ unregister: () => void }> = [];

		afterEach(() => {
			for (const registration of registrations.splice(0)) {
				registration.unregister();
			}
		});

		function fauxModel(response: AssistantMessage): Model<Api> {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([response]);
			return registration.getModel();
		}

		// The check this file used before: every branch asserts something that is true by
		// construction, so it accepted all of the malformed responses below. It is kept only as the
		// contrast half of the lock - if the live assertions ever weaken back to this shape, the
		// two halves stop disagreeing and the test fails.
		function previousShapeCheck(response: AssistantMessage): void {
			expect(response).toBeDefined();
			expect(response.role).toBe("assistant");
			if (response.stopReason === "error") {
				expect(response.errorMessage).toBeDefined();
			} else {
				expect(response.content).toBeDefined();
			}
		}

		const malformed: Array<[string, AssistantMessage]> = [
			["a hollow success with no content", fauxAssistantMessage([], { stopReason: "stop" })],
			["an error without a diagnostic message", fauxAssistantMessage([], { stopReason: "error", errorMessage: "" })],
			[
				"an aborted response although nothing was aborted",
				fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "Request was aborted" }),
			],
			["content blocks that are all whitespace", fauxAssistantMessage([fauxText("  \n\t ")])],
		];

		it.each(malformed)("rejects %s, which the previous shape accepted", (_label, response) => {
			expect(() => previousShapeCheck(response)).not.toThrow();
			expect(() => expectEmptyInputHandled(response)).toThrow();
		});

		it("accepts a substantive reply", () => {
			expect(() => expectEmptyInputHandled(fauxAssistantMessage("How can I help you?"))).not.toThrow();
		});

		it("accepts a rejection that says why the empty message was refused", () => {
			const rejection = fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "all messages must have non-empty content except for the final assistant message",
			});
			expect(() => expectEmptyInputHandled(rejection)).not.toThrow();
		});

		it("accepts a redacted thinking block as a substantive reply", () => {
			const redacted: AssistantMessage = {
				...fauxAssistantMessage([]),
				content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true }],
			};
			expect(() => expectEmptyInputHandled(redacted)).not.toThrow();
		});

		it("fails end to end when the provider returns a hollow success for an empty message", async () => {
			const llm = fauxModel(fauxAssistantMessage([], { stopReason: "stop" }));
			await expect(testEmptyMessage(llm)).rejects.toThrow();
		});

		it("fails end to end when the provider returns an undiagnosed error for an empty message", async () => {
			const llm = fauxModel(fauxAssistantMessage([], { stopReason: "error", errorMessage: "" }));
			await expect(testEmptyStringMessage(llm)).rejects.toThrow();
		});

		it("fails end to end when the provider aborts although nothing was aborted", async () => {
			const llm = fauxModel(
				fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "Request was aborted" }),
			);
			await expect(testWhitespaceOnlyMessage(llm)).rejects.toThrow();
		});

		it("passes end to end when the provider answers an empty message with real content", async () => {
			const llm = fauxModel(fauxAssistantMessage("You sent an empty message. What would you like to do?"));
			await testEmptyMessage(llm);
		});

		it("passes end to end when the provider rejects an empty message with a reason", async () => {
			const llm = fauxModel(
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "messages.0.content: empty is not allowed" }),
			);
			await testEmptyMessage(llm);
		});

		it("passes end to end for an empty assistant message followed by a real reply", async () => {
			const llm = fauxModel(fauxAssistantMessage("Responding after the empty assistant turn."));
			await testEmptyAssistantMessage(llm);
		});

		it("fails end to end when the conversation with an empty assistant message yields no content", async () => {
			const llm = fauxModel(fauxAssistantMessage([], { stopReason: "stop" }));
			await expect(testEmptyAssistantMessage(llm)).rejects.toThrow();
		});
	});
});
