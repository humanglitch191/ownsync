// The engine's local database, in IndexedDB: one key-value store per vault. A commit is one IndexedDB
// transaction, so it is stored whole or not at all.

import type { Store } from "./core/ports";

const KV = "kv";

export class IdbStore implements Store {
	private db: Promise<IDBDatabase>;

	constructor(readonly name: string) {
		this.db = new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => open.result.createObjectStore(KV);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
	}

	async get<T>(key: string): Promise<T | undefined> {
		return request<T | undefined>((await this.db).transaction(KV).objectStore(KV).get(key));
	}

	async list<T>(prefix: string): Promise<[string, T][]> {
		const store = (await this.db).transaction(KV).objectStore(KV);
		const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
		const [keys, values] = await Promise.all([request<IDBValidKey[]>(store.getAllKeys(range)), request<T[]>(store.getAll(range))]);
		return keys.map((k, i) => [String(k), values[i]!]);
	}

	async commit(puts: Map<string, unknown>, deletes: Iterable<string>): Promise<void> {
		const tx = (await this.db).transaction(KV, "readwrite");
		const store = tx.objectStore(KV);
		for (const key of deletes) store.delete(key);
		for (const [key, value] of puts) store.put(value, key);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("the local database refused a write"));
		});
	}

	async close(): Promise<void> {
		(await this.db).close();
	}
}

function request<T>(req: IDBRequest): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result as T);
		req.onerror = () => reject(req.error);
	});
}
