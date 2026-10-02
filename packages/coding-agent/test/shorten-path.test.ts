import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { shortenPathHome, shortenPathToWidth } from "../src/utils/shorten-path.js";

describe("shortenPathHome", () => {
	it("contracts a path under the home directory to tilde notation", () => {
		expect(shortenPathHome(`${os.homedir()}/work/file.ts`)).toBe("~/work/file.ts");
	});

	it("contracts the home directory itself to a bare tilde", () => {
		expect(shortenPathHome(os.homedir())).toBe("~");
	});

	it("leaves paths outside the home directory unchanged", () => {
		expect(shortenPathHome("/etc/passwd")).toBe("/etc/passwd");
		expect(shortenPathHome("relative/path.ts")).toBe("relative/path.ts");
	});

	it("returns an empty string for non-string input", () => {
		expect(shortenPathHome(undefined)).toBe("");
		expect(shortenPathHome(null)).toBe("");
		expect(shortenPathHome(42)).toBe("");
	});
});

describe("shortenPathToWidth (default: strip strategy)", () => {
	it("returns the path unchanged when it fits", () => {
		expect(shortenPathToWidth("src/foo.ts", 10)).toBe("src/foo.ts");
	});

	it("drops leading segments greedily until the path fits", () => {
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 16)).toBe("…/beta/gamma.ts");
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 10)).toBe("…/gamma.ts");
	});

	it("keeps as many trailing segments of an absolute path as fit (no cap)", () => {
		// "…/bb/cc/dd.ts" is exactly 13 columns: the strip strategy keeps 3 segments.
		expect(shortenPathToWidth("/aa/bb/cc/dd.ts", 13)).toBe("…/bb/cc/dd.ts");
	});

	it("does not filter empty segments", () => {
		expect(shortenPathToWidth("aa//bb", 5)).toBe("…//bb");
	});

	it("truncates the file name itself when even it alone is too wide", () => {
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 5)).toBe("gamm…");
	});

	it("measures CJK segments in terminal columns", () => {
		expect(shortenPathToWidth("src/审查/文件.ts", 12)).toBe("…/文件.ts");
	});
});

describe("shortenPathToWidth (footnote strategy: absolute cap + empty filtering)", () => {
	const options = { absoluteMaxSegments: 2, filterEmptySegments: true } as const;

	it("caps absolute paths at two trailing segments even when more would fit", () => {
		expect(shortenPathToWidth("/aa/bb/cc/dd.ts", 13, options)).toBe("…/cc/dd.ts");
	});

	it("keeps relative paths uncapped save for the leading segment", () => {
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 16, options)).toBe("…/beta/gamma.ts");
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 10, options)).toBe("…/gamma.ts");
	});

	it("filters empty segments out of the candidates", () => {
		expect(shortenPathToWidth("aa//bb", 5, options)).toBe("…/bb");
	});

	it("truncates the file name itself when even it alone is too wide", () => {
		expect(shortenPathToWidth("alpha/beta/gamma.ts", 5, options)).toBe("gamm…");
	});
});
