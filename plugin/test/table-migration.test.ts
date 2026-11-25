import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { hex, tableFileId, unhex } from "../../protocol/ownsync";
import { LegacyProjection, legacyBases } from "../src/core/table/migration";
import type { Entry, Ref, Store } from "../src/core/ports";
import type { Local, Row } from "../src/core/table/device";

const key = new Uint8Array(32);
const id = (n: number) => n.toString(16).padStart(16, "0");
const ref = (n: number): Ref => ({ h: n.toString(16).padStart(64, "0"), n, u: id(n), c: [] });
const versionDoc = (...refs: Ref[]) => {
	const doc = new Y.Doc();
	doc.getArray<Ref>("v").push(refs);
	return doc;
};
const entry = (doc: string, data: Uint8Array): Entry => ({ doc, kind: "update", data });

test("stored genesis preserves legacy names, collapses equal versions and retains each deleted version", async () => {
	const index = new Y.Doc(), notes = index.getMap("notes");
	notes.set(id(1), { p: "a.bin" }); notes.set(id(2), { p: "a.bin" });
	notes.set(id(3), { p: "removed", d: "AA==", t: 9 }); notes.set(id(4), { p: "empty", d: "AA==", t: 7 });
	notes.set(id(5), { p: "text.md" });
	const projection = new LegacyProjection();
	projection.applyIndex(entry("index", Y.encodeStateAsUpdate(index)));
	const docs = [versionDoc(ref(6), ref(6), ref(7)), versionDoc(ref(8)), versionDoc(ref(9), ref(10))];
	for (const [i, d] of docs.entries()) projection.applyAttachment(entry(id(i + 1), Y.encodeStateAsUpdate(d)));
	const rows: Row[] = [];
	for await (const row of projection.rows(key)) rows.push(row);
	assert.equal(rows.length, 5);
	assert.equal(rows[0]!.path, "a.bin");
	assert.equal(rows[1]!.file, hex(await tableFileId(key, unhex(id(7)))));
	assert.match(rows[1]!.path, /^a \(conflict [a-f0-9]{6}\)\.bin$/);
	assert.equal(rows[2]!.path, "a (conflict 000000).bin");
	assert.deepEqual(rows.slice(3).map(r => [r.deleted, r.bytes.h]), [[9, ref(9).h], [9, ref(10).h]]);
	assert.equal(new Set(rows.map(r => r.file)).size, 5);
	projection.close(); index.destroy(); for (const d of docs) d.destroy();
});

test("handoff takes only confirmed byte and path baselines, including a pending deletion", async () => {
	const index = new Y.Doc(), notes = index.getMap("notes"), changes: Uint8Array[] = [];
	const dead = versionDoc(ref(4));
	for (let n = 1; n <= 4; n++) notes.set(id(n), { p: id(n) });
	index.on("update", u => changes.push(u));
	notes.set(id(1), { p: "renamed" });
	notes.set(id(4), { p: id(4), d: Buffer.from(Y.encodeStateVector(dead)).toString("base64"), t: 10 });
	const values = new Map<string, unknown>([
		["index", Y.encodeStateAsUpdate(index)], ["out:1", entry("index", Y.mergeUpdates(changes))],
		["out:2", entry(id(3), Y.encodeStateAsUpdate(dead))], ["state:" + id(4), Y.encodeStateAsUpdate(dead)],
		["up:" + id(2), { ref: ref(7), base: ref(2).h }],
	]);
	for (let n = 1; n <= 4; n++) values.set("note:" + id(n), { diskPath: n === 4 ? undefined : n === 1 ? "renamed" : id(n), baseHash: ref(7).h });
	const store: Store = {
		async get<T>(k: string) { return values.get(k) as T; },
		async list<T>(p: string) { return [...values].filter(([k]) => k.startsWith(p)) as [string, T][]; },
		async commit() { assert.fail("handoff must be committed by the caller"); }
	};
	const puts = await legacyBases(store, key);
	const local = async (n: number) => puts.get("table/local/" + hex(await tableFileId(key, unhex(id(n))))) as Local;
	assert.equal((await local(1)).base.path, undefined);
	assert.deepEqual((await local(2)).base, { path: id(2), bytes: { h: ref(2).h } });
	assert.equal((await local(3)).base.bytes, undefined);
	assert.equal((await local(4)).removed, true);
	assert.equal((await local(4)).base.bytes?.h, ref(4).h);
	index.destroy(); dead.destroy();
});

test("genesis dates undated tombstones at commit and preserves a replaced split version under a deterministic ID", async () => {
	for (const splitChild of [false, true]) {
		const index = new Y.Doc(), notes = index.getMap("notes"), projection = new LegacyProjection();
		notes.set(id(1), splitChild ? { p: "a.bin" } : { p: "a.bin", d: "AA==" });
		const parent = versionDoc(ref(4), ref(5)), child = versionDoc(ref(6));
		if (splitChild) notes.set(id(5), { p: "child.bin" });
		projection.applyIndex(entry("index", Y.encodeStateAsUpdate(index)));
		projection.applyAttachment(entry(id(1), Y.encodeStateAsUpdate(parent)));
		if (splitChild) projection.applyAttachment(entry(id(5), Y.encodeStateAsUpdate(child)));
		const rows = [];
		for await (const row of projection.rows(key)) rows.push(row);
		if (splitChild) {
			assert.equal(rows.find(r => r.bytes.h === ref(6).h)!.file, hex(await tableFileId(key, unhex(id(5)))));
			const replaced = rows.find(r => r.bytes.h === ref(5).h)!;
			assert.equal(replaced.dateAtCommit, true);
			assert.equal(replaced.file, hex(await tableFileId(key, unhex(id(5) + id(5)))));
		} else assert.ok(rows.every(r => r.dateAtCommit));
		projection.close(); parent.destroy(); child.destroy(); index.destroy();
	}
});

test("private displacement and no-overwrite installation preserve racing saves across restart", async () => {
	const { TableDisk } = await import("../src/tableDisk");
	const { attachmentFs } = await import("./table-fs");
	for (const race of ["before", "after", "both", "crash"] as const) {
		const { fs, store, files, bytes } = attachmentFs();
		const text = (s: string) => new TextEncoder().encode(s).buffer;
		const hash = async (b: Uint8Array) => new TextDecoder().decode(b);
		const open = () => new TableDisk(fs, store, ".private/scratch", p => !p.startsWith("."), hash, async () => "abcdef");
		const disk = open(), rename = fs.rename;
		await fs.writeBinary("x", text("agreed")); await disk.writeTemp(new Uint8Array(text("remote")));
		fs.rename = async (from, to) => {
			if (race === "before" || race === "both") await fs.writeBinary(from, text("first save"));
			await rename(from, to);
			if (race === "after" || race === "both") await fs.writeBinary(from, text("second save"));
			if (race === "crash") throw new Error("killed after displacement");
		};
		if (race === "crash") await assert.rejects(disk.installTemp("x", "agreed"), /killed/);
		else assert.equal(await disk.installTemp("x", "agreed"), false);
		await open().discardTemp();
		assert.equal(await hash(bytes("x")), race === "crash" ? "remote" : race === "before" ? "first save" : "second save");
		if (race === "both") assert.equal(await hash(bytes("x (conflict abcdef)")), "first save");
		assert.ok([...files.keys()].every(p => !p.startsWith(".")));
	}
});

test("a notes-only device catches up across its excluded config path without touching disk", async () => {
	const { TableSync } = await import("../src/tableSync");
	const { attachmentFs } = await import("./table-fs");
	const { store } = attachmentFs();
	const keys = { vmk: key, epoch: 0, vaultId: new Uint8Array(16), me: { id: new Uint8Array(16) },
		keyFor: () => key, state: {} } as unknown as import("../src/keys").VaultKeys;
	const table = new TableSync(store, keys, new Proxy({} as import("../src/core/table/disk").DiskPort, {
		get() { assert.fail("notes-only device accessed disk"); }
	}), path => !path.startsWith("my-config/"), false, 20 * 2**20, () => {});
	await table.connect(async () => assert.fail("notes-only device requested chunks"));
	const row = { file: "01".repeat(16), bytes: ref(1), path: "my-config/example.bin", mtime: null, seq: 1, deleted: null };
	await table.row(await table.wireRow(row)); await table.ready(1); await table.idle();
	assert.equal((await store.get<{ cursor: number }>("table/meta"))?.cursor, 1);
	assert.equal((await store.get<Row>("table/latest/" + row.file))?.path, row.path);
});

test("the sync driver reports a repeated settlement state and retries on new input", async () => {
	const { TableSync } = await import("../src/tableSync");
	const { Files, Memory } = await import("./table-sim");
	const disk = new Files(), problems: string[] = [];
	const keys = { vmk: key, epoch: 0, vaultId: new Uint8Array(16), me: { id: new Uint8Array(16) },
		keyFor: () => key, state: {} } as unknown as import("../src/keys").VaultKeys;
	const table = new TableSync(new Memory(), keys, disk, () => true, true, 20 * 2**20,
		(_, error) => problems.push(String(error)));
	const install = disk.installTemp.bind(disk);
	disk.installTemp = async () => false;
	const bytes = { ...ref(1), n: 0, h: await table.hash(new Uint8Array()) };
	await table.connect(async () => assert.fail("empty version requested chunks"));
	await table.row(await table.wireRow({ file: "01".repeat(16), path: "a.bin", bytes, mtime: null, seq: 1, deleted: null }));
	await table.ready(1); await table.idle();
	assert.equal(problems.length, 1); assert.match(problems[0]!, /settlement repeated a state/);
	assert.equal(disk.files.size, 0);
	disk.installTemp = install;
	await table.event({ kind: "settle" }); await table.idle();
	assert.equal(disk.text("a.bin"), "");
	assert.equal(problems.length, 1);
});

test("two unsent legacy renames carry the first source path through restart and handoff", async () => {
	const { Device, Server, quiesce, rng } = await import("./sim");
	const device = new Device("migrating", new Server(), rng(42));
	device.boot(); device.connect(); await quiesce([device]);
	device.write("original.bin", new Uint8Array([1])); await quiesce([device]);
	device.disconnect();
	device.rename("original.bin", "middle.bin"); await quiesce([device]);
	device.rename("middle.bin", "final.bin"); await quiesce([device]);
	device.crash(); device.boot(); await quiesce([device]);
	await device.engine!.useTable(key);
	const [local] = [...device.data].filter(([k]) => k.startsWith("table/local/")).map(([,v]) => v as Local);
	assert.equal(local?.path, "final.bin");
	assert.equal(local.base.path, "original.bin");
	assert.deepEqual(device.problems, []);
	device.crash();
});

test("genesis rejects a version without its identity, even when the bytes repeat", async () => {
	const projection = new LegacyProjection(), index = new Y.Doc();
	index.getMap("notes").set(id(1), { p: "broken.bin" });
	const { u, ...invalid } = ref(2);
	const doc = versionDoc(ref(2), invalid as Ref);
	try {
		projection.applyIndex(entry("index", Y.encodeStateAsUpdate(index)));
		projection.applyAttachment(entry(id(1), Y.encodeStateAsUpdate(doc)));
		await assert.rejects(async () => { for await (const _ of projection.rows(key)) { /* drain */ } },
			/Missing or invalid legacy version identity at broken.bin/);
	} finally { index.destroy(); doc.destroy(); projection.close(); }
});

test("a failed download retries with unchanged disk and row, including after restart", async () => {
	const { TableDevice, catchUp } = await import("../src/core/table/device");
	const { planDisk, executeIntent } = await import("../src/core/table/disk");
	const { TableDisk } = await import("../src/tableDisk");
	const { attachmentFs } = await import("./table-fs");
	for (const restart of [false, true]) {
		const { fs, store, bytes } = attachmentFs();
		const hash = async (b: Uint8Array) => hex(b);
		const disk = new TableDisk(fs, store, ".private/scratch", p => !p.startsWith("."), hash, async () => "abcdef");
		const data = new Uint8Array([42]);
		const row = { file: id(1), path: "a.png", bytes: { ...ref(1), h: await hash(data) }, mtime: null, seq: 1, deleted: null };
		let attempts = 0, device = await TableDevice.open(store);
		const inputs = { attachments: true, allowed: () => true, maxFileSize: data.length, hash,
			readStage: async () => undefined, fetch: async () => {
				if (++attempts === 1) throw new Error("disconnected");
				return data;
			}, id: () => assert.fail(), stage: async () => assert.fail(), pack: async () => assert.fail(), suffix: async () => assert.fail() };
		await device.change(s => catchUp(s, row));
		await planDisk(device, disk, inputs, { kind: "settle" });
		const failed = new Set<string>();
		assert.equal(await executeIntent(device, disk, inputs, failed), false);
		const second = { ...row, file: id(2), path: "b.png", seq: 2 };
		await device.change(s => catchUp(s, second));
		await planDisk(device, disk, inputs, { kind: "settle" }, failed);
		assert.equal(await device.change(s => s.intent?.file), second.file);
		assert.equal(await executeIntent(device, disk, inputs, failed), true);
		if (restart) device = await TableDevice.open(store);
		await planDisk(device, disk, inputs, { kind: restart ? "startup" : "settle" });
		assert.equal(await executeIntent(device, disk, inputs), true);
		assert.deepEqual(bytes(row.path), data);
		assert.equal(attempts, 3);
	}
});
