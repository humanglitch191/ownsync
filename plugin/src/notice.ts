import { Notice } from "obsidian";

let shown: Notice | undefined;

/** Ownsync's short messages, one at a time: a new one replaces the last. Offers and alerts that must stay use Notice. */
export function say(message: string, ms?: number): Notice {
	shown?.hide();
	return (shown = new Notice(message, ms));
}
