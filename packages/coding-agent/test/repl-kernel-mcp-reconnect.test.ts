import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const runtimePython = resolve("../../prime-agent-runtime/.venv/bin/python");
const fallbackPython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");

function resolveKernelPython(): string | null {
	for (const python of [process.env.PRIME_AGENT_KERNEL_PYTHON, runtimePython, fallbackPython]) {
		if (!python || !existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, mcp, rlm"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

const MCP_SERVER = `import asyncio, json, os, sys
from pathlib import Path
Path(sys.argv[1]).write_text(str(os.getpid()))
async def main():
    while line := await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline):
        request = json.loads(line)
        if request.get("id") is None:
            continue
        if request["method"] == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "reconnect-fixture", "version": "1"}}
        elif request["method"] == "tools/list":
            result = {"tools": [{"name": "fixture.echo", "description": "echo", "inputSchema": {"type": "object"}}]}
        else:
            result = {"content": [{"type": "text", "text": "ok"}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
asyncio.run(main())
`;

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describeIfKernel("real REPL kernel MCP crash reconnect", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let fixture = "";
	let pidFile = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-mcp-reconnect-"));
		fixture = join(dir, "stdio_server.py");
		pidFile = join(dir, "stdio.pid");
		writeFileSync(fixture, MCP_SERVER);
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("retires a crashed stdio MCP session and reconnects on the next call", async () => {
		let manager: ReplKernelManager | undefined = new ReplKernelManager({
			python: python as string,
			cwd: resolve("../../prime-agent-runtime"),
			hostHandlers: {
				"mcp.config": async () => ({
					type: "stdio",
					command: python as string,
					args: [fixture, pidFile],
				}),
			},
		});
		try {
			const opened = await manager.execute("import rlm.mcp as mcp; await mcp.list_tools('fixture')");
			expect(opened.status, opened.stderr || opened.error?.traceback.join("\n")).toBe("ok");
			const firstPid = Number(readFileSync(pidFile, "utf8"));
			expect(pidExists(firstPid)).toBe(true);

			process.kill(firstPid, "SIGKILL");

			const failed = await manager.execute(
				"import rlm.mcp as mcp; await mcp.call_tool('fixture', 'fixture.echo', {})",
			);
			expect(failed.status).toBe("error");
			expect(failed.error?.traceback.join("\n")).toMatch(/Connection closed|ClosedResource|Broken/i);

			const reconnected = await manager.execute(
				"import rlm.mcp as mcp; await mcp.call_tool('fixture', 'fixture.echo', {})",
			);
			expect(reconnected.status, reconnected.stderr || reconnected.error?.traceback.join("\n")).toBe("ok");
			const secondPid = Number(readFileSync(pidFile, "utf8"));
			expect(secondPid).not.toBe(firstPid);
			expect(pidExists(secondPid)).toBe(true);

			await manager.shutdown();
			manager = undefined;
		} finally {
			await manager?.kill();
		}
	}, 30_000);
});
