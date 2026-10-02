import assert from "node:assert";
import { describe, it } from "node:test";
import { Image, withFullscreenImageFallback } from "../src/components/image.js";
import {
	allocatePlaceholderImageId,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	drainKittyImageTransmits,
	encodeKitty,
	encodeKittyPlaceholderRows,
	getKittyImageTransmitsVersion,
	hyperlink,
	invalidateKittyImageTransmits,
	isImageLine,
	isImageSequenceLine,
	KITTY_PLACEHOLDER_CHAR,
	KITTY_PLACEHOLDER_GRID_LIMIT,
	renderImage,
	renderKittyPlaceholderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.js";
import { sliceByColumn, visibleWidth } from "../src/utils.js";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"PI_ENABLE_GHOSTTY_IMAGES",
	"PI_TERMINAL_KITTY_PLACEHOLDERS",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"CMUX_WORKSPACE_ID",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false under tmux even if outer terminal supports OSC 8", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("defaults Ghostty to Unicode-placeholder kitty images, keeping inline sequences out of redraws", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imagePlaceholders, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("keeps the legacy inline kitty path on Ghostty behind PI_ENABLE_GHOSTTY_IMAGES", () => {
		withEnv({ TERM_PROGRAM: "ghostty", PI_ENABLE_GHOSTTY_IMAGES: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.imagePlaceholders, false);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("disables Ghostty images entirely with PI_TERMINAL_KITTY_PLACEHOLDERS=0", () => {
		withEnv({ TERM_PROGRAM: "ghostty", PI_TERMINAL_KITTY_PLACEHOLDERS: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
	});

	it("suppresses Kitty replies for delete commands", () => {
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.ok(!result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			assert.ok(result);
			assert.ok(result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("restores the cursor to the reserved image row after Kitty rendering", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			assert.strictEqual(typeof imageId, "number");
			assert.deepStrictEqual(lines.slice(0, -1), [""]);
			assert.ok(lines[1].startsWith("\x1b[1A\x1b_G"));
			assert.ok(lines[1].includes(",C=1,"));
			assert.ok(lines[1].includes(`,i=${imageId}`));
			assert.ok(lines[1].endsWith("\x1b[1B"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("keeps compact metadata and its prefix when terminal graphics are unavailable", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ filename: "result.png", fallbackOnly: true, fallbackPrefix: "    ╰─ " },
				{ widthPx: 20, heightPx: 10 },
			);

			assert.deepStrictEqual(image.render(80), ["    ╰─ [result.png · image/png · 20×10]"]);
			assert.strictEqual(image.getRetainedBase64Length(), 0);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("drops the base64 payload after constructing a fallback-only image", () => {
		const payload = "A".repeat(4096);
		const image = new Image(
			payload,
			"image/png",
			{ fallbackColor: (value) => value },
			{ fallbackOnly: true, filename: "shot.png" },
			{ widthPx: 20, heightPx: 10 },
		);
		assert.strictEqual(image.getRetainedBase64Length(), 0);
		assert.deepStrictEqual(image.render(80), ["[shot.png · image/png · 20×10]"]);
		assert.strictEqual(image.getRetainedBase64Length(), 0);
	});

	it("keeps base64 when terminal graphics may still need it", () => {
		const payload = "AAAA";
		const image = new Image(
			payload,
			"image/png",
			{ fallbackColor: (value) => value },
			{ fallbackOnly: false },
			{ widthPx: 20, heightPx: 20 },
		);
		assert.strictEqual(image.getRetainedBase64Length(), payload.length);
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});

describe("kitty unicode placeholders", () => {
	// Row/column diacritics from kitty's gen/rowcolumn-diacritics.txt: index 0 is
	// U+0305, index 1 is U+030D, index 2 is U+030E (the graphics-protocol spec's
	// own examples use exactly these three).
	const DIACRITIC_0 = "\u0305";
	const DIACRITIC_1 = "\u030D";
	const DIACRITIC_2 = "\u030E";

	it("forces placeholder rendering off tmux even when the outer terminal is ghostty", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
		});
	});

	it("keeps kitty itself on the inline path unless placeholders are forced", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			assert.strictEqual(detectCapabilities().imagePlaceholders ?? false, false);
		});
		withEnv({ KITTY_WINDOW_ID: "1", PI_TERMINAL_KITTY_PLACEHOLDERS: "1" }, () => {
			assert.strictEqual(detectCapabilities().imagePlaceholders, true);
		});
	});

	it("keeps wezterm on the inline path unless placeholders are forced", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			assert.strictEqual(detectCapabilities().imagePlaceholders ?? false, false);
		});
		withEnv({ WEZTERM_PANE: "0", PI_TERMINAL_KITTY_PLACEHOLDERS: "1" }, () => {
			assert.strictEqual(detectCapabilities().imagePlaceholders, true);
		});
	});

	it("allocates placeholder image ids in the 24-bit range the foreground color encodes", () => {
		for (let i = 0; i < 32; i++) {
			const id = allocatePlaceholderImageId();
			assert.ok(id >= 1 && id <= 0xffffff, `id ${id} outside 24-bit range`);
		}
	});

	it("encodes each placeholder cell as U+10EEEE plus explicit row and column diacritics", () => {
		const lines = encodeKittyPlaceholderRows({ imageId: 42, columns: 2, rows: 2 });
		assert.strictEqual(lines.length, 2);
		const cell = (row: number, column: number) =>
			KITTY_PLACEHOLDER_CHAR + (row === 0 ? DIACRITIC_0 : DIACRITIC_1) + (column === 0 ? DIACRITIC_0 : DIACRITIC_1);
		assert.strictEqual(lines[0], `\x1b[38;2;0;0;42m${cell(0, 0)}${cell(0, 1)}\x1b[39m`);
		assert.strictEqual(lines[1], `\x1b[38;2;0;0;42m${cell(1, 0)}${cell(1, 1)}\x1b[39m`);
	});

	it("encodes image ids above 24 bits with the spec's third diacritic", () => {
		// The spec's own example: id 33554474 = 42 + (2 << 24) renders with
		// foreground 42 and U+030E (diacritic index 2) as the high byte.
		const lines = encodeKittyPlaceholderRows({ imageId: 33554474, columns: 2, rows: 1 });
		assert.strictEqual(
			lines[0],
			`\x1b[38;2;0;0;42m` +
				`${KITTY_PLACEHOLDER_CHAR}${DIACRITIC_0}${DIACRITIC_0}${DIACRITIC_2}` +
				`${KITTY_PLACEHOLDER_CHAR}${DIACRITIC_0}${DIACRITIC_1}${DIACRITIC_2}` +
				`\x1b[39m`,
		);
	});

	it("clamps placeholder grids to the diacritic table size", () => {
		const lines = encodeKittyPlaceholderRows({ imageId: 7, columns: 400, rows: 400 });
		assert.strictEqual(lines.length, KITTY_PLACEHOLDER_GRID_LIMIT);
		assert.strictEqual(visibleWidth(lines[0]!), KITTY_PLACEHOLDER_GRID_LIMIT);
	});

	it("measures every placeholder row as exactly its column count", () => {
		const lines = encodeKittyPlaceholderRows({ imageId: 42, columns: 17, rows: 5 });
		assert.strictEqual(lines.length, 5);
		for (const line of lines) {
			assert.strictEqual(visibleWidth(line), 17);
		}
	});

	it("slices placeholder rows on cell boundaries without splitting a cell", () => {
		const line = encodeKittyPlaceholderRows({ imageId: 42, columns: 4, rows: 1 })[0]!;
		const sliced = sliceByColumn(line, 1, 2, true);
		assert.strictEqual(visibleWidth(sliced), 2);
		const cells = sliced.match(new RegExp(KITTY_PLACEHOLDER_CHAR, "gu"));
		assert.strictEqual(cells?.length, 2);
	});

	it("recognizes placeholder rows as image lines but not as graphics-sequence lines", () => {
		const row = encodeKittyPlaceholderRows({ imageId: 42, columns: 2, rows: 1 })[0]!;
		assert.strictEqual(isImageLine(row), true);
		assert.strictEqual(isImageSequenceLine(row), false);
		assert.strictEqual(isImageSequenceLine("\x1b_Ga=T,f=100;data\x1b\\"), true);
		assert.strictEqual(isImageSequenceLine("\x1b]1337;File=inline=1:data==\x07"), true);
		assert.strictEqual(isImageSequenceLine("plain text"), false);
	});

	it("renders placeholder lines and queues the transmit once per image id", () => {
		const imageId = allocatePlaceholderImageId();
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const result = renderKittyPlaceholderImage(
				"AAAA",
				{ widthPx: 20, heightPx: 20 },
				{ maxWidthCells: 4, imageId },
			);
			assert.strictEqual(result.imageId, imageId);
			assert.strictEqual(result.columns, 4);
			assert.strictEqual(result.rows, 2);
			assert.strictEqual(result.lines.length, 2);
			for (const line of result.lines) {
				assert.ok(!line.includes("\x1b_G"), "placeholder lines carry no graphics sequences");
				assert.ok(isImageLine(line));
			}

			const firstDrain = drainKittyImageTransmits();
			assert.ok(firstDrain.includes(`\x1b_Ga=T,U=1,f=100,q=2,i=${imageId},c=4,r=2;AAAA\x1b\\`));

			// Same id and geometry: no retransmit.
			renderKittyPlaceholderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 4, imageId });
			assert.strictEqual(drainKittyImageTransmits(), "");

			// Geometry change retransmits so the virtual placement tracks the grid.
			renderKittyPlaceholderImage("AAAA", { widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, imageId });
			const geometryDrain = drainKittyImageTransmits();
			assert.ok(geometryDrain.includes(`,i=${imageId},c=8,r=`));

			// Invalidation (screen switch) forces a retransmit of the next render.
			invalidateKittyImageTransmits();
			renderKittyPlaceholderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 4, imageId });
			assert.ok(drainKittyImageTransmits().includes(`,i=${imageId},`));
		} finally {
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});

	it("chunks large placeholder transmits like encodeKitty does", () => {
		const imageId = allocatePlaceholderImageId();
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			renderKittyPlaceholderImage("A".repeat(5000), { widthPx: 20, heightPx: 20 }, { maxWidthCells: 4, imageId });
			const drained = drainKittyImageTransmits();
			assert.ok(drained.includes(",m=1;"));
			assert.ok(drained.includes("\x1b_Gm=0;"));
		} finally {
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});

	it("bumps the transmit version on invalidation so image components re-render", () => {
		const before = getKittyImageTransmitsVersion();
		invalidateKittyImageTransmits();
		assert.ok(getKittyImageTransmitsVersion() > before);
	});
});

describe("Image component with unicode placeholders", () => {
	const placeholderCaps = { images: "kitty", trueColor: true, hyperlinks: true, imagePlaceholders: true } as const;

	it("renders placeholder rows without any inline graphics sequence", () => {
		setCapabilities(placeholderCaps);
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 4 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(10);
			assert.strictEqual(lines.length, 4);
			for (const line of lines) {
				assert.ok(!line.includes("\x1b_G"));
				assert.ok(line.includes(KITTY_PLACEHOLDER_CHAR));
				assert.strictEqual(visibleWidth(line), 4);
			}
			const imageId = image.getImageId();
			assert.ok(imageId !== undefined && imageId >= 1 && imageId <= 0xffffff);
			assert.ok(drainKittyImageTransmits().includes(`,i=${imageId},c=4,r=4;`));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});

	it("keeps rendering placeholder rows under the fullscreen fallback guard", () => {
		setCapabilities(placeholderCaps);
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 4 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = withFullscreenImageFallback(() => image.render(10));
			assert.strictEqual(lines.length, 4);
			assert.ok(lines.every((line) => line.includes(KITTY_PLACEHOLDER_CHAR)));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});

	it("keeps the textual fallback under the fullscreen guard when placeholders are off", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 4 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = withFullscreenImageFallback(() => image.render(10));
			assert.deepStrictEqual(lines, ["[image/png · 20×20]"]);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("honors fallbackOnly even when placeholders are available", () => {
		setCapabilities(placeholderCaps);
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ fallbackOnly: true },
				{ widthPx: 20, heightPx: 20 },
			);
			assert.deepStrictEqual(image.render(10), ["[image/png · 20×20]"]);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("requeues the transmit when the transmit registry was invalidated", () => {
		setCapabilities(placeholderCaps);
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 4 },
				{ widthPx: 20, heightPx: 20 },
			);
			image.render(10);
			const imageId = image.getImageId();
			drainKittyImageTransmits();

			// A second render is a cache hit and must not requeue.
			image.render(10);
			assert.strictEqual(drainKittyImageTransmits(), "");

			// After invalidation the cached lines are stale: re-render requeues.
			invalidateKittyImageTransmits();
			image.render(10);
			assert.ok(drainKittyImageTransmits().includes(`,i=${imageId},`));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});
});
