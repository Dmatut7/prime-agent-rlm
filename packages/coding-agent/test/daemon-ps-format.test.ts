import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { type DaemonInfo, describeShutdownTarget, formatShutdownReport } from "../src/cli/daemon-ps.js";
import {
	type ClientBuildIdentity,
	formatDaemonListTable,
	formatDaemonWarmPoolLine,
	formatUptime,
} from "../src/cli/daemon-ps-format.js";
import { resolveStopSelection } from "../src/cli/daemon-stop-scope.js";

describe("formatUptime", () => {
	it("formats seconds into a compact human duration", () => {
		expect(formatUptime(0)).toBe("0s");
		expect(formatUptime(45)).toBe("45s");
		expect(formatUptime(90)).toBe("1m");
		expect(formatUptime(3 * 3600)).toBe("3h");
		expect(formatUptime(5 * 86400)).toBe("5d");
		expect(formatUptime(14 * 86400)).toBe("2w");
	});

	it("returns empty for unknown uptime", () => {
		expect(formatUptime(undefined)).toBe("");
	});
});

describe("formatDaemonListTable", () => {
	it("renders columns, marks the default daemon, and shows blanks for missing fields", () => {
		const daemons: DaemonInfo[] = [
			{
				socketPath: "/tmp/prime-agent-1000/daemon.sock",
				pid: 1234,
				uptimeSeconds: 7200,
				version: "0.1.5",
				protocolVersion: 1,
				sessionCount: 2,
				status: "current",
				isDefault: true,
			},
			{
				socketPath: "/tmp/orphan.sock",
				status: "orphan-file",
				isDefault: false,
			},
		];

		const table = stripAnsi(formatDaemonListTable(daemons));
		const lines = table.split("\n");
		expect(lines[0]!.trim().split(/\s+/)).toEqual([
			"socket",
			"pid",
			"version",
			"buildId",
			"status",
			"sessions",
			"live",
			"uptime",
			"executable",
		]);
		expect(table).toContain("/tmp/prime-agent-1000/daemon.sock *");
		expect(table).toContain("* default background service");
		expect(table).toContain("current");
		expect(table).toContain("orphan-file");
		expect(table).toContain("2h");
	});

	it("drops low-priority columns to fit the terminal width, keeping socket and status", () => {
		// R2-M7: the padded table ran to 240+ columns on real data (socket path,
		// buildId and executable alone exceed 80), so every terminal hard-folded it.
		const daemons: DaemonInfo[] = [
			{
				socketPath: "/Users/operator/.prime/agent/daemon.sock.9f8e7d6c",
				pid: 4242,
				uptimeSeconds: 7200,
				version: "0.9.1",
				buildId: "v0.9.1-601-g2cd3456ef",
				sessionCount: 3,
				liveness: "live",
				livenessEvidence: ["pid 4242", "3 sessions"],
				status: "current",
				isDefault: true,
				executablePath: "/Users/operator/.local/share/prime-agent/bin/prime-agent",
			},
		];

		const width = 80;
		const table = stripAnsi(formatDaemonListTable(daemons, undefined, { width }));
		const lines = table.split("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const header = lines[0]!.trim().split(/\s+/);
		expect(header).toContain("socket");
		expect(header).toContain("status");
		// Sacrificed in drop order: live, executable, buildId, uptime, sessions, ...
		expect(header).not.toContain("executable");
		expect(header).not.toContain("live");
		expect(lines[1]).toContain("current");
		expect(lines[1]).toContain("daemon.sock.9f8e7d6c");
	});

	it("truncates the socket with an ellipsis when even the kept columns overflow", () => {
		const daemons: DaemonInfo[] = [
			{
				socketPath: "/Users/operator/.prime/agent/daemon.sock.9f8e7d6c",
				status: "unreachable",
				isDefault: false,
			},
		];
		const width = 24;
		const table = stripAnsi(formatDaemonListTable(daemons, undefined, { width }));
		const lines = table.split("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(lines[1]).toContain("…");
		expect(lines[1]).toContain("unreachable");
	});
});

const THIS_BUILD: ClientBuildIdentity = {
	version: "0.9.1",
	protocolVersion: 4,
	schemaId: "daemon-schema-4",
	buildId: "v0.9.1-601-g2cd3456ef",
	executablePath: "/private/tmp/wt-r19-status/packages/coding-agent/dist/bundle/cli.js",
};

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string }): DaemonInfo {
	return { status: "outdated", isDefault: false, version: "0.9.1", ...options };
}

function tableRows(daemons: DaemonInfo[]): string[] {
	const lines = stripAnsi(formatDaemonListTable(daemons, THIS_BUILD)).split("\n");
	// Line 0 is the header; the daemon rows follow it before any dim notes.
	return lines.slice(1, 1 + daemons.length);
}

describe("formatDaemonListTable build identity", () => {
	// DO-3: buildId and executablePath are the only fields that tell two builds of
	// the same version apart, so the human table has to render both.
	const identityCases: Array<{
		name: string;
		left: DaemonInfo;
		right: DaemonInfo;
		leftMarker: string;
		rightMarker: string;
	}> = [
		{
			name: "same version, different buildId",
			left: makeDaemon({
				socketPath: "/tmp/wt-a/prime-agent-501/daemon.sock",
				buildId: "v0.9.1-505-g1ab9a94e7-dirty",
				executablePath: "/private/tmp/wt-a/packages/coding-agent/dist/bundle/cli.js",
			}),
			right: makeDaemon({
				socketPath: "/tmp/wt-b/prime-agent-501/daemon.sock",
				buildId: "v0.9.1-601-g2cd3456ef",
				executablePath: "/private/tmp/wt-b/packages/coding-agent/dist/bundle/cli.js",
			}),
			leftMarker: "v0.9.1-505-g1ab9a94e7-dirty",
			rightMarker: "v0.9.1-601-g2cd3456ef",
		},
		{
			name: "same version, same buildId, different executablePath",
			left: makeDaemon({
				socketPath: "/tmp/wt-r11/prime-agent-501/daemon.sock",
				buildId: "v0.9.1-505-g1ab9a94e7-dirty",
				executablePath: "/private/tmp/wt-r11-ch/packages/coding-agent/dist/bundle/cli.js",
			}),
			right: makeDaemon({
				socketPath: "/tmp/wt-r19/prime-agent-501/daemon.sock",
				buildId: "v0.9.1-505-g1ab9a94e7-dirty",
				executablePath: "/private/tmp/wt-r19-status/packages/coding-agent/dist/bundle/cli.js",
			}),
			leftMarker: "wt-r11-ch",
			rightMarker: "wt-r19-status",
		},
		{
			name: "same version, no buildId on either side",
			left: makeDaemon({
				socketPath: "/tmp/wt-c/prime-agent-501/daemon.sock",
				version: undefined,
				executablePath: "/Users/a1/.local/bin/prime-agent",
			}),
			right: makeDaemon({
				socketPath: "/tmp/wt-d/prime-agent-501/daemon.sock",
				version: undefined,
				executablePath: "/private/tmp/wt-d/packages/coding-agent/dist/bundle/cli.js",
			}),
			leftMarker: "/Users/a1/.local/bin/prime-agent",
			rightMarker: "wt-d",
		},
	];

	expect(identityCases.length).toBeGreaterThan(0);

	for (const testCase of identityCases) {
		it(`distinguishes daemons with the ${testCase.name} in the table and the stop line`, () => {
			const rows = tableRows([testCase.left, testCase.right]);
			expect(rows).toHaveLength(2);
			expect(rows[0]).not.toBe(rows[1]);
			expect(rows[0]).toContain(testCase.leftMarker);
			expect(rows[1]).toContain(testCase.rightMarker);
			// The same two services have to read apart in the pre-stop confirmation, too.
			const leftTarget = describeShutdownTarget(testCase.left, THIS_BUILD);
			const rightTarget = describeShutdownTarget(testCase.right, THIS_BUILD);
			expect(leftTarget).not.toBe(rightTarget);
			expect(leftTarget).toContain(testCase.leftMarker);
			expect(rightTarget).toContain(testCase.rightMarker);
		});
	}

	it("names this build and puts a placeholder in every empty identity cell", () => {
		const table = stripAnsi(
			formatDaemonListTable(
				[{ socketPath: "/tmp/orphan.sock", status: "orphan-file", isDefault: false }],
				THIS_BUILD,
			),
		);
		const orphanRow = table.split("\n")[1] ?? "";
		expect(orphanRow).toContain("-");
		expect(table).toContain("this build  v0.9.1-601-g2cd3456ef");
	});

	it("says the buildId is unknown instead of pretending a comparison", () => {
		const table = stripAnsi(
			formatDaemonListTable(
				[makeDaemon({ socketPath: "/tmp/wt-a/daemon.sock", buildId: "v0.9.1-505-g1ab9a94e7-dirty" })],
				{
					version: "0.9.1",
					executablePath: "/private/tmp/wt-a/packages/coding-agent/dist/bundle/cli.js",
				},
			),
		);
		expect(table).toContain("this process buildId unknown");
	});
});

describe("stop confirmation build judgement", () => {
	const outdated = makeDaemon({
		socketPath: "/tmp/wt-a/prime-agent-501/daemon.sock",
		pid: 1729,
		sessionCount: 0,
		version: "0.9.1",
		buildId: "v0.9.1-505-g1ab9a94e7-dirty",
		executablePath: "/Users/a1/.local/bin/prime-agent",
	});

	it("shows the real buildId comparison for a same-version other-build service", () => {
		const line = describeShutdownTarget(outdated, THIS_BUILD);
		expect(line).toContain(
			"built 0.9.1 (buildId v0.9.1-505-g1ab9a94e7-dirty != this build v0.9.1-601-g2cd3456ef; " +
				"executable /Users/a1/.local/bin/prime-agent != this build " +
				"/private/tmp/wt-r19-status/packages/coding-agent/dist/bundle/cli.js)",
		);
		expect(line).not.toMatch(/0\.9\.1 \(not this build\)/);
	});

	it("admits this process cannot name its build instead of faking a comparison", () => {
		const line = describeShutdownTarget(outdated, {
			version: THIS_BUILD.version,
			protocolVersion: THIS_BUILD.protocolVersion,
			schemaId: THIS_BUILD.schemaId,
		});
		expect(line).toContain("this process buildId unknown");
		expect(line).toContain("v0.9.1-505-g1ab9a94e7-dirty");
	});

	it("names the differing criterion when both sides carry the same buildId", () => {
		const line = describeShutdownTarget(
			makeDaemon({
				socketPath: "/tmp/wt-a/daemon.sock",
				version: "0.9.1",
				protocolVersion: 3,
				schemaId: THIS_BUILD.schemaId,
				buildId: THIS_BUILD.buildId,
			}),
			THIS_BUILD,
		);
		expect(line).toContain("protocol 3 != 4");
		expect(line).toContain("buildId v0.9.1-601-g2cd3456ef matches this build");
	});

	it("tells the operator how to get this build back, naming the build", () => {
		const selection = resolveStopSelection({ all: true });
		if (!selection.ok) throw new Error("expected a valid selection");
		const report = formatShutdownReport(selection.selection, [outdated], [], THIS_BUILD);
		expect(report).toContain("Next:");
		expect(report).toContain("v0.9.1-601-g2cd3456ef");
		expect(report).toContain("prime-agent status");
	});
});

describe("warm pool lines (rev 45)", () => {
	const zeroReclaims = {
		ttl_expired: 0,
		exited: 0,
		memory_pressure: 0,
		pool_closed: 0,
		claim_failed: 0,
		drain: 0,
	};

	it("prints no pool line for a daemon that never advertised the capability", () => {
		// Old-daemon degrade: warmPool is absent, and the table is byte-identical to
		// the pre-45 output (no section header, no placeholder).
		const table = stripAnsi(formatDaemonListTable([makeDaemon({ socketPath: "/tmp/wt-a/daemon.sock" })]));
		expect(table).not.toContain("warm pool");
	});

	it("renders depth, claim counters with hit rate, and reclaim attribution", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/wt-a/daemon.sock",
			isDefault: true,
			warmPool: {
				enabled: true,
				depth: { ready: 1, warming: 0 },
				spares: [{ cwd: "/repo", workerId: "worker-warm-1", ageMs: 12_000, expiresInMs: 288_000 }],
				cooldowns: [],
				totals: {
					spawns: { ready: 2, failed: 0 },
					claims: { hit: 3, miss: 1, expired: 0 },
					reclaims: { ...zeroReclaims, ttl_expired: 1 },
				},
				config: { ttlMs: 300_000, maxSpares: 4 },
			},
		});
		const line = formatDaemonWarmPoolLine(daemon);
		expect(line).toBeDefined();
		expect(line).toContain("/tmp/wt-a/daemon.sock *");
		expect(line).toContain("depth ready 1 warming 0");
		expect(line).toContain("claims hit 3 (75%) miss 1 expired 0");
		expect(line).toContain("spawns ready 2 failed 0");
		expect(line).toContain("reclaims ttl_expired 1");
		expect(line).toContain("spares /repo age 12s");
		// The table surfaces the line between the rows and the dim notes.
		const table = stripAnsi(formatDaemonListTable([daemon]));
		expect(table).toContain("warm pool /tmp/wt-a/daemon.sock *:");
	});

	it("says disabled for a daemon whose pool is configured off", () => {
		const line = formatDaemonWarmPoolLine(
			makeDaemon({
				socketPath: "/tmp/wt-a/daemon.sock",
				warmPool: {
					enabled: false,
					depth: { ready: 0, warming: 0 },
					spares: [],
					cooldowns: [],
					totals: {
						spawns: { ready: 0, failed: 0 },
						claims: { hit: 0, miss: 0, expired: 0 },
						reclaims: { ...zeroReclaims },
					},
				},
			}),
		);
		expect(line).toBe("warm pool /tmp/wt-a/daemon.sock: disabled");
	});

	it("names a cooldown cwd with its retry wait and failure reason", () => {
		const line = formatDaemonWarmPoolLine(
			makeDaemon({
				socketPath: "/tmp/wt-a/daemon.sock",
				warmPool: {
					enabled: true,
					depth: { ready: 0, warming: 1 },
					spares: [],
					cooldowns: [{ cwd: "/repo", reason: "boot budget exceeded", retryInMs: 45_000 }],
					totals: {
						spawns: { ready: 0, failed: 1 },
						claims: { hit: 0, miss: 0, expired: 0 },
						reclaims: { ...zeroReclaims },
					},
				},
			}),
		);
		expect(line).toContain("cooldowns /repo retry in 45s (boot budget exceeded)");
	});
});
