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

interface LineChange {
	type: "added" | "removed";
	text: string;
}

/** Compare the current text with a restore candidate. Omit unchanged lines and bound the LCS table. */
export function diffLines(current: string, copy: string): { added: number; removed: number; changes: LineChange[] } | undefined {
	if (current === copy) return { added: 0, removed: 0, changes: [] };
	const maxLines = 5_000;
	if (current.length + copy.length > 2 * 1024 * 1024) return;
	const split = (text: string) => text ? text.split(/\r?\n/, maxLines + 1) : [];
	const before = split(current), after = split(copy);
	if (before.length > maxLines || after.length > maxLines) return;
	let start = 0, endBefore = before.length, endAfter = after.length;
	while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	const rows = endBefore - start + 1, columns = endAfter - start + 1;
	if (rows * columns > 2_000_000) return;
	const ids = new Map<string, number>();
	const identify = (line: string): number => {
		let id = ids.get(line);
		if (id === undefined) ids.set(line, id = ids.size);
		return id;
	};
	const from = before.slice(start, endBefore).map(identify), to = after.slice(start, endAfter).map(identify);
	const lcs = new Uint16Array(rows * columns);
	for (let i = from.length - 1; i >= 0; i--) {
		for (let j = to.length - 1; j >= 0; j--) {
			const cell = i * columns + j;
			lcs[cell] = from[i] === to[j] ? 1 + lcs[cell + columns + 1]! : Math.max(lcs[cell + columns]!, lcs[cell + 1]!);
		}
	}
	const changes: LineChange[] = [];
	let added = 0, removed = 0, i = 0, j = 0;
	while (i < from.length || j < to.length) {
		const cell = i * columns + j;
		if (i < from.length && j < to.length && from[i] === to[j]) {
			i++;
			j++;
		} else if (i < from.length && (j === to.length || lcs[cell + columns]! >= lcs[cell + 1]!)) {
			changes.push({ type: "removed", text: before[start + i++]! });
			removed++;
		} else {
			changes.push({ type: "added", text: after[start + j++]! });
			added++;
		}
	}
	return { added, removed, changes };
}

export function whenLabel(time: number, now: number, seconds = false): string {
	const date = new Date(time), today = new Date(now);
	const pad = (number: number) => String(number).padStart(2, "0");
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
	const day = localDay(date);
	if (day === localDay(today)) return `Today ${clock}`;
	today.setDate(today.getDate() - 1);
	if (day === localDay(today)) return `Yesterday ${clock}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** Labels for copies listed newest first. Seconds only where a neighbouring copy shares the minute. */
export function whenLabels(times: readonly number[], now: number): string[] {
	const minute = (time: number | undefined) => time === undefined ? NaN : Math.floor(time / 60_000);
	return times.map((time, i) => whenLabel(time, now, minute(times[i - 1]) === minute(time) || minute(times[i + 1]) === minute(time)));
}

/** Where a restored deleted note (or attachment) goes: its old path, or "<name> (restored).md" when that name is taken. */
export async function restorePath(path: string, taken: (path: string) => boolean | Promise<boolean>): Promise<string> {
	let to = path;
	for (let n = 1; await taken(to); n++) to = path.replace(/(\.[^./]*)?$/, ` (restored${n === 1 ? "" : ` ${n}`})$1`);
	return to;
}

export function restoreDeletedPrompt(path: string, to: string): string {
	if (to === path) return `Restore ${path} to the vault?`;
	const note = /\.md$/i.test(to), name = to.slice(to.lastIndexOf("/") + 1).replace(/\.md$/i, "");
	return `Restore ${path} to the vault? ${note ? "A note" : "A file"} already has this name, so this one comes back as "${name}".`;
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
