export const SNAPSHOT_BUDGET = 400 * 1024 * 1024;

type Snapshot = { day: number; size: number; complete: number | boolean };

// The Unix epoch fell on a Thursday. Shift it three days to group UTC days by Monday.
const week = (day: number) => Math.floor((day + 3) / 7);

export function snapshotsToPrune<T extends Snapshot>(snapshots: readonly T[], today: number, incomingBytes = 0): T[] {
	const newestFirst = [...snapshots].sort((a, b) => b.day - a.day);
	const newest = newestFirst.find((snapshot) => snapshot.complete);
	const firstDaily = today - 6;
	const lastWeekly = week(firstDaily) - 1;
	const weeks = new Set<number>();
	const remove = new Set<T>();
	let size = incomingBytes;
	for (const snapshot of newestFirst) {
		if (snapshot.complete && snapshot.day < firstDaily) {
			const w = week(snapshot.day);
			const keepWeekly = w <= lastWeekly && w >= lastWeekly - 3 && !weeks.has(w);
			weeks.add(w);
			if (snapshot !== newest && !keepWeekly) {
				remove.add(snapshot);
				continue;
			}
		}
		size += snapshot.size;
	}
	for (const snapshot of newestFirst.reverse()) {
		if (size <= SNAPSHOT_BUDGET) break;
		if (!snapshot.complete || snapshot === newest || remove.has(snapshot)) continue;
		remove.add(snapshot);
		size -= snapshot.size;
	}
	return [...remove];
}
