// Conversation workspaces: the agent works on a local copy under /tmp (the only writable path),
// Azure Blob is the source of truth. Any replica can serve any conversation: before a turn the
// workspace is restored from Blob if this pod does not have it; after the turn, files changed
// during the turn are uploaded. Blob layout: <user>/<conversation>/<relative path>.
import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { WorkloadIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { config } from "./config.ts";

export interface FileInfo {
	path: string;
	size: number;
}

let container: ContainerClient | undefined;

/** Blob container, or undefined when running locally without BLOB_ACCOUNT_URL. */
function blob(): ContainerClient | undefined {
	if (!config.blob.accountUrl) return undefined;
	// WorkloadIdentityCredential reads the token file AKS mounts; no CLI-based credential
	// (DefaultAzureCredential would try az/azd/pwsh subprocesses, forbidden here).
	container ??= new BlobServiceClient(config.blob.accountUrl, new WorkloadIdentityCredential()).getContainerClient(config.blob.container);
	return container;
}

export function workspacePath(user: string, conversation: string): string {
	return join(config.tmpRoot, "ws", user, conversation);
}

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

/** Restores the workspace from Blob when this pod has no local copy. Returns the local path. */
export async function hydrate(user: string, conversation: string): Promise<string> {
	const dir = workspacePath(user, conversation);
	const exists = await stat(dir).then(() => true, () => false);
	await mkdir(join(dir, "uploads"), { recursive: true });
	const c = blob();
	if (exists || !c) return dir;
	const prefix = `${user}/${conversation}/`;
	for await (const item of c.listBlobsFlat({ prefix })) {
		const target = join(dir, item.name.slice(prefix.length));
		await mkdir(dirname(target), { recursive: true });
		await c.getBlockBlobClient(item.name).downloadToFile(target);
	}
	return dir;
}

/** Uploads one file now (user uploads go to Blob immediately). */
export async function persistFile(user: string, conversation: string, rel: string): Promise<void> {
	const c = blob();
	if (!c) return;
	const data = await readFile(join(workspacePath(user, conversation), rel));
	await c.getBlockBlobClient(`${user}/${conversation}/${rel}`).uploadData(data);
}

/** Uploads files modified since `sinceMs` (the turn start). */
export async function persistChanges(user: string, conversation: string, sinceMs: number): Promise<void> {
	if (!blob()) return;
	const dir = workspacePath(user, conversation);
	const changed = (await listLocal(dir)).filter((f) => f.mtimeMs >= sinceMs);
	await Promise.all(changed.map((f) => persistFile(user, conversation, f.path)));
}

/** Reads a file for download: local copy first, Blob when this pod does not have it. */
export async function readWorkspaceFile(user: string, conversation: string, rel: string, local: string): Promise<Buffer> {
	try {
		return await readFile(local);
	} catch (e) {
		const c = blob();
		if (!c) throw Object.assign(new Error("not found"), { status: 404, cause: e });
		const data = await c.getBlockBlobClient(`${user}/${conversation}/${rel}`).downloadToBuffer();
		await mkdir(dirname(local), { recursive: true });
		await writeFile(local, data);
		return data;
	}
}
