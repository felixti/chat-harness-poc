// Conversation workspaces, stateless: Azure Blob is the only source of truth, /tmp is scratch for
// one turn. Any replica serves any request:
//   1. lease the conversation (Blob lease on _locks/<user>/<conversation>), so one turn runs at a
//      time across all pods; a second tab or pod gets 409 instead of a lost update;
//   2. download <user>/<conversation>/* into a fresh /tmp directory and remember what came down;
//   3. run the turn;
//   4. upload files created or changed, delete blobs of files the turn removed;
//   5. delete the local directory and release the lease.
// Downloads, uploads and listings go straight to Blob, never through a pod's local copy.
// The local path stays /tmp/chat/ws/<user>/<conversation> (stable, so absolute paths in the
// history still work); the lease guarantees no other turn uses it at the same time.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { WorkloadIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { config } from "./config.ts";

export interface FileInfo {
	path: string;
	size: number;
	/** Last write, and last read when the account tracks access time (drives the retention rule). */
	modified?: Date;
	accessed?: Date;
}

/** The storage the workspaces live in: Azure Blob in the cluster, a local folder in dev and tests. */
export interface ObjectStore {
	list(prefix: string): Promise<FileInfo[]>;
	get(name: string): Promise<Buffer | undefined>;
	put(name: string, data: Buffer): Promise<void>;
	delete(name: string): Promise<void>;
	/** Exclusive lock for `seconds` (15 to 60); undefined when someone else holds it. */
	lease(name: string, seconds: number): Promise<Lease | undefined>;
}

export interface Lease {
	renew(): Promise<void>;
	release(): Promise<void>;
}

class BlobStore implements ObjectStore {
	private readonly c: ContainerClient;
	constructor(c: ContainerClient) {
		this.c = c;
	}
	async list(prefix: string) {
		const out: FileInfo[] = [];
		for await (const b of this.c.listBlobsFlat({ prefix }))
			out.push({ path: b.name.slice(prefix.length), size: b.properties.contentLength ?? 0, modified: b.properties.lastModified, accessed: b.properties.lastAccessedOn });
		return out;
	}
	async get(name: string) {
		return this.c
			.getBlockBlobClient(name)
			.downloadToBuffer()
			.catch((e) => (e?.statusCode === 404 ? undefined : Promise.reject(e)));
	}
	async put(name: string, data: Buffer) {
		await this.c.getBlockBlobClient(name).uploadData(data);
	}
	async delete(name: string) {
		await this.c.getBlockBlobClient(name).deleteIfExists();
	}
	async lease(name: string, seconds: number) {
		const blob = this.c.getBlockBlobClient(name);
		// The lock blob must exist; If-None-Match: * keeps an existing (maybe leased) blob untouched.
		await blob.upload("", 0, { conditions: { ifNoneMatch: "*" } }).catch((e) => {
			if (e?.statusCode !== 409 && e?.statusCode !== 412) throw e;
		});
		const lc = blob.getBlobLeaseClient();
		try {
			await lc.acquireLease(seconds);
		} catch (e) {
			if ((e as { statusCode?: number }).statusCode === 409) return undefined;
			throw e;
		}
		return { renew: async () => void (await lc.renewLease()), release: async () => void (await lc.releaseLease().catch(() => undefined)) };
	}
}

/** Same contract on the local disk (dev without BLOB_ACCOUNT_URL, tests). Locks are per process. */
export class FolderStore implements ObjectStore {
	private readonly locks = new Map<string, number>();
	private readonly root: string;
	constructor(root: string) {
		this.root = root;
	}
	async list(prefix: string) {
		const base = join(this.root, prefix);
		return (await listLocal(base)).map(({ path, size, mtimeMs }) => ({ path, size, modified: new Date(mtimeMs) }));
	}
	async get(name: string) {
		return readFile(join(this.root, name)).catch(() => undefined);
	}
	async put(name: string, data: Buffer) {
		await mkdir(dirname(join(this.root, name)), { recursive: true });
		await writeFile(join(this.root, name), data);
	}
	async delete(name: string) {
		await rm(join(this.root, name), { force: true });
	}
	async lease(name: string, seconds: number) {
		const until = this.locks.get(name);
		if (until && until > Date.now()) return undefined;
		this.locks.set(name, Date.now() + seconds * 1000);
		return {
			renew: async () => void this.locks.set(name, Date.now() + seconds * 1000),
			release: async () => void this.locks.delete(name),
		};
	}
}

let store: ObjectStore | undefined;
export function objectStore(): ObjectStore {
	store ??= config.blob.accountUrl
		? // WorkloadIdentityCredential reads the token file AKS mounts; no CLI-based credential
			// (DefaultAzureCredential would try az/azd/pwsh subprocesses, forbidden here).
			new BlobStore(new BlobServiceClient(config.blob.accountUrl, new WorkloadIdentityCredential()).getContainerClient(config.blob.container))
		: new FolderStore(join(config.tmpRoot, "local-blob"));
	return store;
}
/** Tests swap the store. */
export function setObjectStore(s: ObjectStore) {
	store = s;
}

export function workspacePath(user: string, conversation: string): string {
	return join(config.tmpRoot, "ws", user, conversation);
}

const prefixOf = (user: string, conversation: string) => `${user}/${conversation}/`;

export async function listLocal(dir: string, root = dir): Promise<(FileInfo & { mtimeMs: number })[]> {
	const out: (FileInfo & { mtimeMs: number })[] = [];
	for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await listLocal(full, root)));
		else if (e.isFile()) {
			const s = await stat(full);
			out.push({ path: relative(root, full), size: s.size, mtimeMs: s.mtimeMs });
		}
	}
	return out;
}

export class ConversationBusyError extends Error {
	status = 409;
	constructor() {
		super("conversation busy: another turn is running (other tab or device); try again when it ends");
	}
}

const LEASE_SECONDS = 60;

export interface Turn {
	dir: string;
	/** Files as they came down from Blob: path -> "size:mtime". */
	snapshot: Map<string, string>;
	finish(): Promise<FileInfo[]>;
	abandon(): Promise<void>;
}

/** Leases the conversation and materializes its workspace in a clean local directory. */
export async function openTurn(user: string, conversation: string): Promise<Turn> {
	const s = objectStore();
	const lease = await s.lease(`_locks/${user}/${conversation}`, LEASE_SECONDS);
	if (!lease) throw new ConversationBusyError();
	const renew = setInterval(() => void lease.renew().catch((e) => console.warn(`[turn] lease renew: ${(e as Error).message}`)), (LEASE_SECONDS / 3) * 1000);
	const dir = workspacePath(user, conversation);
	const cleanup = async () => {
		clearInterval(renew);
		await rm(dir, { recursive: true, force: true });
		await lease.release();
	};
	try {
		await rm(dir, { recursive: true, force: true }); // never trust what a crashed turn left
		await mkdir(join(dir, "uploads"), { recursive: true });
		const prefix = prefixOf(user, conversation);
		for (const f of await s.list(prefix)) {
			const target = join(dir, f.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, (await s.get(prefix + f.path)) ?? Buffer.alloc(0));
		}
		const snapshot = new Map((await listLocal(dir)).map((f) => [f.path, `${f.size}:${f.mtimeMs}`]));
		return {
			dir,
			snapshot,
			async finish() {
				try {
					const now = await listLocal(dir);
					const changed = now.filter((f) => snapshot.get(f.path) !== `${f.size}:${f.mtimeMs}`);
					const present = new Set(now.map((f) => f.path));
					const removed = [...snapshot.keys()].filter((p) => !present.has(p));
					await Promise.all([
						...changed.map(async (f) => s.put(prefix + f.path, await readFile(join(dir, f.path)))),
						...removed.map((p) => s.delete(prefix + p)),
					]);
					return now.map(({ path, size }) => ({ path, size }));
				} finally {
					await cleanup();
				}
			},
			abandon: cleanup,
		};
	} catch (e) {
		await cleanup();
		throw e;
	}
}

/** Files of a conversation, from Blob. */
export async function listFiles(user: string, conversation: string): Promise<FileInfo[]> {
	return (await objectStore().list(prefixOf(user, conversation))).map(({ path, size }) => ({ path, size }));
}

export async function readFileFromStore(user: string, conversation: string, rel: string): Promise<Buffer> {
	const data = await objectStore().get(prefixOf(user, conversation) + rel);
	if (!data) throw Object.assign(new Error("file expired or removed (files are kept 30 days after last use)"), { status: 404 });
	return data;
}

/** User uploads go straight to Blob; the next turn downloads them. */
export async function writeFileToStore(user: string, conversation: string, rel: string, data: Buffer): Promise<void> {
	await objectStore().put(prefixOf(user, conversation) + rel, data);
}
