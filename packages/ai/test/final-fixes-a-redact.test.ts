import { describe, expect, test } from "vitest";
import { REDACTED, redactSecrets } from "../src/utils/redact.js";

// The live bailian key looks like `sk-ws-H.<random>`: the dot is part of the key.
const DOT_KEY = `${"sk-"}${"ws-H."}${"PIPELINEDOTKEY"}${"x".repeat(16)}1234`;
const PLAIN_KEY = `${"sk-"}${"ant-FAKE"}${"0".repeat(20)}`;

describe("redactSecrets with a dotted sk- key", () => {
	test("removes a dotted key that nothing names", () => {
		const redacted = redactSecrets(`provider said the key ${DOT_KEY} was rejected (request_id req_7)`);
		expect(redacted).not.toContain(DOT_KEY);
		expect(redacted).toContain(REDACTED);
		expect(redacted).toContain("req_7");
	});

	test("still removes an undotted key and leaves an ordinary hyphenated word alone", () => {
		expect(redactSecrets(`bad key ${PLAIN_KEY}`)).not.toContain(PLAIN_KEY);
		const ordinary = "task-abcdefghijklmnopqrstuvwxyz and risk-adjusted-return-calculation";
		expect(redactSecrets(ordinary)).toBe(ordinary);
	});
});
