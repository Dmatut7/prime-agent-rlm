import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORK_GATE_ENV_VAR } from "../src/fork-self-update.js";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const defaultPrimeAgentDownloadBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalForkGate = process.env[FORK_GATE_ENV_VAR];

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	// The suite runs with DO_NOT_TRACK=1 (vitest config) and these tests are about the check
	// itself; the opt-out is set back to `1` by the test that is about the opt-out.
	process.env.DO_NOT_TRACK = "0";
	delete process.env.PI_SKIP_VERSION_CHECK;
});

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("PI_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("PI_OFFLINE", originalOffline);
	restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
	restoreEnv("DO_NOT_TRACK", originalDoNotTrack);
	restoreEnv(FORK_GATE_ENV_VAR, originalForkGate);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		// This example is about the upstream release face itself. The suite runs inside a
		// fork checkout, where the fork gate suppresses the startup notice unless it is
		// off: the gate's own behavior has its own suite (fork-self-update.test.ts) and the
		// "fork checkout gate" describe below, so the repository's test seam for it is what
		// keeps this example on the upstream path instead of asserting the refusal here.
		process.env[FORK_GATE_ENV_VAR] = "off";
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Prime Agent release manifest with a Prime Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultPrimeAgentDownloadBaseUrl}/latest.json`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^prime-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: "prime-agent",
				tarball: "releases/v1.2.4/prime-agent-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: `${defaultPrimeAgentDownloadBaseUrl}/releases/v1.2.4/prime-agent-1.2.4.tgz`,
			packageName: "prime-agent",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips the startup version check when the environment opted out of tracking", async () => {
		// Upstream behavior face again (see the note in "returns only newer versions").
		// Without the seam the first assertion below passes for the wrong reason - the fork
		// gate, not the opt-out, is what returns undefined - and the positive control that
		// shows the same call reaching the manifest with the opt-out off cannot pass at all.
		process.env[FORK_GATE_ENV_VAR] = "off";
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		process.env.DO_NOT_TRACK = "1";
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();

		// Positive control: the same call reaches the manifest once the opt-out is off.
		process.env.DO_NOT_TRACK = "0";
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends no request to a local manifest server while the opt-out is set", async () => {
		// A real socket rather than a stubbed fetch: the subject is whether a request leaves the
		// process at all, and a stub can only report what the code asked for.
		const hits: string[] = [];
		const server = createServer((request, response) => {
			hits.push(`${request.headers["user-agent"] ?? ""} ${request.url ?? ""}`);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ version: "v9.9.9" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = `http://127.0.0.1:${port}`;

		try {
			// Positive control: the server is reachable and answers a manifest request.
			process.env.DO_NOT_TRACK = "0";
			await expect(checkForNewPiVersion("1.2.3")).resolves.toBe("9.9.9");
			expect(hits).toHaveLength(1);
			expect(hits[0]).toContain("/latest.json");

			process.env.DO_NOT_TRACK = "1";
			await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
			expect(hits).toHaveLength(1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("fork checkout gate", () => {
	it("suppresses the notice while this checkout still points at upstream's releases", async () => {
		// The seam above is off for this case: the subject is what a fork build does. One
		// checkout cannot fix itself by installing upstream's package over it, so the
		// background notice - whose only answer is "replace this build" - is suppressed, and
		// the refusal is loud only inside the PRIME_AGENT_FORK_GATE=off seam; on a real fork
		// checkout the suppression itself stays silent by design (version-check.ts returns
		// undefined without logging), so this pin asserts the absence of the notice, not a log.
		delete process.env[FORK_GATE_ENV_VAR];
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.2")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still announces a newer version once the release origin is this line's own", async () => {
		// Positive control for the case above: the gate is keyed to the *origin* plus the
		// checkout, not to "is this a fork" alone, so pointing the download base at this
		// line's own releases brings the notice back. Without this half the suppression
		// assertion would stay green even if the check were disabled everywhere.
		delete process.env[FORK_GATE_ENV_VAR];
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "https://releases.example.invalid/fork-line";
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
