// What a bound editor adds to live typing: undo that only takes back this editor's own typing, and the
// cursors of other devices showing the same note. No Obsidian here, so the tests can load it.
//
// Presence is a y-protocols awareness update, sealed and relayed like a live edit but never stored, and never
// given to the engine. What arrives is untrusted input to the UI: only a short plain name, a #rrggbb colour and
// a well-formed cursor get through.

import * as Y from "yjs";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { type Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

const COLOURS = ["#e5484d", "#f76b15", "#d6a000", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"];
const MAX_NAME = 40;

/** Tracks nothing until the editor's sync plugin adds itself: other devices' edits and the engine's own are never undone. */
export const localUndo = (text: Y.Text) => new Y.UndoManager(text, { trackedOrigins: new Set() });

/** Highest precedence, so Mod-z and the platform's undo reach the Y.UndoManager before Obsidian's CodeMirror history. */
export const collab = (text: Y.Text, awareness: Awareness, undoManager: Y.UndoManager): Extension =>
	Prec.highest([yCollab(text, awareness, { undoManager }), keymap.of(yUndoManagerKeymap)]);

export const user = (name: string, clientId: number) => ({ name, color: COLOURS[clientId % COLOURS.length]! });

export function cleanName(name: unknown): string {
	return typeof name === "string" ? [...name.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "")].slice(0, MAX_NAME).join("").trim() : "";
}

type Id = { client: number; clock: number };
const id = (x: Partial<Id> | null | undefined): Id | null =>
	x && Number.isSafeInteger(x.client) && Number.isSafeInteger(x.clock) && x.client! >= 0 && x.clock! >= 0 ? { client: x.client!, clock: x.clock! } : null;

// A relative position into the note's text: after an item, or at the end of the root text "t" (the engine's name for it).
function position(p: unknown) {
	if (!p || typeof p !== "object") return null;
	const q = p as { item?: Id; tname?: unknown; assoc?: unknown }, assoc = q.assoc === -1 ? -1 : 0, item = id(q.item);
	if (item) return { type: null, tname: null, item, assoc };
	return q.tname === "t" ? { type: null, tname: "t", item: null, assoc } : null;
}

export function cleanState(s: unknown) {
	const o = (s && typeof s === "object" ? s : {}) as { user?: { name?: unknown; color?: unknown }; cursor?: { anchor?: unknown; head?: unknown } };
	const color = typeof o.user?.color === "string" && /^#[0-9a-f]{6}$/i.test(o.user.color) ? o.user.color : COLOURS[0]!;
	const anchor = position(o.cursor?.anchor), head = position(o.cursor?.head);
	return { user: { name: cleanName(o.user?.name) || "Another device", color }, cursor: anchor && head ? { anchor, head } : null };
}

/**
 * Whether this device's presence in a note goes out now. Each frame wakes the vault's Durable Object, so with nobody
 * else in the note only an announce goes (opening the note, coming back to the window, reconnecting), which whoever
 * joins later answers; and with the window hidden or in the background nothing does, and the others drop this device
 * after 30 s. Leaving goes to whoever is there.
 */
export function presenceGoes(why: "announce" | "change" | "leave", inView: boolean, others: boolean): boolean {
	return why === "leave" ? others : inView && (others || why === "announce");
}

/** Apply another device's presence. Returns true if a device appeared, so it can be sent this device's state at once. */
export function applyPresence(aw: Awareness, update: Uint8Array): boolean {
	const d = decoding.createDecoder(update), out: [number, number, string][] = [];
	let appeared = false;
	for (let n = decoding.readVarUint(d); n > 0; n--) {
		const client = decoding.readVarUint(d);
		decoding.readVarUint(d); // the sender's clock, replaced below
		const state: unknown = JSON.parse(decoding.readVarString(d));
		if (client === aw.clientID) continue;
		appeared ||= state !== null && !aw.states.has(client);
		// A device's clock starts again each time it opens the note, and frames from one device arrive in order:
		// the newest frame wins.
		out.push([client, (aw.meta.get(client)?.clock ?? 0) + 1, JSON.stringify(state === null ? null : cleanState(state))]);
	}
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, out.length);
	for (const [client, clock, state] of out) { encoding.writeVarUint(e, client); encoding.writeVarUint(e, clock); encoding.writeVarString(e, state); }
	applyAwarenessUpdate(aw, encoding.toUint8Array(e), "remote");
	return appeared;
}

/** The Worker's list of device names, by short ID: untrusted, so only 8-hex IDs and cleaned names. */
export function deviceNames(raw: unknown): Map<string, string> {
	const names = new Map<string, string>();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return names;
	for (const [id, name] of Object.entries(raw).slice(0, 1000)) {
		const clean = cleanName(name);
		if (/^[0-9A-F]{8}$/.test(id) && clean) names.set(id, clean);
	}
	return names;
}

/** The vault's settings from the Worker's names reply (DESIGN.md sections 8 and 9). Null: not chosen yet. */
export type VaultSettings = { snapshots: boolean | null; historyBackup: boolean | null };

/** Undefined from a Worker older than 0.2.2, which has no vault settings. */
export function vaultSettings(raw: unknown): VaultSettings | undefined {
	const { snapshots, historyBackup } = (raw ?? {}) as Record<string, unknown>;
	const ok = (v: unknown) => v === null || typeof v === "boolean";
	return ok(snapshots) && ok(historyBackup) ? { snapshots: snapshots as boolean | null, historyBackup: historyBackup as boolean | null } : undefined;
}

/** This device's 0.2.x choices, in its own settings. */
type Local = { snapshots: boolean; backUpHistoryToWorker: boolean };

/** What this device does: the vault's setting once chosen; until then (or with an older Worker), its own earlier one. */
export function followedSettings(vault: VaultSettings | undefined, local: Local): { snapshots: boolean; historyBackup: boolean } {
	return { snapshots: vault?.snapshots ?? local.snapshots, historyBackup: vault?.historyBackup ?? local.backUpHistoryToWorker };
}

/** Sent to the Worker, which keeps it only while the vault has no value: snapshots on, or history backup off. */
export function carryOver(local: Local): { snapshots?: true; historyBackup?: false } | undefined {
	if (!local.snapshots && local.backUpHistoryToWorker) return undefined;
	return { ...(local.snapshots && { snapshots: true as const }), ...(!local.backUpHistoryToWorker && { historyBackup: false as const }) };
}
