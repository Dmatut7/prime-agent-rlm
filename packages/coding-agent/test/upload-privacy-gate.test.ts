import { describe, expect, it } from "vitest";
import { applyUploadPrivacyGate, REDACTED_SECRET_MARKER, stripUrlUserinfo } from "../src/core/upload-privacy-gate.js";

/** One configured credential, in the shape the gate receives from the session's own storage. */
const CONFIGURED = { value: "tok+/=abc", source: "env R15_GATE_TEST_TOKEN" };

function percentOf(value: string): string {
	return encodeURIComponent(value);
}

describe("upload privacy gate: URL userinfo", () => {
	it("removes a userinfo block whole when the password contains an at sign", () => {
		const line = "git clone https://user:p@ssw0rd@github.com/org/private-repo.git done";
		const result = stripUrlUserinfo(line);
		// The whole `user:p@ssw0rd@` block goes: a fragment of the password left in place is the
		// leak this check exists to remove, and the count below is the audit's only witness.
		expect(result.value).toBe("git clone https://github.com/org/private-repo.git done");
		expect(result.stripped).toBe(1);
	});

	it("leaves no password fragment behind in the header or the body, and counts the removal", () => {
		const remote = "https://user:p@ssw0rd@github.com/acme/private-repo.git";
		const gate = applyUploadPrivacyGate({
			headers: { "X-Git-Repo": remote },
			body: `remote: ${remote}\n`,
			secretValues: [],
		});
		expect(gate.headers["X-Git-Repo"]).toBe("https://github.com/acme/private-repo.git");
		expect(gate.headersWithoutUserinfo).toEqual(["X-Git-Repo"]);
		expect(gate.bodyUserinfoCount).toBe(1);
		for (const leaked of ["p@ssw0rd", "ssw0rd", "user:"]) {
			expect(gate.body).not.toContain(leaked);
			expect(JSON.stringify(gate.headers)).not.toContain(leaked);
		}
		// Positive control: the fact the trace is uploaded for - the repository - survives.
		expect(gate.body).toContain("https://github.com/acme/private-repo.git");
	});

	it("keeps a plain account name at the host intact", () => {
		for (const line of [
			"git remote add origin ssh://git@github.com/org/repo.git",
			"psql postgres://user@localhost:5432/app",
			"scp git@github.com:org/repo.git",
			"https://github.com/org/repo@v1.0",
		]) {
			const result = stripUrlUserinfo(line);
			expect(result.value).toBe(line);
			expect(result.stripped).toBe(0);
		}
	});

	it("still strips a bare token used as the username", () => {
		const token = "ghp_R15GateToken0123456789";
		const result = stripUrlUserinfo(`origin https://${token}@github.com/acme/private-repo.git`);
		expect(result.stripped).toBe(1);
		expect(result.value).toBe("origin https://github.com/acme/private-repo.git");
		expect(result.value).not.toContain(token);
	});

	it("still strips a random-looking username that names no account", () => {
		const token = "aB3xY9zQ2wE5rT8uI1oP4kL7";
		const result = stripUrlUserinfo(`https://${token}@objects.example.test/bucket/key`);
		expect(result.stripped).toBe(1);
		expect(result.value).toBe("https://objects.example.test/bucket/key");
	});
});

describe("upload privacy gate: encoded credential forms", () => {
	it("redacts a percent-encoded form of a configured value", () => {
		const encoded = percentOf(CONFIGURED.value);
		expect(encoded).toBe("tok%2B%2F%3Dabc");
		// Upper-case hex is what `encodeURIComponent` produces; lower-case hex is what a hand-written
		// or non-JS encoder produces, and it is the same secret.
		for (const form of [encoded, "tok%2b%2f%3dabc"]) {
			const gate = applyUploadPrivacyGate({
				headers: {},
				body: `GET /v1/models?key=${form} HTTP/1.1`,
				secretValues: [CONFIGURED],
			});
			expect(gate.body).toBe(`GET /v1/models?key=${REDACTED_SECRET_MARKER} HTTP/1.1`);
			expect(gate.redactedValues).toBe(1);
		}
	});

	it("redacts a base64 form of a configured value", () => {
		const base64 = Buffer.from(CONFIGURED.value, "utf8").toString("base64");
		const gate = applyUploadPrivacyGate({
			headers: { "X-Note": `payload=${base64}` },
			body: `Authorization payload ${base64}`,
			secretValues: [CONFIGURED],
		});
		expect(gate.headers["X-Note"]).not.toContain(base64);
		expect(gate.body).not.toContain(base64);
		expect(gate.redactedValues).toBe(2);
		expect(gate.redactedTypes).toEqual(["Configured credential"]);
	});

	it("counts every occurrence when one value appears raw and encoded", () => {
		const gate = applyUploadPrivacyGate({
			headers: {},
			body: `raw=${CONFIGURED.value} encoded=${percentOf(CONFIGURED.value)}`,
			secretValues: [CONFIGURED],
		});
		expect(gate.body).toBe(`raw=${REDACTED_SECRET_MARKER} encoded=${REDACTED_SECRET_MARKER}`);
		expect(gate.redactedValues).toBe(2);
	});

	it("leaves an unrelated encoded value alone", () => {
		const gate = applyUploadPrivacyGate({
			headers: {},
			body: "filter=zzz%2B%2F%3Dqqq",
			secretValues: [CONFIGURED],
		});
		expect(gate.body).toBe("filter=zzz%2B%2F%3Dqqq");
		expect(gate.redactedValues).toBe(0);
	});
});
