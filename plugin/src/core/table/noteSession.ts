import { hex, randomBytes } from "../../../../protocol/ownsync";
import type { Store } from "../ports";
import { noteHash } from "./noteFiles";
import { NoteDevice, yjsTextCrdt, type NoteInput, type StepEnv } from "./notePlanner";
import type { NoteRow } from "./notes";

// Both subscriptions share one durable planner. Once attached, all inputs go through
// the editor engine's queue, which also owns the Yjs publish counter.
export class NoteSession {
	private opening?: Promise<NoteDevice>;
	device?: NoteDevice;
	beforeInventory?: () => Promise<void>;
	deliver?: (input: NoteInput) => Promise<void>;
	readonly env: StepEnv = { crdt: yjsTextCrdt, clientId: 0, newId: () => hex(randomBytes(16)), hash: noteHash };
	constructor(private store: Store) {}
	async load() {
		this.opening ??= NoteDevice.open(this.store);
		try { return this.device = await this.opening; } catch (e) { this.opening = undefined; throw e; }
	}
	get state() { return this.device?.snapshot(); }
	get(id: string) { return this.state?.notes.get(id)?.row; }
	at(path: string) { const id = this.state?.rowsByPath.get(path); return id ? this.get(id) : undefined; }
	*ids() { for (const n of this.state?.notes.values() ?? []) if (n.row) yield n.id; }
	async input(input: NoteInput) {
		if (this.deliver) return this.deliver(input);
		await (await this.load()).dispatch(input, this.env);
	}
	receive(row: NoteRow) { return this.input({ t: "row", row }); }
}
