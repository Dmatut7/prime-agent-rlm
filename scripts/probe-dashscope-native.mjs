#!/usr/bin/env node
/**
 * DashScope native protocol probe (plan step 7).
 *
 * Reads the API key and the aliyun-maas model list from ~/.prime/agent/models.json
 * (read-only; models.json is never modified by this script), then fires one
 * minimal chat request per (model x endpoint) over the native protocol:
 *   POST {baseUrl}/services/aigc/{text-generation|multimodal-generation}/generation
 * with parameters.result_format="message" and a "Say OK" user turn, non-streaming
 * (no X-DashScope-SSE header) so a pure status/JSON check is enough.
 *
 * Output: a 13x2 status matrix (and routed-endpoint verdict per model), printed
 * to stdout and appended to .pipeline/dashscope-native/03-probe-output.txt.
 *
 * Run: node scripts/probe-dashscope-native.mjs [--baseUrl <url>] [--model <id>]...
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
function argValue(name) {
	const idx = argv.indexOf(name);
	return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : undefined;
}
const explicitModels = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--model" && argv[i + 1]) explicitModels.push(argv[++i]);
}

const modelsJsonPath = join(homedir(), ".prime", "agent", "models.json");
if (!existsSync(modelsJsonPath)) {
	console.error(`models.json not found: ${modelsJsonPath}`);
	process.exit(1);
}
const config = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
const provider = config.providers?.["aliyun-maas"];
if (!provider) {
	console.error("providers.aliyun-maas missing from models.json");
	process.exit(1);
}
const apiKey = provider.apiKey || process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
	console.error("No API key: providers.aliyun-maas.apiKey or DASHSCOPE_API_KEY");
	process.exit(1);
}

// Native base url derives from the compatible-mode url the config carries
// (…/compatible-mode/v1 → …/api/v1) unless overridden.
const compatBase = provider.baseUrl || "";
const derivedBase = compatBase.replace(/\/compatible-mode\/v1\/?$/, "/api/v1");
const baseUrl = (argValue("--baseUrl") || derivedBase).replace(/\/+$/, "");

const models = explicitModels.length > 0 ? explicitModels : (provider.models || []).map((m) => m.id);
if (models.length === 0) {
	console.error("No models found under providers.aliyun-maas.models");
	process.exit(1);
}

const TEXT_PATH = "/services/aigc/text-generation/generation";
const MM_PATH = "/services/aigc/multimodal-generation/generation";

// Multimodal-class routing table copied from packages/ai/src/providers/dashscope.ts
// (DEFAULT_MULTIMODAL_MODEL_IDS + prefixes).
const DEFAULT_MULTIMODAL_IDS = new Set([
	"qwen3.8-max",
	"qwen3.8-flash",
	"qwen3.8-max-0902",
	"qwen3.8-27b",
	"qwen3.8-omni-flash",
	"deepseek-v4.1-flash",
	"kimi-k3",
	"kimi-k2.7-code",
]);
const MM_PREFIXES = ["qwen3.8-", "qwen3-vl-", "qwen3.7-plus", "qwen3.5-"];
function isMultimodalClass(id) {
	if (process.env.PRIME_DASHSCOPE_TEXT_MODELS?.split(",").map((s) => s.trim()).includes(id)) return false;
	const override = process.env.PRIME_DASHSCOPE_MULTIMODAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
	if (override && override.length > 0) return override.includes(id);
	return DEFAULT_MULTIMODAL_IDS.has(id) || MM_PREFIXES.some((p) => id.startsWith(p));
}

function buildBody(modelId, multimodal) {
	const content = multimodal ? [{ text: "Say OK" }] : "Say OK";
	return {
		model: modelId,
		input: { messages: [{ role: "user", content }] },
		parameters: { result_format: "message", max_completion_tokens: 16 },
	};
}

async function probe(modelId, path) {
	const url = baseUrl + path;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(buildBody(modelId, path === MM_PATH)),
			signal: controller.signal,
		});
		let code = "";
		let message = "";
		let finishReason = "";
		let contentSample = "";
		try {
			const parsed = await response.json();
			code = typeof parsed.code === "string" ? parsed.code : "";
			message = typeof parsed.message === "string" ? parsed.message : "";
			const choice = parsed?.output?.choices?.[0];
			finishReason = choice?.finish_reason ?? "";
			const content = choice?.message?.content;
			contentSample =
				typeof content === "string"
					? content.slice(0, 40)
					: Array.isArray(content)
						? String(content[0]?.text ?? "").slice(0, 40)
						: "";
		} catch {
			// non-JSON body
		}
		return { status: response.status, code, message, finishReason, contentSample };
	} catch (error) {
		return { status: 0, code: "network", message: String(error?.message ?? error), finishReason: "", contentSample: "" };
	} finally {
		clearTimeout(timer);
	}
}

const lines = [];
const stamp = new Date().toISOString();
lines.push(`# probe-dashscope-native @ ${stamp}`);
lines.push(`baseUrl=${baseUrl} models=${models.length} (from ${modelsJsonPath})`);
lines.push("");
lines.push("| model | text-gen | multimodal-gen | routed | verdict |");
lines.push("|---|---|---|---|---|");

let mismatches = 0;
for (const modelId of models) {
	const [text, mm] = await Promise.all([probe(modelId, TEXT_PATH), probe(modelId, MM_PATH)]);
	const routed = isMultimodalClass(modelId) ? "multimodal" : "text";
	const routedResult = routed === "multimodal" ? mm : text;
	const otherResult = routed === "multimodal" ? text : mm;
	// A routed endpoint verdict is OK on 200, or a soft-fail when the *other*
	// endpoint is 200 and the routed one is not (routing table wrong).
	let verdict;
	if (routedResult.status === 200) {
		verdict = "OK";
	} else if (otherResult.status === 200) {
		verdict = `ROUTE-MISMATCH (should be ${routed === "multimodal" ? "text" : "multimodal"})`;
		mismatches += 1;
	} else {
		verdict = `FAIL routed=${routedResult.status}${routedResult.code ? `/${routedResult.code}` : ""}`;
	}
	const cell = (r) => (r.status === 200 ? `**200**${r.finishReason ? ` (${r.finishReason})` : ""}` : `${r.status}${r.code ? ` ${r.code}` : ""}`);
	lines.push(`| ${modelId} | ${cell(text)} | ${cell(mm)} | ${routed} | ${verdict} |`);
	console.log(lines[lines.length - 1]);
}

lines.push("");
lines.push(`mismatches=${mismatches} (models whose hardcoded class disagrees with the probe)`);
lines.push("");
console.log(`mismatches=${mismatches}`);

const outPath = resolve(join(dirname(process.argv[1] ?? "."), "..", ".pipeline", "dashscope-native", "03-probe-output.txt"));
try {
	mkdirSync(dirname(outPath), { recursive: true });
	appendFileSync(outPath, `${lines.join("\n")}\n\n`);
	console.log(`appended: ${outPath}`);
} catch (error) {
	console.error(`could not write ${outPath}: ${error?.message ?? error}`);
}
