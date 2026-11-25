// Integration: the snapshot plan against the real Blob container (append blobs, ETags, leases).
// Not part of `npm test`. Run from an allowed IP, logged in with `az login`:
//   MEMORY_IT_BLOB=https://<account>.blob.core.windows.net node --experimental-strip-types --test test/graph-memory.blob.it.ts
// Uses a throwaway user and a random key, and deletes everything it wrote.
import { test, after } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
process.env.CONNECTORS_MASTER_KEY = randomBytes(32).toString("base64");
process.env.TMP_ROOT = await mkdtemp(join(tmpdir(), "graph-it-"));
const { BlobLog, setLogStore } = await import("../src/graph-memory.ts");
const { BlobDocStore, setDocStore } = await import("../src/memory.ts");
const { snapshotPlan } = await import("./graph-snapshot.scenario.ts");

const account = process.env.MEMORY_IT_BLOB;
const c = account ? new BlobServiceClient(account, new AzureCliCredential()).getContainerClient(process.env.MEMORY_IT_CONTAINER ?? "chat-memory") : undefined;
const user = `it-graph-${randomUUID().slice(0, 8)}`;
const keys = async (prefix: string) => {
	const out: string[] = [];
	for await (const b of c!.listBlobsFlat({ prefix })) out.push(b.name);
	return out;
};
after(async () => {
	if (!c) return;
	for (const p of [`${user}/`, `_locks/${user}/`]) for (const k of await keys(p)) await c.getBlockBlobClient(k).deleteIfExists({ deleteSnapshots: "include" });
});

test("snapshot plan on the real Blob container", { skip: !c && "set MEMORY_IT_BLOB" }, async () => {
	setLogStore(new BlobLog(c!));
	setDocStore(new BlobDocStore(c!));
	await snapshotPlan({
		user,
		keys,
		read: async (k) => c!.getBlockBlobClient(k).downloadToBuffer(),
		corrupt: async (k) => void (await c!.getBlockBlobClient(k).uploadData(Buffer.from("garbage"))),
	});
});
