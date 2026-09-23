import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

/**
 * The spend-cell surface `handleCtrlZ` touches: suspending a terminal takes the tray's
 * spend cell off screen, so the suspend/resume paths also tear its idle tick down and
 * recompute whether anything is worth refreshing.
 */
type FakeSpendCellSurface = {
	terminalSuspended?: boolean;
	subagentSpendTickTimer?: ReturnType<typeof setInterval>;
	subagentCounts?: { total: number; running: number; idle: number; inactive: number };
	uiServices?: { settingsManager: { getSubagentSpendCellEnabled: () => boolean } };
	subagentSummaryLine?: { setSubagentSpend: (spend: undefined) => void };
};

type HandleCtrlZThis = {
	ui: FakeUi;
} & FakeSpendCellSurface;

/** A terminal with no sub-agent family: nothing is on screen, so nothing ticks. */
function spendCellSurface(): FakeSpendCellSurface & { setSubagentSpend: ReturnType<typeof vi.fn> } {
	const setSubagentSpend = vi.fn();
	return {
		terminalSuspended: false,
		subagentSpendTickTimer: undefined,
		subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
		uiServices: { settingsManager: { getSubagentSpendCellEnabled: () => true } },
		subagentSummaryLine: { setSubagentSpend },
		setSubagentSpend,
	};
}

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): void;
};

/**
 * Build a receiver from `fields` and link it to the real prototype: `handleCtrlZ`
 * reaches for other mode methods (the spend cell's suspend/resume path), and those live
 * on the prototype rather than on the fixture.
 */
function suspendReceiver(fields: HandleCtrlZThis): HandleCtrlZThis {
	return Object.assign(Object.create(InteractiveMode.prototype), fields);
}

/** Invoke `handleCtrlZ` on a receiver over `fields`. */
function callHandleCtrlZ(fields: HandleCtrlZThis): HandleCtrlZThis {
	const context = suspendReceiver(fields);
	(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
	return context;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

describe("InteractiveMode.handleCtrlZ", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("shows a status message and skips suspend on Windows", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = { ui, showStatus };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Windows 不支持挂到后台");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("keeps the process alive while suspended and restores the TUI on SIGCONT", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const spend = spendCellSurface();
		// A tick armed before the suspend: it must be torn down with the cell.
		const armedTick = setTimeout(() => undefined, 2 ** 30);
		clearTimeout(armedTick);
		const fields: HandleCtrlZThis = { ui, ...spend, subagentSpendTickTimer: armedTick };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		const context = callHandleCtrlZ(fields);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		// Nothing is on screen while suspended: the spend cell's tick is torn down and no
		// new one is armed (the only interval so far is the keep-alive).
		expect(Reflect.get(context, "terminalSuspended")).toBe(true);
		expect(clearIntervalSpy).toHaveBeenCalledWith(armedTick);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(spend.setSubagentSpend).toHaveBeenCalledWith(undefined);

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		// Resumed: the suspension flag is cleared and the cell re-derives its presence
		// (still no family here, so it stays torn down rather than ticking an empty bar).
		expect(Reflect.get(context, "terminalSuspended")).toBe(false);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(spend.setSubagentSpend).toHaveBeenCalledTimes(2);
	});

	test("cleans up the temporary handlers if suspension fails", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const spend = spendCellSurface();
		const fields: HandleCtrlZThis = { ui, ...spend };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		// The receiver is built first so the restored state is observable after the throw.
		const context = suspendReceiver(fields);
		expect(() =>
			(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context),
		).toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
		// The suspend never took, so the TUI is still on screen and the spend cell must
		// not stay frozen behind a flag nothing will clear.
		expect(Reflect.get(context, "terminalSuspended")).toBe(false);
	});
});
