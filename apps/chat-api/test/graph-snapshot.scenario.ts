// The graph-memory snapshot plan as one scenario, run on the in-memory store (unit test) and on
// the real Blob container (graph-memory.blob.it.ts). Needs setLogStore/setDocStore done by the caller.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compact, FactGraph } from "../src/graph-memory.ts";
import { docStore } from "../src/memory.ts";

export interface Store {
	user: string;
	keys(prefix: string): Promise<string[]>;
	read(key: string): Promise<Buffer>;
	corrupt(key: string): Promise<void>;
	write(key: string, data: Buffer): Promise<void>;
}

export async function snapshotPlan(s: Store) {
	const V = s.user;
	const T = (name: string) => ({ name, kind: "topic" as const });
	const snapKeys = () => s.keys(`${V}/graph/`);
	const versions = async () => [...new Set((await snapKeys()).filter((k) => k.split("/").length > 3).map((k) => k.split("/")[2]))];
	const ptr = async () => docStore().get(`${V}/graph/current.json`);
	const add = async (from: number, n: number, conv: string) => {
		const g = new FactGraph(V, conv);
		for (let i = from; i < from + n; i++) await g.remember(T(`Tema ${i}`), "relacionado a", T("Plano Anual"));
		await g.dispose();
	};
	const count = async (conv: string) => {
		const g = new FactGraph(V, conv);
		const n = (await g.recall("Plano Anual", undefined, 100)).facts.length;
		await g.dispose();
		return n;
	};
	// 1. 49 events across turns: no snapshot, the graph lives only in the turn's /tmp copy.
	await add(0, 30, "s1");
	await add(30, 19, "s2");
	assert.equal(await ptr(), undefined, "no pointer below 50 events");
	assert.deepEqual(await snapKeys(), []);
	// 2. The 50th event (the turn sees 49 pending + 1 new) writes the first snapshot.
	await add(49, 1, "s3");
	assert.ok(await ptr(), "pointer written at 50");
	const [v1] = await versions();
	assert.ok(v1, "snapshot version stored");
	// The seal binds the file path, not the version: keep v1's manifest to replay it later.
	const oldManifest = await s.read(`${V}/graph/${v1}/manifest.json`);
	// 3. Sealed at rest: no snapshot file holds readable fact text.
	for (const k of await snapKeys()) assert.doesNotMatch((await s.read(k)).toString(), /Plano Anual|Tema \d/);
	// 4. Next turn opens from the snapshot: one new fact is not enough to compact again.
	await add(50, 1, "s4");
	assert.deepEqual(await versions(), [v1], "1 pending event: snapshot kept");
	assert.equal(await count("s5"), 51);
	// 5. A corrupt snapshot falls back to the events, and that turn heals it.
	await s.corrupt((await snapKeys()).find((k) => k.includes(`/graph/${v1}/`))!);
	assert.equal(await count("s6"), 51);
	const [v2] = await versions();
	assert.equal((await versions()).length, 1, "only the new version is kept");
	assert.notEqual(v2, v1, "broken version replaced");
	// 6. Two pods compacting at once: the lease lets one through.
	await add(51, 1, "s7");
	const runs = await Promise.all([compact(V), compact(V)]);
	assert.equal(runs.filter(Boolean).length, 1, "exactly one compactor wins");
	// 7. The new snapshot replaces the old one and holds every fact.
	assert.equal((await versions()).length, 1);
	assert.notEqual((await versions())[0], v2, "old version deleted");
	assert.equal(await count("s8"), 52);
	// 8. A snapshot that unseals but that Relate cannot open (stale manifest, or a format from
	//    another Relate version) also falls back to the events, and that turn heals it.
	const [v3] = await versions();
	await s.write(`${V}/graph/${v3}/manifest.json`, oldManifest);
	assert.equal(await count("s9"), 52);
	assert.notEqual((await versions())[0], v3, "unopenable version replaced");
	assert.equal(await count("s10"), 52);
	// 9. Nothing is left in the pod's /tmp after the turns.
	assert.deepEqual(await readdir(join(process.env.TMP_ROOT!, "graph")).catch(() => []), []);
}
