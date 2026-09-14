/**
 * The environment switches that mean "send nothing this turn did not ask for".
 *
 * `DO_NOT_TRACK` is the cross-tool opt-out a user sets once for every tool on the machine
 * (consoledonottrack.com); `PI_OFFLINE` is this project's offline switch. Both are read here
 * so that every background outbound path - the startup release check, pseudonymous telemetry
 * and automatic trace sharing - answers the same way, and a path that ignores them is a bug
 * instead of a policy choice.
 *
 * This is deliberately *not* a gate for work the user asked for in this turn: `/share`,
 * `/traces upload-current`, `/traces upload-all` and the tool-download commands are the
 * user's own request, and a file named `DO_NOT_TRACK` must not silently swallow them.
 */

export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";
export const PI_OFFLINE_ENV = "PI_OFFLINE";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * `undefined` for an unset or unrecognized value, so a caller can tell "no opinion" from
 * "explicitly off": `DO_NOT_TRACK=0` must not read as "the user asked for tracking", and an
 * unrelated spelling (`DO_NOT_TRACK=maybe`) must not read as consent either.
 */
export function parseBooleanEnvFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) {
		return true;
	}
	if (FALSE_VALUES.has(normalized)) {
		return false;
	}
	return undefined;
}

export type BackgroundNetworkOptOut = typeof DO_NOT_TRACK_ENV | typeof PI_OFFLINE_ENV;

/**
 * The name of the switch that suppresses background network activity, or `undefined` when
 * nothing was set. Returned as a name rather than a boolean so a caller can tell the user
 * which switch it respected.
 */
export function backgroundNetworkOptOut(env: NodeJS.ProcessEnv = process.env): BackgroundNetworkOptOut | undefined {
	if (parseBooleanEnvFlag(env[DO_NOT_TRACK_ENV]) === true) {
		return DO_NOT_TRACK_ENV;
	}
	if (parseBooleanEnvFlag(env[PI_OFFLINE_ENV]) === true) {
		return PI_OFFLINE_ENV;
	}
	return undefined;
}
