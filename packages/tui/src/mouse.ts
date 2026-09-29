export interface MouseEvent {
	/** Base SGR button code with modifier and motion bits removed; wheel up/down are 64/65. */
	button: number;
	/** One-based terminal column. */
	x: number;
	/** One-based terminal row. */
	y: number;
	/** True for SGR `M` reports (press, wheel, drag, or hover move), false for release `m`. */
	press: boolean;
	/** Whether the SGR motion bit is set. */
	motion: boolean;
	/** Modifier bits carried by the SGR report. */
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export const MOUSE_WHEEL_UP = 64;
export const MOUSE_WHEEL_DOWN = 65;
export const MOUSE_BUTTON_LEFT = 0;
/** SGR button code of a move with no button held (reported as 35 = 3 + motion bit). */
export const MOUSE_BUTTON_NONE = 3;

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const LEGACY_MOUSE_PATTERN = /^\x1b\[M([\s\S])([\s\S])([\s\S])$/;
const MODIFIER_SHIFT = 4;
const MODIFIER_ALT = 8;
const MODIFIER_CTRL = 16;
const MOTION_BIT = 32;

export function isMouseSequence(sequence: string): boolean {
	return sequence.startsWith("\x1b[<") || sequence.startsWith("\x1b[M");
}

export function parseSgrMouseEvent(sequence: string): MouseEvent | null {
	const match = sequence.match(SGR_MOUSE_PATTERN);
	if (!match) return null;
	const raw = Number(match[1]);
	return {
		button: raw & ~(MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_CTRL | MOTION_BIT),
		x: Number(match[2]),
		y: Number(match[3]),
		press: match[4] === "M",
		motion: (raw & MOTION_BIT) !== 0,
		shift: (raw & MODIFIER_SHIFT) !== 0,
		alt: (raw & MODIFIER_ALT) !== 0,
		ctrl: (raw & MODIFIER_CTRL) !== 0,
	};
}

/** A pointer move with no button held: the only report ?1003 adds over ?1002. */
export function isMouseHover(event: MouseEvent): boolean {
	return event.press && event.motion && event.button === MOUSE_BUTTON_NONE;
}

// X10 coordinates are one byte, 32 + value. Stdin is decoded as UTF-8, which turns a
// byte above 127 (column 96 and beyond) into U+FFFD; such a coordinate has no position.
function legacyCoordinate(char: string): number {
	const code = char.charCodeAt(0);
	return code > 32 && code <= 255 ? code - 32 : 0;
}

/** The pointer move a report carries, in the SGR or the legacy `ESC [ M` encoding; null for anything else. */
export function parseMouseHover(sequence: string): MouseEvent | null {
	const sgr = parseSgrMouseEvent(sequence);
	if (sgr) return isMouseHover(sgr) ? sgr : null;
	const legacy = sequence.match(LEGACY_MOUSE_PATTERN);
	if (!legacy) return null;
	const raw = legacy[1]!.charCodeAt(0) - 32;
	if (raw < 0) return null;
	const event: MouseEvent = {
		button: raw & ~(MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_CTRL | MOTION_BIT),
		x: legacyCoordinate(legacy[2]!),
		y: legacyCoordinate(legacy[3]!),
		press: true,
		motion: (raw & MOTION_BIT) !== 0,
		shift: (raw & MODIFIER_SHIFT) !== 0,
		alt: (raw & MODIFIER_ALT) !== 0,
		ctrl: (raw & MODIFIER_CTRL) !== 0,
	};
	return isMouseHover(event) ? event : null;
}

export function isWheelUp(event: MouseEvent): boolean {
	return event.press && event.button === MOUSE_WHEEL_UP;
}

export function isWheelDown(event: MouseEvent): boolean {
	return event.press && event.button === MOUSE_WHEEL_DOWN;
}
