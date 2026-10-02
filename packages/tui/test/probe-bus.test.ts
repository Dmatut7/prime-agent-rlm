import assert from "node:assert";
import { describe, it } from "node:test";
import { type CapabilityState, ProbeBus } from "../src/probe-bus.js";
import { QUERY_DEFAULT_BACKGROUND, QUERY_DEFAULT_FOREGROUND } from "../src/terminal-colors.js";

const DA_ANSWER = "\x1b[?64;1;2;6c";

function startBus(
	options?: { fallbackMs?: number; env?: Record<string, string | undefined> },
	startOptions?: { queryOscColors?: boolean; queryCellSize?: boolean },
): { bus: ProbeBus; writes: string[] } {
	const bus = new ProbeBus(options);
	const writes: string[] = [];
	bus.start((data) => writes.push(data), startOptions);
	return { bus, writes };
}

describe("ProbeBus", () => {
	describe("query writes", () => {
		it("writes every probe query ahead of the primary-DA fence", () => {
			const { bus, writes } = startBus({ env: {} });
			try {
				const expected = `\x1b[?u${QUERY_DEFAULT_FOREGROUND}${QUERY_DEFAULT_BACKGROUND}\x1b[16t\x1b[c`;
				assert.deepStrictEqual(writes, [expected]);
			} finally {
				bus.dispose();
			}
		});

		it("skips the queries the caller gates off and reports those capabilities unknown", () => {
			const { bus, writes } = startBus({ env: {} }, { queryOscColors: false, queryCellSize: false });
			try {
				assert.deepStrictEqual(writes, ["\x1b[?u\x1b[c"]);
				assert.deepStrictEqual(bus.query("oscColors"), { verdict: "unknown", source: "default" });
				assert.deepStrictEqual(bus.query("cellSize"), { verdict: "unknown", source: "default" });
				// Never asked, so the DA fence must not flip them to unsupported.
				bus.handleSequence(DA_ANSWER);
				assert.strictEqual(bus.query("oscColors").verdict, "unknown");
				assert.strictEqual(bus.query("cellSize").verdict, "unknown");
			} finally {
				bus.dispose();
			}
		});
	});

	describe("answers ahead of the fence", () => {
		it("marks the Kitty keyboard capability supported when its answer arrives", () => {
			const { bus } = startBus({ env: {} });
			try {
				const seen: CapabilityState[] = [];
				bus.onChange("kittyKeyboard", (_cap, state) => seen.push(state));
				assert.strictEqual(bus.handleSequence("\x1b[?1u"), true);
				assert.deepStrictEqual(bus.query("kittyKeyboard"), { verdict: "supported", source: "probe" });
				assert.deepStrictEqual(seen, [{ verdict: "supported", source: "probe" }]);
			} finally {
				bus.dispose();
			}
		});

		it("collects both OSC 10/11 answers into one oscColors verdict with the colors", () => {
			const { bus } = startBus({ env: {} });
			try {
				const seen: CapabilityState[] = [];
				bus.onChange("oscColors", (_cap, state) => seen.push(state));

				assert.strictEqual(bus.handleSequence("\x1b]10;rgb:ffff/ffff/ffff\x07"), true);
				assert.strictEqual(bus.query("oscColors").verdict, "pending");
				assert.strictEqual(bus.handleSequence("\x1b]11;rgb:0000/0000/0000\x1b\\"), true);

				const state = bus.query("oscColors");
				assert.strictEqual(state.verdict, "supported");
				assert.strictEqual(state.source, "probe");
				assert.deepStrictEqual(state.defaultColors, {
					foreground: { r: 255, g: 255, b: 255 },
					background: { r: 0, g: 0, b: 0 },
				});
				assert.strictEqual(seen.length, 1);
				assert.deepStrictEqual(seen[0], state);
			} finally {
				bus.dispose();
			}
		});

		it("parses cell-size answers into the cellSize payload and re-notifies on real changes", () => {
			const { bus } = startBus({ env: {} });
			try {
				const seen: CapabilityState[] = [];
				bus.onChange("cellSize", (_cap, state) => seen.push(state));

				assert.strictEqual(bus.handleSequence("\x1b[6;18;104t"), true);
				assert.deepStrictEqual(bus.query("cellSize"), {
					verdict: "supported",
					source: "probe",
					cellSize: { widthPx: 104, heightPx: 18 },
				});

				// A repeat of the same dimensions is consumed but does not re-notify.
				assert.strictEqual(bus.handleSequence("\x1b[6;18;104t"), true);
				// A degenerate geometry is consumed without touching the state.
				assert.strictEqual(bus.handleSequence("\x1b[6;0;0t"), true);
				assert.strictEqual(seen.length, 1);

				// A real change (e.g. the user zoomed) notifies again.
				assert.strictEqual(bus.handleSequence("\x1b[6;20;10t"), true);
				assert.strictEqual(seen.length, 2);
				assert.deepStrictEqual(seen[1]?.cellSize, { widthPx: 10, heightPx: 20 });
			} finally {
				bus.dispose();
			}
		});

		it("records DECRPM answers on the DECRQM capabilities, consuming unknown modes", () => {
			const { bus } = startBus({ env: {} });
			try {
				assert.strictEqual(bus.handleSequence("\x1b[?2026;1$y"), true);
				assert.deepStrictEqual(bus.query("sync2026"), { verdict: "supported", source: "probe", decrpmValue: 1 });

				// Pv=2 (reset) still means the terminal knows the mode.
				assert.strictEqual(bus.handleSequence("\x1b[?2027;2$y"), true);
				assert.deepStrictEqual(bus.query("grapheme2027"), {
					verdict: "supported",
					source: "probe",
					decrpmValue: 2,
				});

				// Pv=4 (permanently reset) means the terminal refuses the mode.
				assert.strictEqual(bus.handleSequence("\x1b[?2031;4$y"), true);
				assert.deepStrictEqual(bus.query("scheme2031"), {
					verdict: "unsupported",
					source: "probe",
					decrpmValue: 4,
				});

				// A mode nobody probed is consumed so it cannot leak into the key path.
				assert.strictEqual(bus.handleSequence("\x1b[?9999;1$y"), true);
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "pending");
			} finally {
				bus.dispose();
			}
		});

		it("treats a 2031 scheme push as scheme2031 support and consumes it", () => {
			const { bus } = startBus({ env: {} });
			try {
				assert.strictEqual(bus.handleSequence("\x1b[?997;2n"), true);
				assert.deepStrictEqual(bus.query("scheme2031"), { verdict: "supported", source: "probe" });
			} finally {
				bus.dispose();
			}
		});

		it("consumes an OSC-shaped answer with an unparseable payload without changing state", () => {
			const { bus } = startBus({ env: {} });
			try {
				assert.strictEqual(bus.handleSequence("\x1b]10;not-a-color\x07"), true);
				assert.strictEqual(bus.query("oscColors").verdict, "pending");
			} finally {
				bus.dispose();
			}
		});
	});

	describe("DA fence and fallback timer", () => {
		it("marks still-pending capabilities unsupported when the DA answer arrives and resolves settled", async () => {
			const { bus } = startBus({ env: {} });
			try {
				const kittySeen: CapabilityState[] = [];
				bus.onChange("kittyKeyboard", (_cap, state) => kittySeen.push(state));

				assert.strictEqual(bus.handleSequence(DA_ANSWER), true);
				await bus.settled;

				for (const cap of ["kittyKeyboard", "oscColors", "cellSize"] as const) {
					assert.deepStrictEqual(bus.query(cap), { verdict: "unsupported", source: "default" }, cap);
				}
				// DECRQM capabilities were never queried: the fence says nothing about them.
				for (const cap of ["sync2026", "grapheme2027", "scheme2031"] as const) {
					assert.strictEqual(bus.query(cap).verdict, "unknown", cap);
				}
				assert.deepStrictEqual(kittySeen, [{ verdict: "unsupported", source: "default" }]);
			} finally {
				bus.dispose();
			}
		});

		it("marks still-pending capabilities unknown when the fallback timer fires without a DA", async () => {
			const { bus } = startBus({ env: {}, fallbackMs: 5 });
			try {
				await bus.settled;
				for (const cap of ["kittyKeyboard", "oscColors", "cellSize"] as const) {
					assert.deepStrictEqual(bus.query(cap), { verdict: "unknown", source: "default" }, cap);
				}
			} finally {
				bus.dispose();
			}
		});

		it("lets the first settle win: a DA after the timer changes nothing", async () => {
			const { bus } = startBus({ env: {}, fallbackMs: 5 });
			try {
				await bus.settled;
				assert.strictEqual(bus.handleSequence(DA_ANSWER), true);
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "unknown");
			} finally {
				bus.dispose();
			}
		});

		it("consumes a second DA answer without side effects", async () => {
			const { bus } = startBus({ env: {} });
			try {
				bus.handleSequence("\x1b[?1u");
				bus.handleSequence(DA_ANSWER);
				await bus.settled;
				assert.strictEqual(bus.handleSequence(DA_ANSWER), true);
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "supported");
			} finally {
				bus.dispose();
			}
		});

		it("honors late Kitty and cell-size answers but drops late OSC color answers", async () => {
			const { bus } = startBus({ env: {} });
			try {
				bus.handleSequence(DA_ANSWER);
				await bus.settled;

				// A Kitty answer that outran the fence still enables the protocol.
				assert.strictEqual(bus.handleSequence("\x1b[?1u"), true);
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "supported");

				// Cell size has no fence semantics today: answers apply whenever they land.
				assert.strictEqual(bus.handleSequence("\x1b[6;18;104t"), true);
				assert.strictEqual(bus.query("cellSize").verdict, "supported");

				// The color probe is closed at the fence: late answers are consumed but dropped.
				assert.strictEqual(bus.handleSequence("\x1b]10;rgb:ffff/ffff/ffff\x07"), true);
				assert.strictEqual(bus.handleSequence("\x1b]11;rgb:0000/0000/0000\x07"), true);
				assert.strictEqual(bus.query("oscColors").verdict, "unsupported");
				assert.strictEqual(bus.query("oscColors").defaultColors, undefined);
			} finally {
				bus.dispose();
			}
		});
	});

	describe("env overrides", () => {
		it("PI_TERMINAL_KITTY_KEYBOARD=0 disables the probe and the capability", () => {
			const { bus, writes } = startBus({ env: { PI_TERMINAL_KITTY_KEYBOARD: "0" } });
			try {
				const seen: CapabilityState[] = [];
				bus.onChange("kittyKeyboard", (_cap, state) => seen.push(state));
				assert.deepStrictEqual(bus.query("kittyKeyboard"), { verdict: "unsupported", source: "env-override" });
				assert.ok(!writes.join("").includes("\x1b[?u"));
				// The override is applied during start(), before listeners attached here -
				// so they see no replay, only later changes (none expected).
				bus.handleSequence(DA_ANSWER);
				assert.deepStrictEqual(seen, []);
			} finally {
				bus.dispose();
			}
		});

		it("PI_TERMINAL_KITTY_KEYBOARD=1 forces support without probing and survives the fence", async () => {
			const { bus, writes } = startBus({ env: { PI_TERMINAL_KITTY_KEYBOARD: "1" } });
			try {
				assert.deepStrictEqual(bus.query("kittyKeyboard"), { verdict: "supported", source: "env-override" });
				assert.ok(!writes.join("").includes("\x1b[?u"));
				bus.handleSequence(DA_ANSWER);
				await bus.settled;
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "supported");
			} finally {
				bus.dispose();
			}
		});

		it("PI_TERMINAL_OSC_COLORS=0 skips the OSC queries", () => {
			const { bus, writes } = startBus({ env: { PI_TERMINAL_OSC_COLORS: "0" } });
			try {
				assert.ok(!writes.join("").includes(QUERY_DEFAULT_FOREGROUND));
				assert.deepStrictEqual(bus.query("oscColors"), { verdict: "unsupported", source: "env-override" });
			} finally {
				bus.dispose();
			}
		});

		it("ignores override values other than 0/1 and probes normally", () => {
			const { bus, writes } = startBus({ env: { PI_TERMINAL_KITTY_KEYBOARD: "auto" } });
			try {
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "pending");
				assert.ok(writes.join("").includes("\x1b[?u"));
			} finally {
				bus.dispose();
			}
		});

		it("an env override is final: answers are consumed but change nothing", () => {
			const { bus } = startBus({ env: { PI_TERMINAL_KITTY_KEYBOARD: "0" } });
			try {
				assert.strictEqual(bus.handleSequence("\x1b[?1u"), true);
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "unsupported");
			} finally {
				bus.dispose();
			}
		});
	});

	describe("guards and lifecycle", () => {
		it("never consumes a bare CSI c (the shift+right key)", () => {
			const { bus } = startBus({ env: {} });
			try {
				assert.strictEqual(bus.handleSequence("\x1b[c"), false);
				assert.strictEqual(bus.handleSequence("\x1b[1;2c"), false);
				// Nothing changed: queried capabilities stay pending, unqueried stay unknown.
				for (const cap of ["kittyKeyboard", "oscColors", "cellSize"] as const) {
					assert.strictEqual(bus.query(cap).verdict, "pending", cap);
				}
				for (const cap of ["sync2026", "grapheme2027", "scheme2031"] as const) {
					assert.strictEqual(bus.query(cap).verdict, "unknown", cap);
				}
			} finally {
				bus.dispose();
			}
		});

		it("does not consume unrelated input", () => {
			const { bus } = startBus({ env: {} });
			try {
				for (const sequence of ["a", "\x1b[A", "\x1b[200~", "\x1b[<35;20;5M"]) {
					assert.strictEqual(bus.handleSequence(sequence), false, JSON.stringify(sequence));
				}
			} finally {
				bus.dispose();
			}
		});

		it("onChange unsubscribe stops notifications and query returns an isolated snapshot", () => {
			const { bus } = startBus({ env: {} });
			try {
				const seen: CapabilityState[] = [];
				const off = bus.onChange("kittyKeyboard", (_cap, state) => seen.push(state));
				off();
				bus.handleSequence("\x1b[?1u");
				assert.deepStrictEqual(seen, []);

				const snapshot = bus.query("kittyKeyboard");
				snapshot.verdict = "unknown";
				assert.strictEqual(bus.query("kittyKeyboard").verdict, "supported");
			} finally {
				bus.dispose();
			}
		});

		it("dispose resolves settled without waiting for the fallback timer and stops consumption", async () => {
			const { bus } = startBus({ env: {}, fallbackMs: 60_000 });
			bus.dispose();
			await bus.settled;
			assert.strictEqual(bus.handleSequence("\x1b[?1u"), false);
		});

		it("start is idempotent", () => {
			const { bus, writes } = startBus({ env: {} });
			try {
				bus.start((data) => writes.push(data));
				assert.strictEqual(writes.length, 1);
			} finally {
				bus.dispose();
			}
		});
	});
});
