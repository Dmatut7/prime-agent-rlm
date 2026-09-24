import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const skillDir = join(import.meta.dirname, "..", "skills", "web-research");
const skillDoc = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const pkgDir = join(skillDir, "src", "web_research");
const initSource = readFileSync(join(pkgDir, "__init__.py"), "utf8");

function exportedNames(): Set<string> {
	const block = initSource.match(/__all__ = \[([\s\S]*?)\]/)?.[1] ?? "";
	return new Set([...block.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1] as string));
}

// Loads _guard.py by path so the probe needs no third-party packages and skips the package __init__.
function guardProbe(lines: string[]): string {
	return execFileSync(
		"python3",
		[
			"-c",
			[
				"import importlib.util, json, sys",
				"spec = importlib.util.spec_from_file_location('g', sys.argv[1])",
				"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)",
				...lines,
			].join("\n"),
			join(pkgDir, "_guard.py"),
		],
		{ encoding: "utf8" },
	).trim();
}

// The model copies SKILL.md examples verbatim, so every name they use must exist in the module.
describe("web-research SKILL.md", () => {
	it("only names functions the kernel module exports", () => {
		const names = exportedNames();
		expect(names.size).toBeGreaterThan(10);
		const used = [...skillDoc.matchAll(/web_research\.([A-Za-z_]+)/g)].map((m) => m[1] as string);
		expect(used.length).toBeGreaterThan(5);
		for (const name of used) {
			expect(names, `web_research.${name}`).toContain(name);
		}
	});

	it("documents every exported function", () => {
		const functions = [...exportedNames()].filter((n) => n[0] === n[0]?.toLowerCase());
		expect(functions.length).toBeGreaterThan(5);
		for (const name of functions) {
			expect(skillDoc, name).toContain(name);
		}
	});

	it("refuses the final payment step and allows the way to the cart", () => {
		const out = guardProbe([
			"refused = ['Complete Order', 'Place Order', 'Pay Now', '立即付款', '提交订单', '支付']",
			"allowed = ['Order Now', 'Checkout', 'Continue', 'Pay yearly and save 20%', '付款周期', '立即购买']",
			"r = [g.click_refusal({'text': t, 'tag': 'button'}) is not None for t in refused]",
			"a = [g.click_refusal({'text': t, 'tag': 'a'}) is None for t in allowed]",
			"f = [g.fill_refusal({'label': 'Email', 'type': 'email'}) is not None, g.fill_refusal({'label': 'Promo Code'}) is None]",
			"print(json.dumps([all(r), all(a), all(f)]))",
		]);
		expect(out).toBe("[true, true, true]");
	});

	it("keeps price lines when a spec grid fills the printed key lines, and marks every cut", () => {
		// A plan grid used to fill the 40-line quota with "2 GB RAM" rows before the first price.
		const out = execFileSync(
			"python3",
			[
				"-c",
				[
					"import importlib.util, json, sys",
					"spec = importlib.util.spec_from_file_location('l', sys.argv[1])",
					"l = importlib.util.module_from_spec(spec); spec.loader.exec_module(l)",
					"text = '\\n'.join(f'Plan {i}: {i} vCPU, {i * 2} GB RAM' for i in range(1, 91)) + '\\nPlan 90 monthly: $123.45/mo'",
					"shown = l.key_lines(text, limit=40)",
					"marker = l.preview('x' * 5000, 'page')",
					"print(json.dumps([len(shown), 'Plan 90 monthly: $123.45/mo' in shown, 'TRUNCATED: showing 1,500 of 5,000' in marker]))",
				].join("\n"),
				join(pkgDir, "_lines.py"),
			],
			{ encoding: "utf8" },
		).trim();
		expect(out).toBe("[40, true, true]");
	});

	it("forces a headless browser in code", () => {
		const browserSource = readFileSync(join(pkgDir, "_browser.py"), "utf8");
		expect(browserSource).toMatch(/^HEADLESS = True$/m);
		expect(browserSource).toContain('"headless": HEADLESS');
		expect(browserSource).toContain('assert opts["headless"] is True');
	});
});
