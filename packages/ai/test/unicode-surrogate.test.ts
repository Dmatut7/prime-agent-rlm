import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import { complete, streamSimple } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions, ToolResultMessage, Usage } from "../src/types.js";
import { sanitizeSurrogates } from "../src/utils/sanitize-unicode.js";
import { getKimiCodingTestModel } from "./kimi-test-model.js";
import { getZaiTestModel } from "./zai-test-model.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";

const emptySchema = Type.Object({});

const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool1" : "test_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "linkedin1" : "linkedin_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool2" : "test_2";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Unicode Handling", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, azureOptions);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm, azureOptions);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe("Anthropic OAuth Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testRealWorldLinkedInData(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testUnpairedHighSurrogate(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Unicode Handling", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Unicode Handling", () => {
		const llm = getModel("xai", "grok-4.3");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Unicode Handling", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Unicode Handling", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider Unicode Handling", () => {
		const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Unicode Handling", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Unicode Handling", () => {
		const llm = getZaiTestModel({ toolStream: true });

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Unicode Handling", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Unicode Handling", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider Unicode Handling", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it("should handle unpaired high surrogate (0xD83D) in tool results", {
				retry: 3,
				timeout: 30000,
			}, async () => {
				await testUnpairedHighSurrogate(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it("should handle unpaired high surrogate (0xD83D) in tool results", {
				retry: 3,
				timeout: 30000,
			}, async () => {
				await testUnpairedHighSurrogate(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it("should handle unpaired high surrogate (0xD83D) in tool results", {
				retry: 3,
				timeout: 30000,
			}, async () => {
				await testUnpairedHighSurrogate(llm);
			});
		},
	);

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Unicode Handling", () => {
		const llm = getKimiCodingTestModel();

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Unicode Handling", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Unicode Handling", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe("OpenAI Codex Provider Unicode Handling", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmojiInToolResults(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testRealWorldLinkedInData(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testUnpairedHighSurrogate(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});

// ---------------------------------------------------------------------------
// T9: thinking blocks whose text was modified by sanitizeSurrogates must not be
// replayed with the original signature. Anthropic and Bedrock bind the
// signature to the thinking text; sending sanitized text with the stale
// signature fails with a non-retryable 400 invalid_request error on every
// replay. The providers degrade such blocks to plain text (dropping the
// signature on the wire only), matching the existing missing-signature
// fallback. The persisted context keeps the original signature.
// ---------------------------------------------------------------------------

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeThinkingReplayContext(model: Model<Api>, thinkingText: string, signature: string): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: thinkingText, thinkingSignature: signature },
			{ type: "text", text: "answer" },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: Date.now() },
			assistant,
			{ role: "user", content: "Continue", timestamp: Date.now() },
		],
	};
}

async function captureAnthropicMessages(model: Model<"anthropic-messages">, context: Context): Promise<MessageParam[]> {
	let captured: MessageParam[] | undefined;
	const captureModel: Model<"anthropic-messages"> = { ...model, baseUrl: "http://127.0.0.1:9" };
	const s = streamSimple(captureModel, context, {
		apiKey: "fake-key",
		maxRetries: 0,
		onPayload: (payload) => {
			captured = (payload as { messages: MessageParam[] }).messages;
			return payload;
		},
	});
	await s.result();
	if (!captured) {
		throw new Error("Expected Anthropic payload to be captured before request failure");
	}
	return captured;
}

interface BedrockCapturedMessage {
	role?: string;
	content?: Array<{
		text?: string;
		reasoningContent?: { reasoningText?: { text: string; signature?: string } };
	}>;
}

async function captureBedrockMessages(
	model: Model<"bedrock-converse-stream">,
	context: Context,
): Promise<BedrockCapturedMessage[]> {
	let captured: BedrockCapturedMessage[] | undefined;
	const s = streamBedrock(model, context, {
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			captured = (payload as { messages: BedrockCapturedMessage[] }).messages;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	if (!captured) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}
	return captured;
}

describe("Thinking signature after surrogate sanitization (T9)", () => {
	// Capability gate: sanitizeSurrogates only strips UNPAIRED surrogates.
	// Well-formed text passes through byte-identical, so the "text changed ->
	// drop signature" degrade can never trigger on clean traffic.
	const wellFormed: Array<[string, string]> = [
		["paired emoji", "Monkey 🙈 thumbs 👍 face 🤔 rocket 🚀"],
		["emoji with variation selectors", "heart ❤️ plane ✈️"],
		["CJK", "你好，世界 こんにちは"],
		["combining sequences", "café ñ and flags 🇩🇪"],
		["ZWJ sequences", "family 👨‍👩‍👧‍👦 flag 🏳️‍🌈"],
	];
	for (const [label, text] of wellFormed) {
		it(`sanitizeSurrogates is identity on ${label}`, () => {
			expect(sanitizeSurrogates(text)).toBe(text);
		});
	}

	it("anthropic replays clean thinking with its signature byte-identical", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const thinking = "Step by step reasoning 🙈 你好 café";
		const context = makeThinkingReplayContext(model, thinking, "sig-clean");
		const messages = await captureAnthropicMessages(model, context);

		const assistant = messages.find((m) => m.role === "assistant");
		const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
		expect(blocks[0]).toEqual({ type: "thinking", thinking, signature: "sig-clean" });
		// Wire-only concern: the persisted context keeps the original signature.
		expect((context.messages[1] as AssistantMessage).content[0]).toMatchObject({
			type: "thinking",
			thinking,
			thinkingSignature: "sig-clean",
		});
	});

	it("anthropic degrades thinking to plain text when sanitization modified it", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const unpaired = String.fromCharCode(0xd83d); // isolated high surrogate
		const thinking = `reasoning ${unpaired} with stray surrogate`;
		const sanitized = sanitizeSurrogates(thinking);
		expect(sanitized).not.toBe(thinking);
		const context = makeThinkingReplayContext(model, thinking, "sig-stale");
		const messages = await captureAnthropicMessages(model, context);

		const assistant = messages.find((m) => m.role === "assistant");
		const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
		// Degraded to plain text; the stale signature must not be sent.
		expect(blocks[0]).toEqual({ type: "text", text: sanitized });
		expect(blocks.some((b) => b.type === "thinking")).toBe(false);
		expect(JSON.stringify(blocks)).not.toContain("sig-stale");
		// The persisted context still holds the original signature, so a future
		// provider that accepts it can still use it.
		expect((context.messages[1] as AssistantMessage).content[0]).toMatchObject({
			type: "thinking",
			thinking,
			thinkingSignature: "sig-stale",
		});
	});

	it("bedrock replays clean thinking with its signature byte-identical", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const thinking = "Step by step reasoning 🙈 你好 café";
		const context = makeThinkingReplayContext(model, thinking, "sig-clean");
		const messages = await captureBedrockMessages(model, context);

		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.content?.[0]).toEqual({
			reasoningContent: { reasoningText: { text: thinking, signature: "sig-clean" } },
		});
	});

	it("bedrock degrades thinking to plain text when sanitization modified it", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const unpaired = String.fromCharCode(0xd83d); // isolated high surrogate
		const thinking = `reasoning ${unpaired} with stray surrogate`;
		const sanitized = sanitizeSurrogates(thinking);
		expect(sanitized).not.toBe(thinking);
		const context = makeThinkingReplayContext(model, thinking, "sig-stale");
		const messages = await captureBedrockMessages(model, context);

		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.content?.[0]).toEqual({ text: sanitized });
		expect(JSON.stringify(assistant?.content)).not.toContain("sig-stale");
		expect((context.messages[1] as AssistantMessage).content[0]).toMatchObject({
			type: "thinking",
			thinking,
			thinkingSignature: "sig-stale",
		});
	});
});
