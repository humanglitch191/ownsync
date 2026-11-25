import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decodeClient } from "../../server/src/wire";
import { conflictSuffix, restore, type RecordData } from "../src/core/table/device";
import { WorkerModel, client, enc, dec, nameKey, hash } from "./table-sim";

async function pair() {
	const w = new WorkerModel(), a = await client(w), b = await client(w);
	a.disk.edit("x.bin","A"); await a.settle(); await b.settle();
	return { w,a,b,file:w.live()[0]!.file };
}
test("suffix uses the name key, labelled raw hash, and a big endian retry counter", async () => {
	const h = hash(enc.encode("content"));
	for (const n of [0,1,256]) {
		const mac = createHmac("sha256",nameKey).update("ownsync/conflict-suffix\0").update(Buffer.from(h,"hex"));
		if (n) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(n); mac.update(bytes); }
		assert.equal(await conflictSuffix(nameKey,h,n),mac.digest("hex").slice(0,6));
	}
});

test("pending edits survive restart, ack before catch-up, and a second save", async () => {
	const {a,w,file} = await pair();
	a.disk.edit("x.bin","B"); await a.plan();
	const before = await a.packet(), ok = w.request(before);
	a.disk.edit("x.bin","C"); await a.plan({kind:"changed",path:"x.bin"});
	await a.reopen(); assert.deepEqual(await a.packet(), before);
	assert.deepEqual(w.request(before),ok);
	a.store.fail = true;
	await assert.rejects(a.ack(ok),/commit/); assert.equal(w.answers.size,1);
	a.store.fail = false; await a.reopen();
	await a.dev.receive(ok,a.i,async () => {}); // forget lost
	assert.equal(await a.dev.change(s => s.cursor),1);
	await a.reopen(); await a.dev.sendForgets(a.forget);
	assert.equal(w.answers.size,0); assert.equal(await a.dev.change(s => s.local.get(file)!.base.bytes!.h),hash(enc.encode("B")));
	await a.settle(); assert.equal(w.live()[0]?.bytes.h, hash(enc.encode("C")));
});

test("rename and edit commute in either arrival order; competing renames keep the first", async () => {
	for (const renameFirst of [false,true]) {
		const {a,b,w} = await pair();
		await a.disk.moveIf("x.bin","y.bin",a.disk.hash("x.bin")!);
		await a.plan({kind:"renamed",from:"x.bin",to:"y.bin"});
		b.disk.edit("x.bin","B"); await b.plan();
		const first = renameFirst ? a : b, second = renameFirst ? b : a;
		await first.deliver(); await second.deliver(); await second.settle(); await first.settle();
		assert.equal(w.live().length,1);
		for (const d of [a,b]) assert.deepEqual([...d.disk.files.keys()],["y.bin"]);
		assert.equal(a.disk.text("y.bin"),"B"); assert.equal(b.disk.text("y.bin"),"B");
	}
	const {a,b,w} = await pair();
	for (const [d,to] of [[a,"y.bin"],[b,"z.bin"]] as const) {
		await d.disk.moveIf("x.bin",to,d.disk.hash("x.bin")!); await d.plan({kind:"renamed",from:"x.bin",to});
	}
	await a.deliver(); await b.deliver(); await b.settle();
	assert.equal(w.live()[0]!.path,"y.bin"); assert.equal(b.disk.text("y.bin"),"A");
});

test("delete against an edit, a rename, or an unchanged row", async () => {
	for (const op of ["edit","rename","unchanged"] as const) for (const deleteFirst of [true,false]) {
		const {a,b,w} = await pair();
		a.disk.files.delete("x.bin"); await a.plan({kind:"deleted",path:"x.bin"});
		if (op === "edit") { b.disk.edit("x.bin","B"); await b.plan(); }
		if (op === "rename") { await b.disk.moveIf("x.bin","y.bin",b.disk.hash("x.bin")!); await b.plan({kind:"renamed",from:"x.bin",to:"y.bin"}); }
		if (deleteFirst) await a.deliver();
		if (op !== "unchanged") await b.deliver();
		if (!deleteFirst) await a.deliver();
		await a.settle(); await b.settle(); await a.settle();
		assert.equal(w.live().length, op === "edit" ? 1 : 0, op);
		assert.equal(a.disk.text("x.bin"),op === "edit" ? "B" : undefined);
	}
});

test("ordinary identical creates adopt the occupant; differing bytes select the conflict path", async () => {
	for (const value of ["A","B"]) {
		const w = new WorkerModel(), a = await client(w), b = await client(w);
		a.disk.edit("x.bin","A"); b.disk.edit("x.bin",value); await a.plan(); await b.plan();
		await a.deliver(); await b.deliver(); await b.settle(); await a.settle();
		assert.equal(w.live().length,value === "A" ? 1 : 2);
		assert.deepEqual([...a.disk.files.keys()].sort(),[...b.disk.files.keys()].sort());
		assert.equal(b.disk.text("x.bin"),"A");
	}
});

test("two losing edits with identical bytes choose one conflict copy, including an occupied suffix", async () => {
	const {a,b,w} = await pair(), c = await client(w); await c.settle();
	const suffix = await a.i.suffix(hash(enc.encode("B")),0);
	a.disk.edit(`x (conflict ${suffix}).bin`,"occupied"); await a.settle();
	for (const d of [b,c]) { d.disk.edit("x.bin","B"); await d.plan(); }
	a.disk.edit("x.bin","winner"); await a.settle();
	for (const d of [b,c]) { await d.deliver(); await d.pull(); await d.plan(); assert.equal(d.disk.text("x.bin"),"B"); }
	await b.deliver(); await c.deliver();
	for (const d of [b,c,a]) await d.settle();
	assert.equal(w.live().length,3);
	for (const d of [a,b,c]) {
		assert.equal(d.disk.text("x.bin"),"winner");
		assert.equal([...d.disk.files.values()].filter(f => dec.decode(f.bytes) === "B").length,1);
	}
});

test("restore names the exact deletion and cannot supersede a racing edit", async () => {
	const {a,b,w,file} = await pair();
	b.disk.edit("x.bin","B"); await b.plan();
	a.disk.files.delete("x.bin"); await a.plan({kind:"deleted",path:"x.bin"}); await a.deliver(); await a.pull();
	await a.dev.change(s => restore(s,s.latest.get(file)!,a.i));
	await b.deliver(); await b.settle(); await a.deliver(); await a.settle();
	assert.equal(w.live().length,1); assert.equal(a.disk.text("x.bin"),"B");
});

test("every disk intent resumes after a crash at prepare, after the mutation, or after its agreement", async () => {
	for (const kind of ["write","rename","remove"] as const) for (const fault of ["prepare","effect","agreement"] as const) {
		const {a,b,w} = await pair();
		if (kind === "write") a.disk.edit("x.bin","new");
		if (kind === "rename") { await a.disk.moveIf("x.bin","y.bin",a.disk.hash("x.bin")!); await a.plan({kind:"renamed",from:"x.bin",to:"y.bin"}); }
		if (kind === "remove") { a.disk.files.delete("x.bin"); await a.plan({kind:"deleted",path:"x.bin"}); }
		await a.settle(); await b.pull(); await b.plan();
		assert.equal(await b.dev.change(s => s.intent?.kind),kind);
		if (fault === "effect") { b.disk.crash = "effect"; await assert.rejects(b.effect(),/killed/); }
		if (fault === "agreement") await b.effect();
		await b.reopen(); await b.plan({kind:"startup"}); await b.settle();
		assert.deepEqual([...b.disk.files.keys()],[...a.disk.files.keys()],kind + "/" + fault);
		assert.equal(b.disk.text("x.bin"),a.disk.text("x.bin"));
		assert.equal(w.seq,2); // replaying an own disk event never publishes another mutation
	}
});

test("temp writes are private, restart discards a partial write, and a user save wins the precondition", async () => {
	const {a,b,w} = await pair();
	a.disk.edit("x.bin","remote"); await a.settle(); await b.pull(); await b.plan();
	b.disk.crash = "temp"; await assert.rejects(b.effect(),/killed/);
	assert.equal(b.disk.text("x.bin"),"A"); assert.ok(b.disk.temp);
	b.disk.edit("x.bin","user save");
	await b.reopen(); await b.plan({kind:"startup"}); assert.equal(b.disk.temp,undefined);
	await b.effect(); assert.equal(b.disk.text("x.bin"),"user save");
	await b.settle(); assert.equal(w.live().length,2);
	assert.deepEqual([...b.disk.files.values()].map(f => dec.decode(f.bytes)).sort(),["remote","user save"]);
});

test("D13 uses both sides of the original inventory; steady-state settles reuse verified stats", async () => {
	for (const ambiguous of [true,false]) {
		const w = new WorkerModel(), a = await client(w);
		a.disk.edit("a.bin","same");
		if (ambiguous) a.disk.edit("b.bin","same");
		await a.settle();
		const prior = w.live().map(r => r.file), reads = a.disk.reads;
		await a.plan(); assert.equal(a.disk.reads,reads);
		await a.disk.moveIf("a.bin","moved.bin",a.disk.hash("a.bin")!);
		if (ambiguous) a.disk.files.delete("b.bin");
		await a.reopen(); await a.plan({kind:"startup"}); await a.settle();
		assert.equal(w.live().length,1); assert.equal(w.live()[0]!.path,"moved.bin");
		assert.equal(prior.includes(w.live()[0]!.file),!ambiguous);
	}
});

test("equal concurrent changes to the path and bytes adopt once, even when catch-up precedes the answer", async () => {
	const {a,b,w} = await pair();
	for (const d of [a,b]) {
		await d.disk.moveIf("x.bin","y.bin",d.disk.hash("x.bin")!);
		d.disk.edit("y.bin","B"); await d.plan({kind:"renamed",from:"x.bin",to:"y.bin"});
	}
	const ok = w.request(await a.packet());
	await a.pull(); await a.ack(ok);
	await b.deliver(); await b.settle(); await a.settle();
	assert.equal(w.seq,2); assert.deepEqual([...b.disk.files.keys()],["y.bin"]); assert.equal(b.disk.text("y.bin"),"B");
});

test("restore uses restored names and reports a cleaned version without changing disk", async () => {
	const {a,w,file} = await pair();
	a.disk.files.delete("x.bin"); await a.plan({kind:"deleted",path:"x.bin"}); await a.settle();
	a.disk.edit("x.bin","replacement"); a.disk.edit("x (restored).bin","occupied"); await a.settle();
	const deleted = w.rows.get(file)!;
	await a.dev.change(s => restore(s,deleted,a.i));
	const bytes = w.chunks.get(deleted.bytes.c[0]!)!;
	w.chunks.delete(deleted.bytes.c[0]!); assert.equal(await a.deliver(),"gone");
	w.chunks.set(deleted.bytes.c[0]!,bytes);
	await a.dev.change(s => restore(s,deleted,a.i)); await a.deliver(); await a.settle();
	assert.equal(a.disk.text("x (restored 2).bin"),"A"); assert.equal(a.disk.text("x.bin"),"replacement");
});

test("missing chunks retry from durable staging after a second save", async () => {
	const {b,w} = await pair();
	b.disk.edit("x.bin","B"); await b.plan(); const first = await b.packet();
	const frame = decodeClient(first); assert.equal(frame.t,"set"); if (frame.t !== "set") return;
	const data = JSON.parse(dec.decode(frame.record)) as RecordData;
	w.chunks.delete(data.bytes.c[0]!);
	const missing = w.request(first); b.disk.edit("x.bin","C"); await b.ack(missing);
	await b.reopen(); await b.deliver(); assert.equal(w.live()[0]!.bytes.h,hash(enc.encode("B")));
	await b.settle(); assert.equal(w.live()[0]!.bytes.h,hash(enc.encode("C")));
});

test("a coalesced catch-up with a path swap preserves both files across a crash during the move", async () => {
	for (const available of [true,false]) {
		const {a,b,w} = await pair();
		a.disk.edit("y.bin","Y"); await a.settle(); await b.settle();
		for (const [from,to] of [["x.bin","middle.bin"],["y.bin","x.bin"],["middle.bin","y.bin"]] as const) {
			await a.disk.moveIf(from,to,a.disk.hash(from)!); await a.plan({kind:"renamed",from,to}); await a.settle();
		}
		const seq = w.seq;
		let stageReads = 0, downloads = 0;
		const read = b.i.readStage, fetch = b.i.fetch;
		b.i.readStage = ref => { stageReads++; return available ? read(ref) : Promise.resolve(undefined); };
		b.i.fetch = ref => { downloads++; return fetch(ref); };
		await b.pull(); await b.plan();
		assert.equal(await b.dev.change(s => s.intent?.kind),"park");
		b.disk.crash = "effect"; await assert.rejects(b.effect(),/killed/);
		await b.reopen(); await b.plan({kind:"startup"}); await b.settle();
		assert.equal(b.disk.text("x.bin"),"Y"); assert.equal(b.disk.text("y.bin"),"A");
		assert.equal(w.seq,seq);
		assert.equal(stageReads,1); assert.equal(downloads,available ? 0 : 1);
	}
});

test("a save after a remote rename but before its disk agreement is preserved on restart", async () => {
	const {a,b} = await pair();
	await a.disk.moveIf("x.bin","y.bin",a.disk.hash("x.bin")!); await a.plan({kind:"renamed",from:"x.bin",to:"y.bin"}); await a.settle();
	await b.pull(); await b.plan(); b.disk.crash = "effect"; await assert.rejects(b.effect(),/killed/);
	b.disk.edit("y.bin","saved"); await b.reopen(); await b.plan({kind:"startup"}); await b.settle();
	assert.deepEqual([...b.disk.files.values()].map(f => dec.decode(f.bytes)).sort(),["A","saved"]);
});

test("an explicit folder rename keeps each child ID even with identical bytes", async () => {
	const w = new WorkerModel(), a = await client(w);
	for (const path of ["old/a.bin","old/sub/b.bin"]) a.disk.edit(path,"same");
	await a.settle(); const before = w.live();
	for (const r of before) await a.disk.moveIf(r.path,r.path.replace("old/","new/"),a.disk.hash(r.path)!);
	await a.plan({kind:"renamed",from:"old",to:"new"}); await a.settle();
	for (const r of before) assert.equal(w.rows.get(r.file)!.path,r.path.replace("old/","new/"));
	assert.equal(w.rows.size,2);
});

test("a user rename while a remote delete is prepared follows the deletion", async () => {
	const {a,b,w} = await pair();
	a.disk.files.delete("x.bin"); await a.plan({kind:"deleted",path:"x.bin"}); await a.settle();
	await b.pull(); await b.plan(); assert.equal(await b.dev.change(s => s.intent?.kind),"remove");
	await b.disk.moveIf("x.bin","y.bin",b.disk.hash("x.bin")!); await b.plan({kind:"renamed",from:"x.bin",to:"y.bin"});
	await b.settle(); assert.equal(b.disk.files.size,0); assert.equal(w.live().length,0);
});

test("an unusable disk intent releases other uploads and downloads until its inputs change", async () => {
	for (const failure of ["oversized", "unreadable", "fetch", "excluded"] as const) {
		const w = new WorkerModel(), a = await client(w), b = await client(w);
		a.disk.edit("a.bin", "one"); a.disk.edit("b.bin", "two"); await a.settle();
		await b.pull(); await b.plan();
		assert.equal(await b.dev.change(s => s.intent?.path), "a.bin");
		const read = b.disk.readBinary.bind(b.disk), fetch = b.i.fetch;
		let attempts = 0;
		if (failure === "oversized") b.disk.put("a.bin", new Uint8Array(b.i.maxFileSize + 1));
		if (failure === "unreadable") {
			b.disk.edit("a.bin", "one");
			b.disk.readBinary = path => path === "a.bin" ? Promise.reject(new Error("unreadable")) : read(path);
		}
		if (failure === "fetch") b.i.fetch = ref => {
			if (ref.h === hash(enc.encode("one")) && ++attempts === 1) throw new Error("disconnected");
			return fetch(ref);
		};
		if (failure === "excluded") b.i.allowed = path => path !== "a.bin";
		b.disk.edit("upload.bin", "local");
		await b.plan({kind:"changed",path:"upload.bin"});
		assert.equal((await b.pending()).length, 1);
		await b.effect(); await b.reopen(); await b.settle();
		assert.equal(b.disk.text("b.bin"), "two");
		assert.ok(w.live().some(row => row.path === "upload.bin"));
		assert.equal(attempts, failure === "fetch" ? 2 : 0);
		if (failure === "fetch") {
			a.disk.edit("a.bin", "three"); await a.settle();
		} else if (failure === "excluded") b.i.allowed = () => true;
		else { b.disk.readBinary = read; b.disk.files.delete("a.bin"); }
		await b.settle();
		assert.equal(b.disk.text("a.bin"), failure === "fetch" ? "three" : "one");
	}
});

test("offline adds and a second save cache observed bytes without advancing agreement", async () => {
	const w = new WorkerModel(), a = await client(w);
	for (let n = 0; n < 20; n++) a.disk.edit(n + ".bin", "new " + n);
	await a.plan();
	assert.equal((await a.pending()).length, 20);
	const reads = a.disk.reads;
	await a.reopen(); await a.plan();
	assert.equal(a.disk.reads, reads);
	a.disk.edit("5.bin", "saved"); await a.plan({kind:"changed",path:"5.bin"}); await a.plan();
	assert.equal(a.disk.reads, reads + 1);
	assert.ok(await a.dev.change(s => [...s.local.values()].every(f => !f.base.bytes)));
});

test("identical cached holder moved before a new file was proposed", async () => {
	const w = new WorkerModel(), a = await client(w), b = await client(w);
	a.disk.edit("x.bin", "same"); await a.settle(); await b.pull();
	await a.disk.moveIf("x.bin","y.bin",a.disk.hash("x.bin")!);
	await a.plan({kind:"renamed",from:"x.bin",to:"y.bin"}); await a.settle();
	b.disk.edit("x.bin","same"); await b.plan(); await b.deliver(); await b.settle();
	assert.deepEqual([...b.disk.files.keys()].sort(), ["x.bin","y.bin"]);
	assert.equal(w.live().length, 2);
});

test("a remote rename waits for a pending deletion to release its disk path (table fuzz seed 74)", async () => {
	const { w, a, b } = await pair();
	a.disk.edit("y.bin", "Y"); await a.settle(); await b.settle();
	b.disk.files.delete("y.bin"); await b.plan({ kind: "deleted", path: "y.bin" });
	for (const [from, to] of [["y.bin", "z.bin"], ["x.bin", "y.bin"]] as const) {
		await a.disk.moveIf(from, to, a.disk.hash(from)!);
		await a.plan({ kind: "renamed", from, to }); await a.settle();
	}
	await b.pull(); await b.plan();
	assert.equal(await b.dev.change(s => s.intent), undefined);
	await b.settle(); await a.settle();
	assert.deepEqual(w.live().map(r => r.path), ["y.bin"]);
	for (const d of [a,b]) {
		assert.deepEqual([...d.disk.files.keys()], ["y.bin"]);
		assert.equal(d.disk.text("y.bin"), "A");
	}
});

test("a restarted download respects a new owner's pending change at its destination", async () => {
	for (const deleted of [true, false]) {
		const { a, b, file } = await pair();
		a.disk.edit("y.bin", "A"); await a.settle(); await b.pull(); await b.plan();
		assert.equal(await b.dev.change(s => s.intent?.kind), "write");
		await b.disk.moveIf("x.bin", "y.bin", b.disk.hash("x.bin")!);
		await b.plan({ kind: "renamed", from: "x.bin", to: "y.bin" });
		if (deleted) {
			b.disk.files.delete("y.bin"); await b.plan({ kind: "deleted", path: "y.bin" });
		}
		// Both absence and the exact expected bytes would satisfy the saved write.
		const pending = await b.packet(file);
		await b.reopen();
		assert.equal(await b.effect(), false);
		assert.equal(await b.dev.change(s => s.intent), undefined);
		assert.deepEqual(await b.packet(file), pending);
		assert.equal(b.disk.text("y.bin"), deleted ? undefined : "A");
		assert.deepEqual(await b.dev.change(s => [...s.local.keys()]), [file]);
		await b.settle();
		assert.equal(b.disk.text("y.bin"), "A");
	}
});

test("a saved rename cannot move another file that now owns its source", async () => {
	const { a, b } = await pair();
	a.disk.edit("other.bin", "A"); await a.settle(); await b.settle();
	await a.disk.moveIf("x.bin", "y.bin", a.disk.hash("x.bin")!);
	await a.plan({ kind: "renamed", from: "x.bin", to: "y.bin" }); await a.settle();
	await b.pull(); await b.plan();
	assert.equal(await b.dev.change(s => s.intent?.kind), "rename");
	b.disk.files.delete("x.bin");
	await b.disk.moveIf("other.bin", "x.bin", b.disk.hash("other.bin")!);
	await b.plan({ kind: "renamed", from: "other.bin", to: "x.bin" });
	assert.equal(await b.effect(), false);
	assert.equal(b.disk.text("x.bin"), "A");
	assert.equal(b.disk.text("y.bin"), undefined);
});

test("a device rejects duplicate local paths before committing any changes", async () => {
	const { b, file } = await pair();
	await assert.rejects(b.dev.change(s => {
		s.local.set("other", { path: "x.bin", base: {} });
		s.cursor++;
	}), /Multiple local attachment IDs at x\.bin/);
	await b.reopen();
	assert.deepEqual(await b.dev.change(s => [...s.local.keys()]), [file]);
	assert.equal(await b.dev.change(s => s.cursor), 1);
});
