import { describe, expect, it } from "vitest";
import { turnStepLabel, turnStepsSummary } from "../src/modes/interactive/components/step-label.js";

const cell = (code: string) => ({ toolName: "ipython", args: { code } });

describe("turnStepLabel", () => {
	it("labels a %%bash cell with its simplified command", () => {
		expect(turnStepLabel(cell("%%bash\nnpm run check"))).toBe("运行 npm check");
		expect(turnStepLabel(cell("%%bash\nls -la /tmp"))).toBe("列目录 tmp");
	});

	it("joins bash() calls and file reads inside a python cell in source order", () => {
		const code = [
			"r = await bash('sleep 10 && echo ok')",
			"print(r.output)",
			"import json",
			"print(json.load(open('packages/ai/package.json'))['version'])",
		].join("\n");
		expect(turnStepLabel(cell(code))).toBe("运行 echo ok，读取 package.json");
	});

	it("resolves Path variables for reads and writes", () => {
		expect(turnStepLabel(cell("p = Path('x.md')\ntext = p.read_text()\np.write_text(text.upper())"))).toBe(
			"读取 x.md，写入 x.md",
		);
		expect(turnStepLabel(cell("import pathlib\np = pathlib.Path('/tmp/x/demo.md')\np.write_text('a')"))).toBe(
			"写入 demo.md",
		);
	});

	it("falls back to a generic verb when the path variable is unknown", () => {
		expect(turnStepLabel(cell("lines = p.read_text().splitlines()\np.write_text('\\n'.join(lines))"))).toBe(
			"读取文件，写入文件",
		);
	});

	it("labels open() writes, Path reads and directory listings", () => {
		expect(turnStepLabel(cell("with open('out.txt', 'w') as f:\n    f.write('x')"))).toBe("写入 out.txt");
		expect(turnStepLabel(cell("from pathlib import Path\nprint(Path('a/b.md').read_text())"))).toBe("读取 b.md");
		expect(turnStepLabel(cell("import os\nentries = sorted(os.listdir('packages'))"))).toBe("列目录 packages");
		expect(turnStepLabel(cell("for p in Path('src').rglob('*.ts'):\n    print(p)"))).toBe("列目录 src");
	});

	it("caps a cell at three effects", () => {
		const code = "open('a.txt').read()\nopen('b.txt').read()\nopen('c.txt').read()\nopen('d.txt').read()";
		expect(turnStepLabel(cell(code))).toBe("读取 a.txt，读取 b.txt，读取 c.txt");
	});

	it("reads an unrecognized python cell, or one without code, as python", () => {
		expect(turnStepLabel(cell("x = 1 + 2\nprint(x)"))).toBe("python");
		expect(turnStepLabel({ toolName: "ipython", args: {} })).toBe("python");
		expect(turnStepLabel({ toolName: "ipython", args: undefined })).toBe("python");
	});

	it("labels the built-in tools by verb and path tail", () => {
		expect(turnStepLabel({ toolName: "bash", args: { command: "npm test\necho done" } })).toBe("运行 npm test");
		expect(turnStepLabel({ toolName: "bash", args: {} })).toBe("运行命令");
		expect(turnStepLabel({ toolName: "read", args: { path: "src/core/footer.ts" } })).toBe("读取 footer.ts");
		expect(turnStepLabel({ toolName: "write", args: { file_path: "docs/a.md" } })).toBe("写入 a.md");
		expect(turnStepLabel({ toolName: "edit", args: { path: "src/b.ts" } })).toBe("编辑 b.ts");
		expect(turnStepLabel({ toolName: "edit", args: {} })).toBe("编辑");
		expect(turnStepLabel({ toolName: "grep", args: { pattern: "contextWindow" } })).toBe("搜索 contextWindow");
		expect(turnStepLabel({ toolName: "ls", args: { path: "packages" } })).toBe("列目录 packages");
		expect(turnStepLabel({ toolName: "custom_tool", args: {} })).toBe("custom_tool");
	});
});

describe("turnStepLabel template holes", () => {
	it("never shows raw f-string holes", () => {
		const code = "for sha in shas:\n    open(f'/tmp/{sha}.diff', 'w').write(out)";
		expect(turnStepLabel({ toolName: "ipython", args: { code } })).toBe("写入 ….diff");
	});
});

describe("search labels", () => {
	it("drop regex escapes and anchors from the pattern", () => {
		const bash = (command: string) => turnStepLabel({ toolName: "bash", args: { command } });
		expect(bash('grep -rn "\\bText\\b" packages')).toBe("搜索 Text");
		expect(bash('grep -rn "^export" src')).toBe("搜索 export");
		expect(bash("rg -n")).toBe("搜索");
	});
});

describe("turnStepsSummary", () => {
	it("groups labels by verb in first-seen order, deduped by toolCallId", () => {
		const steps = [
			{ toolCallId: "a", toolName: "read", args: { path: "src/footer.ts" } },
			{ toolCallId: "a", toolName: "read", args: { path: "src/footer.ts" } },
			{ toolCallId: "b", toolName: "bash", args: { command: "npm test" } },
			{ toolCallId: "c", toolName: "read", args: { path: "lib/footer.ts" } },
		];
		expect(turnStepsSummary(steps)).toBe("读取 footer.ts · 运行 npm test");
	});

	it("is empty for a turn without steps", () => {
		expect(turnStepsSummary([])).toBe("");
	});
});

describe("turnStepLabel harness calls", () => {
	it("resolves string path variables for open(), edit() and bash f-strings", () => {
		expect(turnStepLabel(cell('path = "/tmp/x/shop.md"\nwith open(path) as f:\n    print(f.read())'))).toBe(
			"读取 shop.md",
		);
		expect(turnStepLabel(cell('await edit(path="src/a.py", old_str="x", new_str="y")'))).toBe("编辑 a.py");
		expect(turnStepLabel(cell('res = await edit(path=path, old_str="bread", new_str="milk")'))).toBe("编辑文件");
		expect(turnStepLabel(cell('path = "/tmp/x/shop.md"\nr = await bash(f"wc -l {path}")'))).toBe(
			"运行 wc -l shop.md",
		);
	});

	it("names subagent, messaging, image, search and memory calls", () => {
		expect(turnStepLabel(cell("h = await rlm('数文件', name='counter')\nrows = await rlm.list_subagents()"))).toBe(
			"派子代理，查看子代理",
		);
		expect(turnStepLabel(cell("snaps = await rlm.collect(timeout_ms=0)"))).toBe("查看子代理");
		expect(turnStepLabel(cell("await agent_message.send('done', receiver_role='parent')"))).toBe("发消息");
		expect(turnStepLabel(cell("print(await attach_image('a.png'))"))).toBe("看图");
		expect(turnStepLabel(cell("hits = await bailian_search.search('天气')"))).toBe("联网搜索");
		expect(turnStepLabel(cell("rlm.harness.create_memory('t', 'c')"))).toBe("记笔记");
	});
});
