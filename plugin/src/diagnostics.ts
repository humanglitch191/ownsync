const plain = /^[A-Za-z' ,-]{1,80}$/;

/**
 * A problem line as "what: message", where either part can carry a note's path or a document ID. Keeps the
 * first word of `what` and the message only when it is plain words (no digits, slashes, dots, quotes or colons).
 */
export function redactProblem(line: string): string {
	const i = line.indexOf(": ");
	if (i < 0) return plain.test(line) ? line : "(details withheld)";
	const what = line.slice(0, i).split(" ")[0]!.replace(/[^A-Za-z-]/g, "") || "problem";
	const msg = line.slice(i + 2);
	return plain.test(msg) ? `${what}: ${msg}` : `${what}: (details withheld)`;
}
