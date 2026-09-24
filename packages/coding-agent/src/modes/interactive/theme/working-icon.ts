// Shared "still working" indicator used across the agents view, the chat
// subagent tray, and in-progress tool markers so motion reads consistently.
export const WORKING_ICON_FRAMES = ["◇", "◈", "◆", "◈"] as const;
export const WORKING_ICON_INTERVAL_MS = 250;

/** The braille spinner of the live running card and the footer chip (about 10 frames a second). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 100;

export function workingIconFrame(frame: number): string {
	const frames = WORKING_ICON_FRAMES;
	return frames[((frame % frames.length) + frames.length) % frames.length] ?? frames[0];
}

/** The spinner glyph for a tick count; `slow` turns it at a third of the speed (a quiet step). */
export function spinnerFrame(tick: number, slow = false): string {
	const step = slow ? Math.floor(tick / 3) : tick;
	const frames = SPINNER_FRAMES;
	return frames[((step % frames.length) + frames.length) % frames.length] ?? frames[0];
}

// Process-wide tick counter, advanced every SPINNER_INTERVAL_MS by the
// interactive mode's single ticker and read during render. The slower ◇◈◆
// markers derive their frame from it, so one ticker drives both.
let pulseTick = 0;

/** Frame for the ◇◈◆ markers (one frame per WORKING_ICON_INTERVAL_MS). */
export function getWorkingPulseFrame(): number {
	return Math.floor((pulseTick * SPINNER_INTERVAL_MS) / WORKING_ICON_INTERVAL_MS);
}

/** Tick for the braille spinner (one per SPINNER_INTERVAL_MS). */
export function getSpinnerTick(): number {
	return pulseTick;
}

export function setWorkingPulseTick(tick: number): void {
	pulseTick = tick;
}
