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
	it("keeps the search model's reasoning off by default", () => {
		// Measured 2026-09-24: with reasoning on, a news query spent ~4.7k reasoning
		// tokens and 91s for the answer it gives in 21s without.
		const probe = execFileSync(
			"python3",
			[
				"-c",
				[
					"import io, json, sys, urllib.request",
					"sys.path.insert(0, sys.argv[1])",
					"from bailian_web_search import bailian_search as bs",
					"bs._resolve_api_key = lambda: 'test-key'",
					"sent = {}",
					"class R(io.BytesIO):",
					"    def __enter__(self): return self",
					"    def __exit__(self, *a): return False",
					"def fake(req, timeout=None):",
					"    sent.update(json.loads(req.data)); sent['timeout'] = timeout",
					"    return R(json.dumps({'choices': [{'message': {'content': 'ok'}}]}).encode())",
					"urllib.request.urlopen = fake",
					"bs.search('q')",
					"print(sent['enable_thinking'], sent['timeout'])",
				].join("\n"),
				join(skillDir, "src"),
			],
			{ encoding: "utf8" },
		).trim();
		expect(probe).toBe("False 240");
	});
});
