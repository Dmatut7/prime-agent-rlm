/**
 * Behavioral regression tests for the exported session HTML viewer (template.js / template.css).
 *
 * The viewer script runs in a browser, so these tests execute it in Node against a minimal
 * DOM that supports exactly the APIs template.js touches. No production logic is stubbed:
 * the only doubles are the browser platform (DOM/window) and the vendored marked/hljs globals.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
const templateCss = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "path", "rect", "circle", "source"]);

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&amp;/g, "&");
}

function escapeForHighlight(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

class MiniText {
	readonly nodeType = 3;
	parentElement: MiniElement | null = null;
	constructor(public text: string) {}
}

type MiniNode = MiniElement | MiniText;

interface MiniEvent {
	target?: MiniElement;
	key?: string;
	preventDefault?: () => void;
	stopPropagation?: () => void;
	pointerId?: number;
	clientX?: number;
	[key: string]: unknown;
}

function findTagEnd(html: string, lt: number): number {
	let quote: string | null = null;
	for (let i = lt + 1; i < html.length; i++) {
		const ch = html[i];
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ">") {
			return i;
		}
	}
	return html.length - 1;
}

function parseAttributes(src: string): Array<[string, string]> {
	const attrs: Array<[string, string]> = [];
	const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m = attrRe.exec(src);
	while (m !== null) {
		attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? ""]);
		m = attrRe.exec(src);
	}
	return attrs;
}

class MiniElement {
	readonly nodeType = 1;
	tagName: string;
	childNodes: MiniNode[] = [];
	parentElement: MiniElement | null = null;
	style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
	value = "";
	onclickCode: string | null = null;
	private attrs = new Map<string, string>();
	private listeners = new Map<string, Array<(e: MiniEvent) => void>>();
	private classSet = new Set<string>();
	dataset: Record<string, string> = {};
	ownerDocument: MiniDocument;

	constructor(tagName: string, ownerDocument: MiniDocument) {
		this.tagName = tagName.toUpperCase();
		this.ownerDocument = ownerDocument;
	}

	get id(): string {
		return this.attrs.get("id") ?? "";
	}

	get className(): string {
		return this.attrs.get("class") ?? "";
	}

	set className(value: string) {
		this.setAttribute("class", value);
	}

	get classList() {
		return {
			add: (...cs: string[]) => {
				for (const c of cs) this.classSet.add(c);
				this.syncClassAttr();
			},
			remove: (...cs: string[]) => {
				for (const c of cs) this.classSet.delete(c);
				this.syncClassAttr();
			},
			toggle: (c: string, force?: boolean) => {
				const want = force === undefined ? !this.classSet.has(c) : force;
				if (want) this.classSet.add(c);
				else this.classSet.delete(c);
				this.syncClassAttr();
				return want;
			},
			contains: (c: string) => this.classSet.has(c),
		};
	}

	private syncClassAttr(): void {
		const value = [...this.classSet].join(" ");
		if (value) this.attrs.set("class", value);
		else this.attrs.delete("class");
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
		if (name === "class") {
			this.classSet = new Set(value.split(/\s+/).filter(Boolean));
		} else if (name.startsWith("data-")) {
			const key = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
			this.dataset[key] = value;
		} else if (name === "onclick") {
			this.onclickCode = value;
		}
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	appendChild(node: MiniNode | MiniFragment): MiniNode | MiniFragment {
		if (node instanceof MiniFragment) {
			for (const child of [...node.childNodes]) this.appendChild(child);
			node.childNodes = [];
			return node;
		}
		if (node.parentElement) {
			const idx = node.parentElement.childNodes.indexOf(node);
			if (idx >= 0) node.parentElement.childNodes.splice(idx, 1);
		}
		node.parentElement = this as unknown as MiniElement;
		this.childNodes.push(node as MiniNode);
		return node as MiniNode;
	}

	removeChild(node: MiniNode): void {
		const idx = this.childNodes.indexOf(node);
		if (idx >= 0) this.childNodes.splice(idx, 1);
		node.parentElement = null;
	}

	get children(): MiniElement[] {
		return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
	}

	get firstElementChild(): MiniElement | null {
		return this.children[0] ?? null;
	}

	get textContent(): string {
		let out = "";
		for (const node of this.childNodes) {
			out += node instanceof MiniText ? decodeEntities(node.text) : node.textContent;
		}
		return out;
	}

	set textContent(text: string) {
		this.childNodes = text ? [new MiniText(text)] : [];
	}

	set innerHTML(html: string) {
		this.childNodes = [];
		for (const node of parseFragment(html, this.ownerDocument)) {
			this.appendChild(node);
		}
	}

	get innerHTML(): string {
		return "";
	}

	cloneNode(deep: boolean): MiniElement {
		const clone = new MiniElement(this.tagName, this.ownerDocument);
		for (const [k, v] of this.attrs) clone.setAttribute(k, v);
		clone.style = { ...this.style };
		clone.value = this.value;
		if (deep) {
			for (const child of this.childNodes) {
				clone.appendChild(child instanceof MiniText ? new MiniText(child.text) : child.cloneNode(true));
			}
		}
		return clone;
	}

	addEventListener(type: string, fn: (e: MiniEvent) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, fn: (e: MiniEvent) => void): void {
		const list = this.listeners.get(type);
		if (!list) return;
		const idx = list.indexOf(fn);
		if (idx >= 0) list.splice(idx, 1);
	}

	dispatch(type: string, event: MiniEvent = {}): void {
		event.target = event.target ?? this;
		event.preventDefault = event.preventDefault ?? (() => {});
		event.stopPropagation = event.stopPropagation ?? (() => {});
		if (type === "click" && this.onclickCode) {
			const fn = new Function("window", "event", this.onclickCode);
			fn.call(this, this.ownerDocument.windowStub, event);
		}
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}

	scrollIntoView(_opts?: unknown): void {}

	getBoundingClientRect(): { width: number } {
		return { width: 400 };
	}

	matches(selector: string): boolean {
		const parts = selector.trim().split(/\s+/);
		return matchesSelectorChain(this, parts);
	}

	querySelectorAll(selector: string): MiniElement[] {
		const out: MiniElement[] = [];
		const parts = selector.trim().split(/\s+/);
		const walk = (el: MiniElement) => {
			for (const child of el.children) {
				if (matchesSelectorChain(child, parts)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}

	querySelector(selector: string): MiniElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

class MiniTemplateElement extends MiniElement {
	content: MiniFragment;
	constructor(ownerDocument: MiniDocument) {
		super("template", ownerDocument);
		this.content = new MiniFragment(ownerDocument);
	}

	override set innerHTML(html: string) {
		this.content.childNodes = [];
		for (const node of parseFragment(html, this.ownerDocument)) {
			this.content.appendChild(node);
		}
	}

	override get innerHTML(): string {
		return "";
	}
}

class MiniFragment {
	childNodes: MiniNode[] = [];
	constructor(public ownerDocument: MiniDocument) {}
	get children(): MiniElement[] {
		return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
	}
	get firstElementChild(): MiniElement | null {
		return this.children[0] ?? null;
	}
	appendChild(node: MiniNode): MiniNode {
		if (node.parentElement) {
			const idx = node.parentElement.childNodes.indexOf(node);
			if (idx >= 0) node.parentElement.childNodes.splice(idx, 1);
		}
		node.parentElement = this as unknown as MiniElement;
		this.childNodes.push(node);
		return node;
	}
}

function parseFragment(html: string, doc: MiniDocument): MiniNode[] {
	const roots: MiniNode[] = [];
	const stack: Array<MiniElement | MiniFragment> = [];
	const top = (): MiniElement | MiniFragment | null => stack[stack.length - 1] ?? null;
	const pushNode = (node: MiniNode) => {
		const parent = top();
		if (parent) parent.appendChild(node);
		else roots.push(node);
	};
	const addText = (text: string) => {
		if (text.length > 0) pushNode(new MiniText(text));
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			addText(html.slice(i));
			break;
		}
		if (lt > i) addText(html.slice(i, lt));
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const gt = findTagEnd(html, lt);
		const tagSrc = html.slice(lt + 1, gt);
		if (tagSrc.startsWith("/")) {
			const name = tagSrc.slice(1).trim().toUpperCase();
			while (stack.length > 0) {
				const popped = stack.pop();
				if (popped instanceof MiniElement && popped.tagName === name) break;
			}
		} else {
			const nameMatch = /^[^\s/>]+/.exec(tagSrc);
			const name = nameMatch ? nameMatch[0] : "";
			const el = doc.createElement(name.toLowerCase());
			for (const [k, v] of parseAttributes(tagSrc.slice(name.length))) el.setAttribute(k, v);
			pushNode(el);
			const selfClosing = tagSrc.trimEnd().endsWith("/");
			if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) stack.push(el);
		}
		i = gt + 1;
	}
	return roots;
}

interface SimpleSelector {
	tag?: string;
	id?: string;
	classes: string[];
	attr?: { name: string; value?: string };
}

function parseSimpleSelector(part: string): SimpleSelector {
	const sel: SimpleSelector = { classes: [] };
	const tagMatch = /^[a-zA-Z][\w-]*/.exec(part);
	let rest = part;
	if (tagMatch) {
		sel.tag = tagMatch[0].toUpperCase();
		rest = rest.slice(tagMatch[0].length);
	}
	const re = /([.#])?([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
	let m = re.exec(rest);
	while (m !== null) {
		if (m[1] === ".") sel.classes.push(m[2]);
		else if (m[1] === "#") sel.id = m[2];
		else if (m[3]) sel.attr = { name: m[3], value: m[4] };
		m = re.exec(rest);
	}
	return sel;
}

function matchesSimple(el: MiniElement, part: string): boolean {
	const sel = parseSimpleSelector(part);
	if (sel.tag && el.tagName !== sel.tag) return false;
	if (sel.id && el.id !== sel.id) return false;
	for (const c of sel.classes) {
		if (!el.classList.contains(c)) return false;
	}
	if (sel.attr) {
		const value = el.getAttribute(sel.attr.name);
		if (value === null) return false;
		if (sel.attr.value !== undefined && value !== sel.attr.value) return false;
	}
	return true;
}

function matchesSelectorChain(el: MiniElement, parts: string[]): boolean {
	if (!matchesSimple(el, parts[parts.length - 1])) return false;
	let current: MiniElement | null = el.parentElement;
	for (let i = parts.length - 2; i >= 0; i--) {
		let found = false;
		while (current) {
			if (matchesSimple(current, parts[i])) {
				found = true;
				current = current.parentElement;
				break;
			}
			current = current.parentElement;
		}
		if (!found) return false;
	}
	return true;
}

class MiniDocument {
	root: MiniElement;
	body: MiniElement;
	documentElement: MiniElement;
	activeElement: MiniElement | null = null;
	windowStub: Record<string, unknown> = {};
	private listeners = new Map<string, Array<(e: MiniEvent) => void>>();

	constructor() {
		this.root = new MiniElement("html", this);
		this.documentElement = this.root;
		this.documentElement.style.setProperty = () => {};
		this.body = new MiniElement("body", this);
		this.root.appendChild(this.body);
	}

	createElement(tag: string): MiniElement {
		if (tag === "template") return new MiniTemplateElement(this);
		return new MiniElement(tag, this);
	}

	createDocumentFragment(): MiniFragment {
		return new MiniFragment(this);
	}

	registerStatic(id: string, tag = "div"): MiniElement {
		const el = new MiniElement(tag, this);
		el.setAttribute("id", id);
		this.body.appendChild(el);
		return el;
	}

	getElementById(id: string): MiniElement | null {
		let found: MiniElement | null = null;
		const walk = (el: MiniElement) => {
			if (found) return;
			if (el.id === id) {
				found = el;
				return;
			}
			for (const child of el.children) walk(child);
		};
		walk(this.root);
		return found;
	}

	querySelectorAll(selector: string): MiniElement[] {
		return this.root.querySelectorAll(selector);
	}

	querySelector(selector: string): MiniElement | null {
		return this.root.querySelector(selector);
	}

	addEventListener(type: string, fn: (e: MiniEvent) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	dispatch(type: string, event: MiniEvent = {}): void {
		event.preventDefault = event.preventDefault ?? (() => {});
		event.stopPropagation = event.stopPropagation ?? (() => {});
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}

	execCommand(_cmd: string): boolean {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Harness: execute template.js against the mini DOM with a synthetic session
// ---------------------------------------------------------------------------

interface SessionEntrySpec {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	message?: Record<string, unknown>;
	[key: string]: unknown;
}

interface Harness {
	document: MiniDocument;
	windowStub: Record<string, unknown>;
	messages: MiniElement;
	treeContainer: MiniElement;
	sidebar: MiniElement;
	searchInput: MiniElement;
	hljsHighlightCalls: number;
	hljsAutoCalls: number;
	keydown: (key: string) => void;
	clickTreeNode: (entryId: string) => void;
	click: (el: MiniElement) => void;
}

/** The vendored marked build, fresh instance per harness so use() never leaks across tests. */
function loadRealMarked(): { use: (opts: unknown) => void; parse: (text: string) => string } {
	const markedJs = readFileSync(new URL("../src/core/export-html/vendor/marked.min.js", import.meta.url), "utf-8");
	const exports: Record<string, unknown> = {};
	new Function("exports", "module", markedJs)(exports, { exports });
	const MarkedCtor = exports.Marked as new () => { use: (opts: unknown) => void; parse: (text: string) => string };
	return new MarkedCtor();
}

function buildHarness(
	entries: SessionEntrySpec[],
	leafId: string,
	opts: { mobile?: boolean; realMarked?: boolean } = {},
): Harness {
	const document = new MiniDocument();
	const treeContainer = document.registerStatic("tree-container");
	document.registerStatic("tree-status");
	document.registerStatic("header-container");
	const messages = document.registerStatic("messages");
	const searchInput = document.registerStatic("tree-search", "input");
	const sidebar = document.registerStatic("sidebar");
	document.registerStatic("sidebar-overlay");
	document.registerStatic("hamburger", "button");
	document.registerStatic("sidebar-resizer");
	document.registerStatic("sidebar-close", "button");
	document.registerStatic("content");

	const sessionDataEl = document.registerStatic("session-data", "script");
	sessionDataEl.textContent = Buffer.from(
		JSON.stringify({ header: { id: "test-session", timestamp: "2026-10-08T00:00:00.000Z" }, entries, leafId }),
	).toString("base64");

	const scrollCalls: unknown[][] = [];
	const windowStub: Record<string, unknown> = {
		location: { search: "", href: "http://localhost/export.html" },
		innerWidth: opts.mobile ? 500 : 1200,
		matchMedia: () => ({ matches: opts.mobile === true }),
		getSelection: () => ({ toString: () => "" }),
		scrollTo: (...args: unknown[]) => scrollCalls.push(args),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	document.windowStub = windowStub;

	const marked = opts.realMarked ? loadRealMarked() : { use: () => {}, parse: (text: string) => text };
	let hljsHighlightCalls = 0;
	let hljsAutoCalls = 0;
	const hljs = {
		highlight: (text: string) => {
			hljsHighlightCalls++;
			return { value: escapeForHighlight(text) };
		},
		highlightAuto: (text: string) => {
			hljsAutoCalls++;
			return { value: escapeForHighlight(text) };
		},
		getLanguage: () => true,
	};
	const localStorage = { getItem: () => null, setItem: () => {} };
	const navigatorStub = {};
	const getComputedStyle = () => ({ getPropertyValue: () => "" });

	const run = new Function(
		"document",
		"window",
		"marked",
		"hljs",
		"localStorage",
		"navigator",
		"getComputedStyle",
		templateJs,
	);
	run(document, windowStub, marked, hljs, localStorage, navigatorStub, getComputedStyle);

	return {
		document,
		windowStub,
		messages,
		treeContainer,
		sidebar,
		searchInput,
		get hljsHighlightCalls() {
			return hljsHighlightCalls;
		},
		get hljsAutoCalls() {
			return hljsAutoCalls;
		},
		keydown: (key: string) => document.dispatch("keydown", { key }),
		clickTreeNode: (entryId: string) => {
			const node = treeContainer.querySelectorAll(".tree-node").find((n) => n.dataset.id === entryId);
			expect(node, `tree node for entry ${entryId}`).toBeDefined();
			node?.dispatch("click");
		},
		click: (el: MiniElement) => el.dispatch("click"),
	};
}

// ---------------------------------------------------------------------------
// Synthetic session builders
// ---------------------------------------------------------------------------

let tsCounter = 0;
function ts(): string {
	return new Date(Date.UTC(2026, 9, 8, 0, 0, tsCounter++)).toISOString();
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntrySpec {
	return { id, parentId, timestamp: ts(), type: "message", message: { role: "user", content: text } };
}

function assistantEntry(
	id: string,
	parentId: string | null,
	content: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): SessionEntrySpec {
	return { id, parentId, timestamp: ts(), type: "message", message: { role: "assistant", content, ...extra } };
}

function toolResultEntry(
	id: string,
	parentId: string,
	toolCallId: string,
	content: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): SessionEntrySpec {
	return {
		id,
		parentId,
		timestamp: ts(),
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "bash", content, isError: false, ...extra },
	};
}

function textBlock(text: string): Record<string, unknown> {
	return { type: "text", text };
}

function toolCallBlock(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}

// ---------------------------------------------------------------------------
// R2-M1: ANSI escape sequences are stripped from tool output
// ---------------------------------------------------------------------------

describe("R2-M1: exported bash output has no raw ANSI escapes", () => {
	it("strips SGR sequences from bash tool results", () => {
		const entries = [
			userEntry("u1", null, "run the tests"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "bash", { command: "npm test" })]),
			toolResultEntry("r1", "a1", "tc1", [
				textBlock("\u001b[31mRED-FAILURE-TEXT\u001b[0m all good\u001b[32mGREEN\u001b[0m"),
			]),
		];
		const h = buildHarness(entries, "r1");
		const text = h.messages.textContent;
		expect(text).toContain("RED-FAILURE-TEXT");
		expect(text).toContain("GREEN");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("[31m");
		expect(text).not.toContain("[32m");
	});

	it("strips ANSI from interactive bashExecution output", () => {
		const entries = [
			userEntry("u1", null, "hello"),
			{
				id: "b1",
				parentId: "u1",
				timestamp: ts(),
				type: "message",
				message: {
					role: "bashExecution",
					command: "ls",
					output: "\u001b[1;34mBLUE-DIR\u001b[0m",
					exitCode: 0,
					cancelled: false,
				},
			},
		];
		const h = buildHarness(entries, "b1");
		expect(h.messages.textContent).toContain("BLUE-DIR");
		expect(h.messages.textContent).not.toContain("\u001b");
	});
});

// ---------------------------------------------------------------------------
// R2-M2: tool result images render for every tool, not only `read`
// ---------------------------------------------------------------------------

describe("R2-M2: non-read tool result images are exported", () => {
	it("renders images from an MCP-style tool result", () => {
		const entries = [
			userEntry("u1", null, "take a screenshot"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "browser_screenshot", { url: "http://x" })]),
			toolResultEntry("r1", "a1", "tc1", [
				textBlock("captured"),
				{ type: "image", data: "QUJD", mimeType: "image/png" },
			]),
		];
		const h = buildHarness(entries, "r1");
		const images = h.messages.querySelectorAll(".tool-image");
		expect(images).toHaveLength(1);
		expect(images[0].getAttribute("src")).toBe("data:image/png;base64,QUJD");
	});
});

// ---------------------------------------------------------------------------
// R2-M3: findToolResult resolves within the current branch only
// ---------------------------------------------------------------------------

describe("R2-M3: tool results resolve against the current path", () => {
	it("shows the current branch's result when a toolCallId exists on two branches", () => {
		const entries = [
			userEntry("u1", null, "shared prefix"),
			assistantEntry("a1", "u1", [textBlock("branch one"), toolCallBlock("tc1", "bash", { command: "echo one" })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock("RESULT-BRANCH-ONE")]),
			assistantEntry("a2", "u1", [textBlock("branch two"), toolCallBlock("tc1", "bash", { command: "echo two" })]),
			toolResultEntry("r2", "a2", "tc1", [textBlock("RESULT-BRANCH-TWO")]),
		];
		const h = buildHarness(entries, "r2");
		const text = h.messages.textContent;
		expect(text).toContain("RESULT-BRANCH-TWO");
		expect(text).not.toContain("RESULT-BRANCH-ONE");

		h.clickTreeNode("a1");
		const textOne = h.messages.textContent;
		expect(textOne).toContain("RESULT-BRANCH-ONE");
		expect(textOne).not.toContain("RESULT-BRANCH-TWO");
	});
});

// ---------------------------------------------------------------------------
// R5-M9: Escape clears search without yanking the reader back to the initial branch
// ---------------------------------------------------------------------------

describe("R5-M9: Escape only clears the tree search", () => {
	it("clears the filter and keeps the current branch", () => {
		const entries = [
			userEntry("u1", null, "shared question"),
			assistantEntry("a1", "u1", [textBlock("ALPHA-BRANCH-ANSWER")]),
			assistantEntry("a2", "u1", [textBlock("BETA-BRANCH-ANSWER")]),
		];
		const h = buildHarness(entries, "a1");
		expect(h.messages.textContent).toContain("ALPHA-BRANCH-ANSWER");

		h.clickTreeNode("a2");
		expect(h.messages.textContent).toContain("BETA-BRANCH-ANSWER");
		expect(h.messages.textContent).not.toContain("ALPHA-BRANCH-ANSWER");

		h.searchInput.value = "zzz-no-match";
		vi.useFakeTimers();
		try {
			h.searchInput.dispatch("input", { target: h.searchInput });
			vi.advanceTimersByTime(200); // search input is debounced
		} finally {
			vi.useRealTimers();
		}
		const filteredCount = h.treeContainer.querySelectorAll(".tree-node").length;
		expect(filteredCount).toBe(1); // only the current leaf survives a no-match query

		h.keydown("Escape");
		expect(h.searchInput.value).toBe("");
		expect(h.treeContainer.querySelectorAll(".tree-node").length).toBe(3);
		expect(h.messages.textContent).toContain("BETA-BRANCH-ANSWER");
		expect(h.messages.textContent).not.toContain("ALPHA-BRANCH-ANSWER");
	});
});

// ---------------------------------------------------------------------------
// R5-M10: T/O toggle state lives on the #messages container and survives branch switches
// ---------------------------------------------------------------------------

describe("R5-M10: thinking/tools toggle state persists across branch navigation", () => {
	const buildToggleSession = () => [
		userEntry("u1", null, "question"),
		assistantEntry("a1", "u1", [{ type: "thinking", thinking: "ALPHA-THINKING" }, textBlock("alpha answer")]),
		assistantEntry("a2", "u1", [{ type: "thinking", thinking: "BETA-THINKING" }, textBlock("beta answer")]),
	];

	it("T writes a no-thinking class on #messages that survives navigation", () => {
		const h = buildHarness(buildToggleSession(), "a1");
		h.keydown("t");
		expect(h.messages.classList.contains("no-thinking")).toBe(true);

		h.clickTreeNode("a2");
		expect(h.messages.textContent).toContain("BETA-THINKING");
		expect(h.messages.classList.contains("no-thinking")).toBe(true);

		h.keydown("t");
		expect(h.messages.classList.contains("no-thinking")).toBe(false);
	});

	it("O writes a tools-expanded class on #messages that survives navigation", () => {
		const entries = [
			userEntry("u1", null, "question"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "bash", { command: "ls" })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock(Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n"))]),
			userEntry("u2", "r1", "other branch"),
			assistantEntry("a2", "r1", [textBlock("second branch answer")]),
		];
		const h = buildHarness(entries, "r1");
		h.keydown("o");
		expect(h.messages.classList.contains("tools-expanded")).toBe(true);
		h.clickTreeNode("u2");
		expect(h.messages.classList.contains("tools-expanded")).toBe(true);
	});

	it("template.css implements the container-class visibility rules", () => {
		expect(templateCss).toMatch(/#messages\.no-thinking \.thinking-text\s*\{[^}]*display:\s*none/);
		expect(templateCss).toMatch(/#messages\.no-thinking \.thinking-collapsed\s*\{[^}]*display:\s*block/);
		expect(templateCss).toMatch(
			/#messages\.tools-expanded \.tool-output\.expandable \.output-full\s*\{[^}]*display:\s*block/,
		);
	});
});

// ---------------------------------------------------------------------------
// R5-M11: collapsed tool outputs build their full DOM lazily
// ---------------------------------------------------------------------------

describe("R5-M11: expandable tool outputs build full content on first expand", () => {
	it("plain outputs render only the preview until expanded", () => {
		const output = Array.from({ length: 20 }, (_, i) => `OUTPUT-LINE-${i}`).join("\n");
		const entries = [
			userEntry("u1", null, "run it"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "bash", { command: "big" })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock(output)]),
		];
		const h = buildHarness(entries, "r1");
		const expandable = h.messages.querySelector(".tool-output.expandable");
		expect(expandable).toBeDefined();
		const full = expandable?.querySelector(".output-full");
		expect(full).toBeDefined();
		expect(full?.children).toHaveLength(0);
		expect(h.messages.textContent).toContain("OUTPUT-LINE-0");
		expect(h.messages.textContent).not.toContain("OUTPUT-LINE-19");

		h.click(expandable as MiniElement);
		expect(expandable?.classList.contains("expanded")).toBe(true);
		expect(full?.children).toHaveLength(20);
		expect(h.messages.textContent).toContain("OUTPUT-LINE-19");
	});

	it("highlighted outputs run hljs on the preview only until expanded", () => {
		const output = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const entries = [
			userEntry("u1", null, "show the file"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "read", { path: "/tmp/x.ts" })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock(output)], { toolName: "read" }),
		];
		const h = buildHarness(entries, "r1");
		const expandable = h.messages.querySelector(".tool-output.expandable");
		expect(expandable).toBeDefined();
		expect(h.hljsHighlightCalls).toBe(1); // preview only, no eager full-text highlight

		h.click(expandable as MiniElement);
		expect(h.hljsHighlightCalls).toBe(2);
		expect(expandable?.querySelector(".output-full")?.textContent).toContain("const v19");
	});
});

// ---------------------------------------------------------------------------
// R5-M12: tapping a tree node on mobile closes the full-width sidebar
// ---------------------------------------------------------------------------

describe("R5-M12: tree navigation closes the sidebar on mobile", () => {
	it("closes an open sidebar after a tree node click in mobile layout", () => {
		const entries = [
			userEntry("u1", null, "shared question"),
			assistantEntry("a1", "u1", [textBlock("ALPHA-BRANCH-ANSWER")]),
			assistantEntry("a2", "u1", [textBlock("BETA-BRANCH-ANSWER")]),
		];
		const h = buildHarness(entries, "a1", { mobile: true });
		h.sidebar.classList.add("open");

		h.clickTreeNode("a2");
		expect(h.messages.textContent).toContain("BETA-BRANCH-ANSWER");
		expect(h.sidebar.classList.contains("open")).toBe(false);
	});

	it("leaves the sidebar alone in desktop layout", () => {
		const entries = [
			userEntry("u1", null, "shared question"),
			assistantEntry("a1", "u1", [textBlock("ALPHA-BRANCH-ANSWER")]),
			assistantEntry("a2", "u1", [textBlock("BETA-BRANCH-ANSWER")]),
		];
		const h = buildHarness(entries, "a1");
		h.sidebar.classList.add("open");
		h.clickTreeNode("a2");
		expect(h.sidebar.classList.contains("open")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// R5-M13: long URLs wrap instead of forcing page-wide horizontal scroll
// ---------------------------------------------------------------------------

describe("R5-M13: markdown content wraps long unbreakable text", () => {
	it("template.css sets overflow-wrap on .markdown-content", () => {
		expect(templateCss).toMatch(/\.markdown-content\s*\{[^}]*overflow-wrap:\s*anywhere/);
	});
});

// ---------------------------------------------------------------------------
// w7-render: Low-tier export batch (truncation graphemes, theme vars, dead
// image modal, highlightAuto, search debounce, empty-node feedback, remote
// images, class-name fork)
// ---------------------------------------------------------------------------

describe("w7-render: tree previews cut at grapheme boundaries", () => {
	it("does not halve an astral character at the truncation boundary", () => {
		const text = `${"a".repeat(99)}🙂 tail`;
		const h = buildHarness([userEntry("u1", null, text)], "u1");
		const node = h.treeContainer.querySelectorAll(".tree-node").find((n) => n.dataset.id === "u1");
		const preview = node?.textContent ?? "";
		expect(preview).toContain("🙂");
		expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
	});

	it("cuts a bash tool call's command at a grapheme boundary", () => {
		// "run " (4 units) + 45 letters puts the emoji astride the 50-unit cut.
		const command = `run ${"a".repeat(45)}🙂 --force`;
		const entries = [
			userEntry("u1", null, "run it"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "bash", { command })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock("done")]),
		];
		const h = buildHarness(entries, "r1");
		const toolNode = h.treeContainer
			.querySelectorAll(".tree-node")
			.find((n) => (n.textContent ?? "").includes("[bash:"));
		const preview = toolNode?.textContent ?? "";
		expect(preview).toContain("🙂");
		expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
	});
});

describe("w7-render: template.css variable and class wiring", () => {
	it("references no undefined --hover variable", () => {
		expect(templateCss).not.toContain("--hover");
	});

	it("styles the tree-custom class the JS emits for custom_message entries", () => {
		expect(templateCss).toMatch(/\.tree-custom[\s,{]/);
		const entries = [
			userEntry("u1", null, "q"),
			{
				id: "c1",
				parentId: "u1",
				timestamp: ts(),
				type: "custom_message",
				customType: "hook",
				display: true,
				content: "did a thing",
			},
		];
		const h = buildHarness(entries, "c1");
		expect(h.treeContainer.querySelector(".tree-custom")).not.toBeNull();
	});

	it("ships no dead image-modal markup or references", () => {
		const templateHtml = readFileSync(new URL("../src/core/export-html/template.html", import.meta.url), "utf-8");
		expect(templateHtml).not.toContain("image-modal");
		expect(templateJs).not.toContain("image-modal");
		expect(templateCss).not.toContain("image-modal");
	});
});

describe("w7-render: markdown rendering in the export", () => {
	it("degrades remote images to links so opening the export does not phone home", () => {
		const entries = [
			userEntry("u1", null, "show me"),
			assistantEntry("a1", "u1", [textBlock("look: ![cat](https://tracker.example/pixel.png) done")]),
		];
		const h = buildHarness(entries, "a1", { realMarked: true });
		const remote = h.messages
			.querySelectorAll("img")
			.filter((img) => /^(?:https?:)?\/\//.test(img.getAttribute("src") ?? ""));
		expect(remote).toHaveLength(0);
		const link = h.messages.querySelector("a.image-link");
		expect(link?.getAttribute("href")).toBe("https://tracker.example/pixel.png");
		expect(link?.textContent).toBe("cat");
	});

	it("keeps local images as images", () => {
		const entries = [
			userEntry("u1", null, "show me"),
			assistantEntry("a1", "u1", [textBlock("![diagram](images/arch.png)")]),
		];
		const h = buildHarness(entries, "a1", { realMarked: true });
		const img = h.messages.querySelector("img");
		expect(img?.getAttribute("src")).toBe("images/arch.png");
	});

	it("does not run highlightAuto on code blocks without a language", () => {
		const entries = [
			userEntry("u1", null, "q"),
			assistantEntry("a1", "u1", [textBlock("```\nplain prose block\n```")]),
		];
		const h = buildHarness(entries, "a1", { realMarked: true });
		expect(h.hljsAutoCalls).toBe(0);
		expect(h.messages.textContent).toContain("plain prose block");
	});

	it("still highlights code blocks that name a language", () => {
		const entries = [userEntry("u1", null, "q"), assistantEntry("a1", "u1", [textBlock("```js\nlet x = 1\n```")])];
		const h = buildHarness(entries, "a1", { realMarked: true });
		expect(h.hljsHighlightCalls).toBeGreaterThan(0);
	});
});

describe("w7-render: tree search debounce and empty-node feedback", () => {
	it("debounces tree search input into one rebuild", () => {
		const entries = [userEntry("u1", null, "shared question"), assistantEntry("a1", "u1", [textBlock("answer")])];
		const h = buildHarness(entries, "a1");
		let appended = 0;
		const container = h.treeContainer;
		const originalAppend = container.appendChild.bind(container);
		container.appendChild = (node) => {
			appended++;
			return originalAppend(node);
		};

		vi.useFakeTimers();
		try {
			h.searchInput.value = "zzz";
			h.searchInput.dispatch("input", { target: h.searchInput });
			h.searchInput.value = "zzz-n";
			h.searchInput.dispatch("input", { target: h.searchInput });
			// Two keystrokes, no synchronous rebuild.
			expect(appended).toBe(0);
			expect(h.treeContainer.querySelectorAll(".tree-node")).toHaveLength(2);

			vi.advanceTimersByTime(200);
			expect(h.treeContainer.querySelectorAll(".tree-node")).toHaveLength(1);
			// Exactly one rebuild for the collapsed keystrokes (one node survives).
			expect(appended).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("says when a clicked tree node has no rendered content", () => {
		// Tool results show in the default tree filter but render no block of their
		// own (they fold into the tool execution), so clicking one used to be silent.
		const entries = [
			userEntry("u1", null, "q"),
			assistantEntry("a1", "u1", [toolCallBlock("tc1", "bash", { command: "ls" })]),
			toolResultEntry("r1", "a1", "tc1", [textBlock("output")]),
		];
		const h = buildHarness(entries, "r1");
		const status = h.document.getElementById("tree-status");
		expect(status?.textContent).not.toContain("no rendered content");

		vi.useFakeTimers();
		try {
			h.clickTreeNode("r1");
			vi.advanceTimersByTime(0); // the scroll/feedback step is deferred
			expect(status?.textContent).toContain("no rendered content");
			vi.advanceTimersByTime(3000); // feedback restores the entry count
			expect(status?.textContent).not.toContain("no rendered content");
		} finally {
			vi.useRealTimers();
		}
	});
});
