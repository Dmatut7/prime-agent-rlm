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

	it("never awaits the synchronous search function directly", () => {
		expect(skillDoc).not.toMatch(/await\s+bailian_web_search\.search\(/);
		const probe = execFileSync(
			"python3",
			[
				"-c",
				"import inspect, sys; sys.path.insert(0, sys.argv[1]); import bailian_web_search as m; print(inspect.iscoroutinefunction(m.search))",
				join(skillDir, "src"),
			],
			{ encoding: "utf8" },
		).trim();
		expect(probe).toBe("False");
	});
});
