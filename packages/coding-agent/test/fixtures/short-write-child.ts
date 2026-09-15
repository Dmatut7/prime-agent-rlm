// One harness for "make a reference record land short, for real".
//
// A file size limit is the portable way to stop a record write from landing whole (a full disk
// does the same thing), and POSIX answers the attempt two ways:
//   - macOS/BSD shortens the write to the permitted size and `writeSync` returns the partial count,
//     so the writer keeps running and reports what it decided;
//   - Linux raises SIGXFSZ for the over-limit attempt, whose default action ends the process
//     before it can report anything (the shape the CI run on ubuntu produced).
// A test that admits only the first shape is red on the second. So the driver installs a SIGXFSZ
// handler - which makes the reported verdict reachable on both - and this harness keeps "killed by
// SIGXFSZ" an acknowledged outcome for the host where the signal lands before the handler exists,
// instead of a failure that hides the proposition. Both shapes still have to leave the on-disk
// assertions of the calling test standing: no record the reader can trust.
import { spawnSync } from "node:child_process";

/** How this kernel answered a write that would cross the file size limit, measured by the child. */
export interface ShortWriteProbe {
	/** Bytes that landed of a `requested`-byte write. */
	landed: number;
	requested: number;
	/** How the write ended: `wrote-all`, `short-count`, or an errno such as `EFBIG`. */
	detail: string;
}

/** What the limited writer got to say for itself. */
export type ShortWriteChild =
	| { kind: "reported"; pid: number; report: Record<string, unknown>; probe?: ShortWriteProbe }
	| { kind: "killed"; pid: number; signal: NodeJS.Signals; probe?: ShortWriteProbe };

/**
 * Driver source lines every short-write child starts with: catch the signal, measure this kernel's
 * answer with the child's own write, and print that measurement *before* the record write, so the
 * parent still knows the shape when the record write is the one that ends the child. The probe path
 * arrives as the driver's last argument.
 */
export function shortWriteDriverPreamble(): string[] {
	return [
		'import { closeSync as swClose, constants as swConstants, openSync as swOpen, writeSync as swWrite } from "node:fs";',
		// Catching the signal is what lets one assertion serve both kernels: on Linux the write then
		// surfaces as an error the writer has to fail on, on macOS nothing here changes the shape.
		'process.on("SIGXFSZ", () => {});',
		"const swProbePath = process.argv[process.argv.length - 1] as string;",
		"{",
		"	const swRequested = 4096;",
		"	const swFd = swOpen(swProbePath, swConstants.O_WRONLY | swConstants.O_CREAT | swConstants.O_TRUNC, 0o600);",
		"	let swLanded = 0;",
		'	let swDetail = "wrote-all";',
		"	try {",
		"		while (swLanded < swRequested) {",
		"			const swCount = swWrite(swFd, Buffer.alloc(swRequested - swLanded, 0x61), 0, swRequested - swLanded);",
		'			if (swCount <= 0) { swDetail = "short-count"; break; }',
		"			swLanded += swCount;",
		"		}",
		"	} catch (swError) {",
		"		swDetail = String((swError as { code?: string }).code ?? (swError as Error).message);",
		"	}",
		"	swClose(swFd);",
		'	process.stdout.write(JSON.stringify({ line: "probe", landed: swLanded, requested: swRequested, detail: swDetail }) + "\\n");',
		"}",
	];
}

/** One tagged JSON line the child printed, or undefined when it did not get that far. */
function driverLine(stdout: string, wanted: string): Record<string, unknown> | undefined {
	for (const raw of stdout.split("\n")) {
		const text = raw.trim();
		if (text === "") continue;
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed.line === wanted) return parsed;
		} catch {
			// A line the child did not finish printing is not a verdict.
		}
	}
	return undefined;
}

/**
 * Run `driver` in a child whose file size limit is one block, so no record of any interesting size
 * can land there, and return what the child measured and reported.
 */
export function runShortWriteChild(input: { driver: string; args: string[]; probePath: string }): ShortWriteChild {
	const argv = [input.driver, ...input.args, input.probePath].map((arg) => JSON.stringify(arg)).join(" ");
	const result = spawnSync(
		"bash",
		["-c", `ulimit -f 1; exec ${JSON.stringify(process.execPath)} --import tsx ${argv}`],
		{
			// tsx must stay out of its cache here: this process may not write a file larger than the
			// limit either, and a truncated cache would poison other runs.
			env: { ...process.env, TSX_DISABLE_CACHE: "1" },
			encoding: "utf8",
			// The child runs under a filesystem limit and starts a loader; never let it hang the suite.
			timeout: 20_000,
		},
	);
	if (result.error !== undefined) throw new Error(`short-write child could not run: ${result.error.message}`);
	const probed = driverLine(result.stdout, "probe");
	const probe: ShortWriteProbe | undefined = probed
		? { landed: Number(probed.landed), requested: Number(probed.requested), detail: String(probed.detail) }
		: undefined;
	// `exec` keeps the pid, so a record file named for its holder is known even when the child
	// never got to report one.
	if (result.signal !== null) {
		return { kind: "killed", pid: result.pid, signal: result.signal, ...(probe ? { probe } : {}) };
	}
	const report = driverLine(result.stdout, "report");
	if (result.status !== 0 || report === undefined) {
		throw new Error(
			`short-write child gave no verdict: status=${String(result.status)} stdout=${result.stdout} stderr=${result.stderr}`,
		);
	}
	return { kind: "reported", pid: result.pid, report, ...(probe ? { probe } : {}) };
}
