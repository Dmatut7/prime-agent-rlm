const DISPLAY_ID_LENGTH = 12;
const HEX_ID_PATTERN = /^[0-9a-f]+$/;

export function formatSessionDisplayId(id: string): string {
	const normalized = normalizeHexSessionId(id);
	if (!normalized) {
		return id.length > DISPLAY_ID_LENGTH ? id.slice(-DISPLAY_ID_LENGTH) : id;
	}
	return normalized.length > DISPLAY_ID_LENGTH ? normalized.slice(-DISPLAY_ID_LENGTH) : normalized;
}

export function matchesSessionIdSuffix(candidate: string, suffix: string): boolean {
	const normalizedCandidate = normalizeHexSessionId(candidate);
	const normalizedSuffix = normalizeHexSessionId(suffix);
	return !!normalizedCandidate && !!normalizedSuffix && normalizedCandidate.endsWith(normalizedSuffix);
}

export function matchesSavedSessionSelector(candidate: string, selector: string): boolean {
	const normalizedCandidate = normalizeHexSessionId(candidate);
	const normalizedSelector = normalizeHexSessionId(selector);
	if (normalizedCandidate && normalizedSelector) {
		return normalizedCandidate.startsWith(normalizedSelector) || normalizedCandidate.endsWith(normalizedSelector);
	}
	return candidate.startsWith(selector);
}

export function normalizeSessionId(id: string): string {
	return id.replaceAll("-", "").toLowerCase();
}

function normalizeHexSessionId(id: string): string | undefined {
	const normalized = normalizeSessionId(id);
	return normalized && HEX_ID_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * A session id is also a file name stem and an artifact directory name, so the
 * pattern lives here (no imports) and is shared by the session manager, the
 * artifact-path helpers, and the artifact tombstones.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function assertValidSessionId(sessionId: string): void {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(
			"Invalid session id: expected 1-128 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit",
		);
	}
}

/** Whether `value` may serve as a session id, and therefore as a session file stem. */
export function isValidSessionId(value: string): boolean {
	return SESSION_ID_PATTERN.test(value);
}
