import { createHash } from "crypto";
import { describe, expect, test } from "vitest";
import {
	classifyUpdateSpec,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	verifyUpdateArtifactHash,
} from "../src/config.js";

const TRUSTED_BASE = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const PINNED_SHA = "a".repeat(64);

function trustedSpec(path: string, sha = PINNED_SHA): string {
	return `${TRUSTED_BASE}/releases/v0.9.1/${path}#sha256=${sha}`;
}

describe("self-update spec trust policy", () => {
	test("registry package specs stay installable", () => {
		expect(classifyUpdateSpec("prime-agent")).toMatchObject({ kind: "registry", packageName: "prime-agent" });
		expect(classifyUpdateSpec("@earendil-works/pi-coding-agent")).toMatchObject({
			kind: "registry",
			packageName: "@earendil-works/pi-coding-agent",
		});
		expect(classifyUpdateSpec("prime-agent@0.9.1")).toMatchObject({
			kind: "registry",
			packageName: "prime-agent",
		});
	});

	test("an arbitrary absolute URL is refused", () => {
		const classification = classifyUpdateSpec("https://evil.example/prime-agent-0.9.1.tgz");
		expect(classification.kind).toBe("rejected");
		expect(classification).toMatchObject({ reason: "untrusted_artifact_source" });
		expect(getSelfUpdateUnavailableInstruction("prime-agent", undefined, "https://evil.example/x.tgz")).toContain(
			"Refusing to self-update",
		);
	});

	test("a lookalike host of the trusted download base is refused", () => {
		expect(
			classifyUpdateSpec(
				`https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev.evil.example/x.tgz#sha256=${PINNED_SHA}`,
			),
		).toMatchObject({ kind: "rejected", reason: "untrusted_artifact_source" });
	});

	test("a trusted URL without a pinned sha256 is refused", () => {
		expect(classifyUpdateSpec(`${TRUSTED_BASE}/releases/v0.9.1/prime-agent-0.9.1.tgz`)).toMatchObject({
			kind: "rejected",
			reason: "missing_artifact_hash",
		});
		expect(classifyUpdateSpec(`${TRUSTED_BASE}/releases/v0.9.1/prime-agent-0.9.1.tgz#sha256=deadbeef`)).toMatchObject(
			{
				kind: "rejected",
				reason: "missing_artifact_hash",
			},
		);
	});

	test("a trusted, hash-pinned URL is recognized as an artifact to verify", () => {
		const classification = classifyUpdateSpec(trustedSpec("prime-agent-0.9.1.tgz"));
		expect(classification).toMatchObject({
			kind: "artifact",
			url: `${TRUSTED_BASE}/releases/v0.9.1/prime-agent-0.9.1.tgz`,
			sha256: PINNED_SHA,
		});
		// Recognized is not installable: config never turns a URL into a package-manager
		// argument, because npm accepts any URL it is given.
		expect(getSelfUpdateCommand("prime-agent", undefined, trustedSpec("prime-agent-0.9.1.tgz"))).toBeUndefined();
	});

	test("local tarballs need a verified download, not a path that looks like one", () => {
		expect(classifyUpdateSpec("/tmp/prime-agent-0.9.1.tgz")).toMatchObject({
			kind: "rejected",
			reason: "unverified_local_artifact",
		});
		expect(classifyUpdateSpec("file:/tmp/prime-agent-0.9.1.tgz")).toMatchObject({
			kind: "rejected",
			reason: "unverified_local_artifact",
		});
		expect(
			classifyUpdateSpec("/tmp/prime-agent-0.9.1.tgz", {
				verifiedArtifact: { path: "/tmp/prime-agent-0.9.1.tgz", sha256: PINNED_SHA },
			}),
		).toMatchObject({ kind: "verified-artifact", path: "/tmp/prime-agent-0.9.1.tgz", sha256: PINNED_SHA });
		expect(
			classifyUpdateSpec("/tmp/prime-agent-0.9.1.tgz", {
				verifiedArtifact: { path: "/tmp/other-0.9.1.tgz", sha256: PINNED_SHA },
			}),
		).toMatchObject({ kind: "rejected", reason: "unverified_local_artifact" });
	});

	test("verifyUpdateArtifactHash rejects bytes that do not match the pinned digest", () => {
		const bytes = Buffer.from("prime-agent release payload");
		const digest = createHash("sha256").update(bytes).digest("hex");
		expect(verifyUpdateArtifactHash(bytes, digest)).toBe(true);
		expect(verifyUpdateArtifactHash(bytes, "b".repeat(64))).toBe(false);
		expect(verifyUpdateArtifactHash(Buffer.alloc(0), digest)).toBe(false);
	});
});
