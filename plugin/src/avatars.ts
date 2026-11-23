// Figma-style avatars in a note's header: the other devices that have the note open right now.
// Their names are untrusted (they arrive through cleanName): they only ever become text and attributes.

export type Person = { id: number; name: string; color: string }; // id: the device's awareness client ID for this note

const MAX_SHOWN = 3;

/** "Anna's iPhone 17 Pro" → "AI"; one word → its first two letters. */
export function initials(name: string): string {
	const words = name.split(/\s+/).map((w) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c))).filter((w) => w.length > 0);
	const letters = words.length > 1 ? [words[0]![0], words[1]![0]] : (words[0] ?? [...name.trim()]).slice(0, 2);
	return letters.join("").toUpperCase() || "?";
}

/** At most three avatars; the rest go behind a "+N". */
export const split = <T>(people: T[]) => ({ shown: people.slice(0, MAX_SHOWN), rest: people.slice(MAX_SHOWN) });

/** Black or white, whichever reads better on a #rrggbb background (WCAG contrast). */
export function textColour(hex: string): "#000" | "#fff" {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#000" : "#fff";
}

/**
 * Show `people` in a view's header, first among its action buttons; nothing (and no element) when the list is empty.
 * A phone hides the whole header while you type or scroll (`is-hidden-nav`), so a second, floating copy of the group
 * sits at the top right of the note; CSS shows it only then.
 */
export function showAvatars(view: HTMLElement, people: Person[], jump: (id: number) => void): void {
	const actions = view.querySelector(".view-header .view-actions");
	let box = view.querySelector<HTMLElement>(".view-header .ownsync-avatars");
	let float = view.querySelector<HTMLElement>(":scope > .ownsync-avatars-float");
	if (!people.length || !actions) { box?.remove(); float?.remove(); return; }
	const key = JSON.stringify(people);
	if (box?.dataset.key === key && float) return; // a cursor moved: keep the elements, so an open tooltip stays
	if (!box) actions.prepend((box = createDiv({ cls: "ownsync-avatars", attr: { role: "group" } })));
	if (!float) view.append((float = createDiv({ cls: "ownsync-avatars ownsync-avatars-float", attr: { role: "group" } })));
	for (const group of [box, float]) fill(group, people, jump);
	box.dataset.key = key;
}

function fill(box: HTMLElement, people: Person[], jump: (id: number) => void): void {
	box.empty();
	box.setAttr("aria-label", `In this note: ${people.map((p) => p.name).join(", ")}`);
	const { shown, rest } = split(people);
	for (const p of shown) {
		const button = box.createEl("button", { cls: "ownsync-avatar", attr: { "aria-label": p.name, "data-tooltip-position": "bottom" } });
		const face = button.createSpan({ cls: "ownsync-avatar-face", text: initials(p.name) });
		face.style.backgroundColor = p.color; // a validated #rrggbb
		face.style.color = textColour(p.color);
		button.addEventListener("click", () => jump(p.id));
	}
	if (rest.length) {
		box.createDiv({ cls: "ownsync-avatar", attr: { "aria-label": rest.map((p) => p.name).join("\n"), "data-tooltip-position": "bottom" } })
			.createSpan({ cls: "ownsync-avatar-face ownsync-avatar-more", text: `+${rest.length}` });
	}
}
