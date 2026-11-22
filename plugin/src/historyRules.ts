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
