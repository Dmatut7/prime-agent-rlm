import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
	handleExportCommand(this: ExportCommandContext, text: string): Promise<void>;
};

type ExportCommandContext = {
	agentConnection: {
		exportToHtml: (outputPath?: string) => Promise<string>;
		exportToJsonl: (outputPath: string) => Promise<string>;
	};
	showError: (message: string) => void;
	showStatus: (message: string, severity?: string) => void;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	stopWorkingLoader: () => void;
	agentConnection: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes unquoted path to agentConnection.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("已从 path/to/session.jsonl 导入会话");
	});

	it("passes unquoted apostrophe path to agentConnection.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("已从 john's/session.jsonl 导入会话");
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("导入会话失败：File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode /export parsing", () => {
	it("throws a usage error for an unclosed quote instead of falling back to the default path", () => {
		expect(() => interactiveModePrototype.getPathCommandArgument('/export "unclosed/path.html', "/export")).toThrow(
			"用法：/export <路径>（引号未闭合）",
		);
		expect(() => interactiveModePrototype.getPathCommandArgument("/import 'unclosed", "/import")).toThrow(
			"用法：/import <路径>（引号未闭合）",
		);
	});

	it("reports the unclosed-quote usage error and exports nothing", async () => {
		const exportToHtml = vi.fn(async () => "/tmp/default.html");
		const exportToJsonl = vi.fn(async () => "/tmp/out.jsonl");
		const showError = vi.fn();
		const showStatus = vi.fn();

		const context: ExportCommandContext = {
			agentConnection: { exportToHtml, exportToJsonl },
			showError,
			showStatus,
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleExportCommand.call(context, '/export "unclosed');

		expect(showError).toHaveBeenCalledWith("用法：/export <路径>（引号未闭合）");
		expect(exportToHtml).not.toHaveBeenCalled();
		expect(exportToJsonl).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("routes a .jsonl export path to the JSONL exporter", async () => {
		const exportToHtml = vi.fn(async () => "/tmp/default.html");
		const exportToJsonl = vi.fn(async () => "/tmp/out.jsonl");
		const showError = vi.fn();
		const showStatus = vi.fn();

		const context: ExportCommandContext = {
			agentConnection: { exportToHtml, exportToJsonl },
			showError,
			showStatus,
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleExportCommand.call(context, "/export out.jsonl");

		expect(exportToJsonl).toHaveBeenCalledWith("out.jsonl");
		expect(exportToHtml).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("会话已导出到：/tmp/out.jsonl");
	});
});
