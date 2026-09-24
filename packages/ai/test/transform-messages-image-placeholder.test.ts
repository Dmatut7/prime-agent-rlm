import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { Message, Model } from "../src/types.js";

const textOnly: Model<"openai-completions"> = {
	id: "glm-fixture",
	name: "GLM fixture",
	api: "openai-completions",
	provider: "bailian",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const image = { type: "image" as const, mimeType: "image/png", data: "aGk=" };

/**
 * A turn with an image can be served by an image model and continued by a text-only one.
 * The text-only model must not read the placeholder as "nobody saw this image": it once
 * disowned the image model's correct description and stored that as a lesson.
 */
describe("image placeholder for a text-only model", () => {
	it("says the image was not shown to this model and who wrote a reply describing it", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "这线路好吗" }, image], timestamp: 1 },
		];
		const [user] = transformMessages(messages, textOnly);
		const content = user?.role === "user" && Array.isArray(user.content) ? user.content : [];
		expect(content.some((block) => block.type === "image")).toBe(false);
		const placeholder = content.find((block) => block.type === "text" && block.text.startsWith("(image"));
		expect(placeholder).toMatchObject({ type: "text" });
		const text = placeholder?.type === "text" ? placeholder.text : "";
		expect(text).toContain("not shown to this model");
		expect(text).toContain("an image-capable model that did see it wrote that reply");
		// A detail the description left out is not a dead end: the file can be looked at again.
		expect(text).toContain("the conversation gives the image's file path");
		expect(text).not.toContain("omitted");
	});

	it("keeps images for a model that takes them", () => {
		const messages: Message[] = [{ role: "user", content: [image], timestamp: 1 }];
		const [user] = transformMessages(messages, { ...textOnly, input: ["text", "image"] });
		expect(user?.role === "user" && Array.isArray(user.content) && user.content[0]?.type).toBe("image");
	});
});
