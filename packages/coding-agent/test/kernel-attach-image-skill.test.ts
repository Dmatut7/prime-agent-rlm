import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { PythonSkillRuntimeInfo, Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { IpythonKernelProvisioner, imageBlocksFromAttachments } from "../src/core/tools/ipython.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "aGk=" };

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function bundledAttachImageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "attach-image");
	return {
		name: "attach-image",
		importName: "attach_image",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("attach-image skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-attach-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads an on-disk image into the tool result as an ImageContent block", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`print(await attach_image(${JSON.stringify(imagePath)}))`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("Loaded 1 image(s) into context");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/png");
		expect(result.attachments?.[0]?.data).toBe(PNG_BASE64);

		const blocks = imageBlocksFromAttachments(result.attachments);
		expect(blocks).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("compresses large attached images before storing them in the tool result", { retry: 1 }, async () => {
		const imagePath = join(tempDir, "large.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
img = Image.new("RGB", (2400, 1800), (32, 64, 96))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("Resized for efficient inline rendering/replay");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("reports when compressed animated images are flattened to their first frame", { retry: 1 }, async () => {
		const imagePath = join(tempDir, "animated.gif");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
frames = [Image.new("RGB", (1300, 10), color) for color in ("red", "blue")]
frames[0].save(${JSON.stringify(imagePath)}, save_all=True, append_images=frames[1:], duration=50, loop=0)
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("animated image flattened to first frame");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("uses a neutral background when compressing transparent images", async () => {
		const imagePath = join(tempDir, "transparent.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image, ImageDraw
img = Image.new("RGBA", (1300, 10), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rectangle((0, 0, 1299, 9), fill=(255, 255, 255, 255))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("transparent pixels composited on #888888 background");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("rejects oversized pixel counts before loading an image into context", async () => {
		const imagePath = join(tempDir, "huge.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 6001, 6001, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(imagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(imagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("images must be at most 36MP");
		expect(result.attachments).toBeUndefined();
	});

	it("rejects undecodable images before emitting any attachment", async () => {
		const validImagePath = join(tempDir, "valid.png");
		const corruptImagePath = join(tempDir, "corrupt.png");
		writeFileSync(validImagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 10, 10, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(corruptImagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(validImagePath)}, ${JSON.stringify(corruptImagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("is not a readable supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("errors without emitting an attachment when the model is not vision-capable", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "openai/gpt-oss-120b", input: ["text"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(imagePath)})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"RuntimeError: openai/gpt-oss-120b does not support vision. " +
				"Tell the user to set imageModel in settings.json to a vision model (it reads images " +
				"for this one), or to switch to a vision-capable model.",
		);
		expect(result.attachments).toBeUndefined();
	});

	it("rejects a non-image file", async () => {
		const notImage = join(tempDir, "notes.txt");
		writeFileSync(notImage, "just text");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(notImage)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("is not a supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("fails the cell loudly when an emitted attachment exceeds the size cap", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, { pythonSkills: [] });
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from rlm import emit
emit({"application/vnd.prime-agent.attachment+json": {"mime_type": "image/png", "data": "A" * 10_000_001}})
print("done")
`);

		expect(result.status).toBe("error");
		expect(result.stderr).toContain("attachment dropped");
		expect(result.attachments).toBeUndefined();
	});
});

function attachToolCallMessage(id: string, code: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("model.info over a session's kernel host bridge", () => {
	// attach_image's preflight asks the host for model.info and rejects when the
	// reported model has no image input. The handler must answer with the model
	// that will read the attached image: a routed image turn serves on
	// settings.imageModel, and so does the request after an attach on an
	// image-free turn of a text-only session model (the owner pasted a file path
	// as text). Only without a usable imageModel does the attach reject.
	interface SessionFixture {
		session: AgentSession;
		servedIds: string[];
		dir: string;
	}

	function createAttachSession(
		settings: Record<string, unknown>,
		reply: (call: number, attachCode: string) => AssistantMessage = (call, attachCode) =>
			call === 1 ? attachToolCallMessage("call-1", attachCode) : assistantMsg("ok"),
	): SessionFixture {
		const dir = mkdtempSync(join(tmpdir(), "pi-attach-image-session-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		writeFileSync(join(dir, "sample.png"), Buffer.from(PNG_BASE64, "base64"));
		const base = getModel("anthropic", "claude-opus-4-7")!;
		const sessionModel = { ...base, id: "claude-opus-4-7-text-only", input: ["text"] } as typeof base;
		const packagePath = join(getBundledSkillsDir(), "attach-image");
		const skillFilePath = join(packagePath, "SKILL.md");
		const attachImageSkill: Skill = {
			name: "attach-image",
			description: "test",
			filePath: skillFilePath,
			baseDir: packagePath,
			sourceInfo: createSyntheticSourceInfo(skillFilePath, { source: "test" }),
			disableModelInvocation: false,
			kind: "python",
			python: {
				importName: "attach_image",
				packagePath,
				pyprojectPath: join(packagePath, "pyproject.toml"),
			},
		};
		const servedIds: string[] = [];
		let call = 0;
		const attachCode = `print(await attach_image(${JSON.stringify(join(dir, "sample.png"))}))`;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: sessionModel, systemPrompt: "Test", tools: [] },
			streamFn: (model) => {
				servedIds.push(model.id);
				call += 1;
				const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
					(e) => e.type === "done",
					(e: any) => e.message,
				);
				const message = reply(call, attachCode);
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				return stream;
			},
		});
		const auth = AuthStorage.create(join(dir, "auth.json"));
		auth.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(dir, dir),
			cwd: dir,
			modelRegistry: ModelRegistry.create(auth, join(dir, "models.json")),
			resourceLoader: createTestResourceLoader({ skills: [attachImageSkill] }),
		});
		return { session, servedIds, dir };
	}

	function ipythonToolResults(session: AgentSession): ToolResultMessage[] {
		return session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "ipython",
		);
	}

	function cleanupSessionDir(dir: string): void {
		// A disposed kernel can still be flushing its final snapshot writes; retry
		// briefly so a green suite never fails on ENOTEMPTY.
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				rmSync(dir, { recursive: true, force: true });
				return;
			} catch (error) {
				if (attempt === 19) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
			}
		}
	}

	it("lets a routed image turn attach images: model.info reports the serving image model", async () => {
		const fixture = createAttachSession({ imageModel: "claude-haiku-4-5" });
		try {
			await fixture.session.prompt("describe", { images: [IMAGE] });
			expect(fixture.servedIds).toEqual(["claude-haiku-4-5", "claude-haiku-4-5"]);
			const results = ipythonToolResults(fixture.session);
			expect(results).toHaveLength(1);
			expect(results[0].isError).toBe(false);
			expect(results[0].content).toEqual([
				{ type: "text", text: expect.stringContaining("Loaded 1 image(s) into context") },
				{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			]);
		} finally {
			fixture.session.dispose();
			cleanupSessionDir(fixture.dir);
		}
	});

	it("routes an attach on an image-free turn to imageModel, then hands the task back", async () => {
		const fixture = createAttachSession({ imageModel: "claude-haiku-4-5" }, (call, attachCode) => {
			if (call === 1) return attachToolCallMessage("call-1", attachCode);
			if (call === 2) {
				const next = attachToolCallMessage("call-2", 'print("next")');
				return { ...next, content: [{ type: "text", text: "A single gray pixel." }, ...next.content] };
			}
			return assistantMsg("ok");
		});
		try {
			await fixture.session.prompt(`describe ${join(fixture.dir, "sample.png")}`);
			expect(fixture.servedIds).toEqual([
				"claude-opus-4-7-text-only",
				"claude-haiku-4-5",
				"claude-opus-4-7-text-only",
			]);
			const results = ipythonToolResults(fixture.session);
			expect(results).toHaveLength(2);
			expect(results[0].isError).toBe(false);
			expect(results[0].content).toEqual([
				{ type: "text", text: expect.stringContaining("Loaded 1 image(s) into context") },
				{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			]);
		} finally {
			fixture.session.dispose();
			cleanupSessionDir(fixture.dir);
		}
	});

	it("rejects attach on a text-only session model without a usable imageModel", async () => {
		const fixture = createAttachSession({});
		try {
			await fixture.session.prompt("describe");
			expect(fixture.servedIds).toEqual(["claude-opus-4-7-text-only", "claude-opus-4-7-text-only"]);
			const results = ipythonToolResults(fixture.session);
			expect(results).toHaveLength(1);
			// A failed cell reports its traceback in the result text: the vision
			// rejection must be there, and no image block may ride along.
			expect(results[0].content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("claude-opus-4-7-text-only does not support vision"),
			});
			expect(results[0].content.some((block) => block.type === "image")).toBe(false);
			expect((results[0].details as { status?: string }).status).toBe("error");
		} finally {
			fixture.session.dispose();
			cleanupSessionDir(fixture.dir);
		}
	});
});
