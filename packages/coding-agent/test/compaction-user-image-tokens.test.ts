import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/index.js";

describe("estimateTokens counts user images (scan2 C7)", () => {
	it("includes image blocks in user message estimates", () => {
		const textOnly = estimateTokens({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		const withImage = estimateTokens({
			role: "user",
			content: [
				{ type: "text", text: "hi" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
			],
			timestamp: 1,
		});
		expect(withImage).toBeGreaterThanOrEqual(textOnly + 1200);
	});
});
