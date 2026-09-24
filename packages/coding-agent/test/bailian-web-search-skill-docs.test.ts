import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Runs a probe against the skill module with a throwaway agent dir holding the given config files. */
function keyProbe(files: { models?: unknown; auth?: unknown }, env: Record<string, string> = {}): string {
	const agentDir = mkdtempSync(join(tmpdir(), "bailian-key-"));
	try {
		if (files.models) writeFileSync(join(agentDir, "models.json"), JSON.stringify(files.models));
		if (files.auth) writeFileSync(join(agentDir, "auth.json"), JSON.stringify(files.auth));
		const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PRIME_AGENT_CODING_AGENT_DIR: agentDir };
		delete childEnv.DASHSCOPE_API_KEY;
		delete childEnv.PI_CODING_AGENT_DIR;
		return execFileSync(
			"python3",
			[
				"-c",
				[
					"import json, sys",
					"sys.path.insert(0, sys.argv[1])",
					"from bailian_web_search import bailian_search as bs",
					"key, problems = bs._find_api_key()",
					"print(json.dumps([key, problems]))",
				].join("\n"),
				join(skillDir, "src"),
			],
			{ encoding: "utf8", env: childEnv },
		).trim();
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

// prime-agent resolves provider keys with resolve-config-value.ts; a key that works for the chat
// model must work for search too, or the owner's `!cat ~/.prime/agent/bailian.key` setup sends the
// command text as the bearer token.
describe("bailian-web-search key resolution", () => {
	const bailian = (apiKey: string) => ({ providers: { bailian: { apiKey } } });

	it("runs a !command and uses its output", () => {
		expect(JSON.parse(keyProbe({ models: bailian("!printf ' sk-from-command\\n'") }))).toEqual([
			"sk-from-command",
			[],
		]);
	});

	it("reads a named environment variable, and treats an unset name as the literal key", () => {
		expect(JSON.parse(keyProbe({ models: bailian("MY_BAILIAN_KEY") }, { MY_BAILIAN_KEY: "sk-from-env" }))).toEqual([
			"sk-from-env",
			[],
		]);
		expect(JSON.parse(keyProbe({ models: bailian("sk-literal") }))).toEqual(["sk-literal", []]);
	});

	it("falls through to auth.json when the models.json command fails, and says why", () => {
		const [key, problems] = JSON.parse(
			keyProbe({ models: bailian("!exit 3"), auth: { bailian: { type: "api_key", key: "!echo sk-from-auth" } } }),
		) as [string, string[]];
		expect(key).toBe("sk-from-auth");
		expect(problems).toEqual([
			"models.json providers.bailian.apiKey: command `!exit ...` exited 3 with no key on stdout",
		]);
	});

	it("never sends an empty env var's name as the key", () => {
		const [key, problems] = JSON.parse(keyProbe({ models: bailian("MY_BAILIAN_KEY") }, { MY_BAILIAN_KEY: "" })) as [
			string,
			string[],
		];
		expect(key).toBe("");
		expect(problems[0]).toContain("environment variable MY_BAILIAN_KEY is empty");
	});
});

/** A probe with urlopen faked to answer `content`; prints what the given python lines print. */
function answerProbe(content: string | null, lines: string[]): string {
	return execFileSync(
		"python3",
		[
			"-c",
			[
				"import asyncio, io, json, sys, threading, urllib.request",
				"sys.path.insert(0, sys.argv[1])",
				"import bailian_web_search",
				"from bailian_web_search import bailian_search as bs",
				"bs._resolve_api_key = lambda: 'test-key'",
				"seen = {}",
				"class R(io.BytesIO):",
				"    def __enter__(self): return self",
				"    def __exit__(self, *a): return False",
				"def fake(req, timeout=None):",
				"    seen['thread'] = threading.current_thread() is threading.main_thread()",
				`    return R(json.dumps({'choices': [{'message': {'content': ${content === null ? "None" : JSON.stringify(content)}}, 'finish_reason': 'stop'}]}).encode())`,
				"urllib.request.urlopen = fake",
				...lines,
			].join("\n"),
			join(skillDir, "src"),
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

describe("bailian-web-search answers", () => {
	it("explains an empty answer instead of returning an empty string", () => {
		// An empty string reads like "the web has nothing on this"; the model then gives up or guesses.
		const out = answerProbe("", ["print(bs.search('香港 CN2 GIA'))"]);
		expect(out).toContain("bailian_web_search found no answer for '香港 CN2 GIA'");
		expect(out).toContain("finish_reason='stop'");
		expect(answerProbe(null, ["print(bs.search('q'))"])).toContain("found no answer");
	});

	it("asearch runs the request off the kernel's thread and returns the same text", () => {
		const out = answerProbe("the answer", [
			"async def main():",
			"    return await bailian_web_search.asearch('q', strategy='lite')",
			"r = asyncio.run(main())",
			"print(json.dumps([r, seen['thread']]))",
		]);
		expect(JSON.parse(out)).toEqual(["the answer", false]);
	});

	it("says so on stderr when the sync call held the event loop", () => {
		const probe = spawnSync(
			"python3",
			[
				"-c",
				[
					"import asyncio, io, json, sys, urllib.request",
					"sys.path.insert(0, sys.argv[1])",
					"from bailian_web_search import bailian_search as bs",
					"bs._resolve_api_key = lambda: 'test-key'",
					"class R(io.BytesIO):",
					"    def __enter__(self): return self",
					"    def __exit__(self, *a): return False",
					"urllib.request.urlopen = lambda req, timeout=None: R(json.dumps({'choices': [{'message': {'content': 'ok'}}]}).encode())",
					"async def main():",
					"    return bs.search('q')",
					"print(asyncio.run(main()))",
					"bs.search('outside a loop')",
				].join("\n"),
				join(skillDir, "src"),
			],
			{ encoding: "utf8" },
		);
		expect(probe.stdout.trim()).toBe("ok");
		const notes = probe.stderr.split("\n").filter((line) => line.includes("held the kernel's event loop"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("await bailian_web_search.asearch(...)");
	});
});
