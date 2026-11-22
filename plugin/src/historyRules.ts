export interface Copy {
	path: string;
	time: number;
	size: number;
	deleted?: boolean;
}

const DAY = 24 * 60 * 60_000;
export const MAX_BYTES = 50 * 1024 * 1024;

function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Return the retained entries, newest first. Daily limits apply to older copies of each note. */
export function keepCopies<T extends Copy>(copies: readonly T[], now: number, cap = MAX_BYTES): T[] {
	const newest = [...copies].sort((a, b) => b.time - a.time);
	const days = new Set<string>();
	const kept: T[] = [];
	let size = 0;
	for (const copy of newest) {
		const age = now - copy.time;
		if (age > 30 * DAY) break;
		if (!copy.deleted && age > DAY) {
			const day = `${copy.path}\n${localDay(new Date(copy.time))}`;
			if (days.has(day)) continue;
			days.add(day);
		}
		size += copy.size;
		if (size > cap) break;
		kept.push(copy);
	}
	return kept;
}

/** Prefer the local copy when the same text was saved within a minute of a backup. */
export function mergeCopies<T extends { takenAt: number; text: string }>(local: readonly T[], backup: readonly T[]): T[] {
	const newestFirst = (a: T, b: T) => b.takenAt - a.takenAt;
	const times = new Map<string, number[]>();
	const kept: T[] = [];
	for (const copy of [...[...local].sort(newestFirst), ...[...backup].sort(newestFirst)]) {
		const previous = times.get(copy.text);
		if (previous?.some((time) => Math.abs(time - copy.takenAt) <= 60_000)) continue;
		if (previous) previous.push(copy.takenAt);
		else times.set(copy.text, [copy.takenAt]);
		kept.push(copy);
	}
	return kept.sort(newestFirst);
}

export function whenLabel(time: number, now: number): string {
	const date = new Date(time), today = new Date(now);
	const pad = (number: number) => String(number).padStart(2, "0");
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const day = localDay(date);
	if (day === localDay(today)) return `Today ${clock}`;
	today.setDate(today.getDate() - 1);
	if (day === localDay(today)) return `Yesterday ${clock}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

const relativeTime = new Intl.RelativeTimeFormat("en");

export function deletedWhenLabel(time: number | undefined, now: number): string {
	if (time === undefined) return "Time unknown";
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return "Just now";
	if (minutes < 60) return relativeTime.format(-minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return relativeTime.format(-hours, "hour");
	return relativeTime.format(-Math.floor(hours / 24), "day");
}
