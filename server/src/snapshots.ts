export const SNAPSHOT_BUDGET = 150 * 1024 * 1024;
/** Vault snapshots keep the last 30 days (DESIGN.md section 9). */
export const SNAPSHOT_DAYS = 30;

type Snapshot = { day: number; size: number; complete: number | boolean };

// The Unix epoch fell on a Thursday. Shift it three days to group UTC days by Monday.
const week = (day: number) => Math.floor((day + 3) / 7);

/**
 * Which snapshots go: one a day for 7 days, then the newest of each of 4 weeks, and nothing older than 30 days;
 * then the oldest until all of them fit the budget. The two newest complete ones always stay.
 */
export function snapshotsToPrune<T extends Snapshot>(snapshots: readonly T[], today: number, incomingBytes = 0): T[] {
	const newestFirst = [...snapshots].sort((a, b) => b.day - a.day);
	const kept = new Set(newestFirst.filter((snapshot) => snapshot.complete).slice(0, 2));
	const firstDaily = today - 6;
	const lastWeekly = week(firstDaily) - 1;
	const weeks = new Set<number>();
	const remove = new Set<T>();
	let size = incomingBytes;
	for (const snapshot of newestFirst) {
		if (snapshot.complete && snapshot.day < firstDaily) {
			const w = week(snapshot.day);
			const keepWeekly = w <= lastWeekly && w >= lastWeekly - 3 && !weeks.has(w) && snapshot.day > today - SNAPSHOT_DAYS;
			weeks.add(w);
			if (!kept.has(snapshot) && !keepWeekly) {
				remove.add(snapshot);
				continue;
			}
		}
		size += snapshot.size;
	}
	for (const snapshot of newestFirst.reverse()) {
		if (size <= SNAPSHOT_BUDGET) break;
		if (!snapshot.complete || kept.has(snapshot) || remove.has(snapshot)) continue;
		remove.add(snapshot);
		size -= snapshot.size;
	}
	return [...remove];
}
