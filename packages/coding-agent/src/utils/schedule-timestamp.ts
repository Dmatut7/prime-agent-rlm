/**
 * One clock face for schedule timestamps (a heartbeat's next/last run, a cron
 * job's runs): the local timezone, `YYYY-MM-DD HH:mm`.
 *
 * The same `nextRunAt` used to reach the screen three different ways - the
 * heartbeat management panel printed UTC (`toISOString().slice(0, 16)`, eight
 * hours off for a Shanghai user with no timezone label), the chat status lines
 * printed the raw ISO string, and /crons printed `toLocaleString()`. One value,
 * three answers. Every face now formats through here instead, minutes being
 * the scheduler's resolution.
 */
export function formatScheduleTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	const pad = (part: number): string => String(part).padStart(2, "0");
	return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
