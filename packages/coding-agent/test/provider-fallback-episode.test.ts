import { describe, expect, it } from "vitest";
import {
	describeProviderFailureCause,
	isInputContentInspectionRejection,
	isWithheldToolResult,
	PROVIDER_FALLBACK_ENTRY_TYPE,
	type ProviderFallbackEntryData,
	readPersistedFallbackEpisode,
	readPersistedLongWait,
	withheldToolResult,
} from "../src/core/provider-fallback.js";

type Entry = { type: string; customType?: string; data?: unknown; message?: unknown };

const modelChange = (): Entry => ({ type: "model_change" });
const record = (data: ProviderFallbackEntryData): Entry => ({
	type: "custom",
	customType: PROVIDER_FALLBACK_ENTRY_TYPE,
	data,
});
const switched = (from: string, to: string, at: number, extra: Partial<ProviderFallbackEntryData> = {}): Entry[] => [
	modelChange(),
	record({ kind: "switch", at, from, to, ...extra }),
];
const assistant = (stopReason: string): Entry => ({ type: "message", message: { role: "assistant", stopReason } });

describe("readPersistedFallbackEpisode", () => {
	it("rebuilds a two-step episode with its primary, tried models and last switch time", () => {
		const entries = [
			modelChange(),
			...switched("p/primary", "p/kimi", 100, { thinkingLevel: "high" }),
			...switched("p/kimi", "p/qwen", 200, { primary: "p/primary", thinkingLevel: "high", serviceTier: "flex" }),
			assistant("stop"),
		];
		expect(readPersistedFallbackEpisode(entries)).toEqual({
			primary: "p/primary",
			current: "p/qwen",
			switchedAtMs: 200,
			tried: ["p/kimi", "p/qwen"],
			thinkingLevel: "high",
			serviceTier: "flex",
		});
	});

	it("returns to the model before a backup retry, not to the backup", () => {
		const entries = [modelChange(), modelChange(), ...switched("p/backup", "p/qwen", 100, { primary: "p/primary" })];
		expect(readPersistedFallbackEpisode(entries)?.primary).toBe("p/primary");
	});

	it("has no episode once the model changed after the last switch, or after a return", () => {
		expect(readPersistedFallbackEpisode([...switched("p/primary", "p/kimi", 100), modelChange()])).toBeUndefined();
		expect(
			readPersistedFallbackEpisode([
				...switched("p/primary", "p/kimi", 100),
				modelChange(),
				record({ kind: "return", at: 200, from: "p/kimi", to: "p/primary" }),
			]),
		).toBeUndefined();
	});

	it("starts a new episode at an owner pick between two switches", () => {
		const entries = [...switched("p/primary", "p/kimi", 100), modelChange(), ...switched("p/picked", "p/glm", 300)];
		expect(readPersistedFallbackEpisode(entries)).toMatchObject({ primary: "p/picked", tried: ["p/glm"] });
	});

	it("ignores image-scope switches, which move only one run's routed model", () => {
		const entries = [
			...switched("p/primary", "p/kimi", 100),
			record({ kind: "switch", scope: "image", at: 150, from: "p/vision", to: "p/qwen-vl" }),
		];
		expect(readPersistedFallbackEpisode(entries)).toMatchObject({ primary: "p/primary", current: "p/kimi" });
		expect(
			readPersistedFallbackEpisode([
				modelChange(),
				record({ kind: "switch", scope: "image", at: 150, from: "p/vision", to: "p/qwen-vl" }),
			]),
		).toBeUndefined();
	});
});

describe("readPersistedLongWait", () => {
	const longWait = (round: number, jobId?: string): Entry =>
		record({ kind: "long_wait", at: round, round, delayMs: 1, ...(jobId ? { jobId } : {}) });

	it("keeps the round and its wake across a restart until an answer lands", () => {
		expect(readPersistedLongWait([longWait(1), assistant("error"), longWait(2, "job-2")])).toEqual({
			round: 2,
			jobId: "job-2",
		});
		expect(readPersistedLongWait([longWait(2, "job-2"), assistant("stop")])).toEqual({ round: 0 });
		expect(readPersistedLongWait([])).toEqual({ round: 0 });
	});
});

describe("content inspection", () => {
	it("tells an input rejection from an output one", () => {
		expect(
			isInputContentInspectionRejection(
				'400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}',
			),
		).toBe(true);
		expect(
			isInputContentInspectionRejection(
				"<400> InternalError.Algo.DataInspectionFailed: Output data may contain inappropriate content.",
			),
		).toBe(false);
		expect(isInputContentInspectionRejection("400 invalid_parameter_error")).toBe(false);
		expect(describeProviderFailureCause("bailian", "400 data_inspection_failed: Input text", "permanent")).toBe(
			"百炼内容审核拒绝了请求",
		);
	});

	it("withholds a tool result's text and keeps its pairing", () => {
		const withheld = withheldToolResult({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "raw scan output" }],
			isError: false,
			timestamp: 1,
		});
		expect(withheld).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false });
		expect(isWithheldToolResult(withheld)).toBe(true);
		const text = withheld.content[0]?.type === "text" ? withheld.content[0].text : "";
		expect(text).toContain("15 characters");
		expect(text).toContain("narrower");
	});
});
