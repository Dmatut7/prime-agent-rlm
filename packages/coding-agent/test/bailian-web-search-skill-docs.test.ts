import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const skillDir = join(import.meta.dirname, "..", "skills", "bailian-web-search");
const skillDoc = readFileSync(join(skillDir, "SKILL.md"), "utf8");

// The model copies the SKILL.md examples verbatim, so every name and calling form in
// them has to exist in the module the kernel binds.
describe("bailian-web-search SKILL.md", () => {
	it("calls the module by the name the kernel binds", () => {
		expect(skillDoc).toContain("bailian_web_search.search(");
		expect(skillDoc).not.toMatch(/(^|[^_])bailian_search\.search\(/m);
	});

	it("returns an answer that works both awaited and as a plain str", () => {
		// Every other kernel skill is awaited, so models await this one too; the
		// answer must survive that instead of raising and losing a 15-90s search.
		const probe = execFileSync(
			"python3",
			[
				"-c",
				[
					"import asyncio, json, sys",
					"sys.path.insert(0, sys.argv[1])",
					"from bailian_web_search.bailian_search import SearchAnswer",
					"a = SearchAnswer('answer text')",
					"async def main():",
					"    return await a",
					"r = asyncio.run(main())",
					"print(type(r).__name__, r == 'answer text', isinstance(a, str), json.dumps(a))",
				].join("\n"),
				join(skillDir, "src"),
			],
			{ encoding: "utf8" },
		).trim();
		expect(probe).toBe('str True True "answer text"');
	});
});
