// OneDrive / SharePoint files through Microsoft Graph, server-side: the token never reaches the
// browser. The portal's picker browses (recent, my files, shared with me, folders, search) and
// imports the chosen files into the conversation's uploads/. Read-only.
import { accessToken } from "./connectors.ts";
import { objectStore } from "./workspace.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_BYTES = 100 * 1024 * 1024;

/** File types the harness reads (parse_document, describe_data, images). */
export const SUPPORTED = ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "xlsm", "csv", "txt", "md", "json", "png", "jpg", "jpeg", "webp", "html"];

export interface DriveEntry {
	id: string;
	driveId: string;
	name: string;
	folder: boolean;
	size: number;
	modified?: string;
	by?: string;
	webUrl?: string;
	supported: boolean;
}

type GraphItem = {
	id: string;
	name: string;
	size?: number;
	folder?: unknown;
	file?: unknown;
	lastModifiedDateTime?: string;
	lastModifiedBy?: { user?: { displayName?: string } };
	webUrl?: string;
	parentReference?: { driveId?: string };
	remoteItem?: GraphItem;
};

class NotConnected extends Error {
	status = 412;
	constructor() {
		super("connect OneDrive / SharePoint first");
	}
}

async function graph(user: string, path: string): Promise<Response> {
	const token = await accessToken(user, "microsoft");
	if (!token) throw new NotConnected();
	const r = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
	if (r.status === 401) throw Object.assign(new Error("Microsoft session expired: reconnect OneDrive / SharePoint"), { status: 401 });
	return r;
}

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

function entry(raw: GraphItem): DriveEntry | undefined {
	const it = raw.remoteItem ? { ...raw.remoteItem, name: raw.name ?? raw.remoteItem.name } : raw;
	const driveId = it.parentReference?.driveId;
	if (!driveId || (!it.file && !it.folder)) return undefined;
	const folder = !!it.folder;
	return {
		id: it.id,
		driveId,
		name: it.name,
		folder,
		size: it.size ?? 0,
		modified: it.lastModifiedDateTime,
		by: it.lastModifiedBy?.user?.displayName,
		webUrl: it.webUrl,
		supported: folder || SUPPORTED.includes(ext(it.name)),
	};
}

export type View = "recent" | "mine" | "shared" | "folder" | "search";

/** One page of items. Folders first, then newest; unsupported files are returned but marked. */
export async function browse(user: string, view: View, opts: { driveId?: string; id?: string; q?: string } = {}): Promise<DriveEntry[]> {
	const sel = "$top=200";
	let path: string;
	if (view === "recent") path = `/me/drive/recent?${sel}`;
	else if (view === "shared") path = `/me/drive/sharedWithMe?${sel}`;
	else if (view === "folder") {
		if (!opts.driveId || !opts.id || !/^[\w!.-]+$/.test(opts.driveId + opts.id)) throw Object.assign(new Error("bad folder"), { status: 400 });
		path = `/drives/${opts.driveId}/items/${opts.id}/children?${sel}`;
	} else if (view === "search") {
		const q = (opts.q ?? "").replace(/'/g, "''").slice(0, 100);
		if (!q.trim()) return [];
		path = `/me/drive/root/search(q='${encodeURIComponent(q)}')?${sel}`;
	} else path = `/me/drive/root/children?${sel}`;
	const r = await graph(user, path);
	const body = (await r.json().catch(() => ({}))) as { value?: GraphItem[]; error?: { message?: string } };
	if (!r.ok) throw Object.assign(new Error(`OneDrive: ${body.error?.message ?? r.status}`), { status: r.status === 404 ? 404 : 502 });
	const items = (body.value ?? []).map(entry).filter((e): e is DriveEntry => !!e);
	return items.sort((a, b) => Number(b.folder) - Number(a.folder) || (b.modified ?? "").localeCompare(a.modified ?? ""));
}

const safeName = (n: string) => n.replace(/[^\w.\- ()À-ÿ]/g, "_").replace(/^\.+/, "_").slice(0, 120);

/** Copies files from OneDrive / SharePoint into the conversation's uploads/ (no overwrite). */
export async function importFiles(user: string, conversation: string, items: { driveId: string; id: string; name: string }[]): Promise<string[]> {
	if (!items.length || items.length > 10) throw Object.assign(new Error("choose 1 to 10 files"), { status: 400 });
	const store = objectStore();
	const existing = new Set((await store.list(`${user}/${conversation}/uploads/`)).map((f) => f.path));
	const out: string[] = [];
	for (const it of items) {
		if (!/^[\w!.-]+$/.test(it.driveId + it.id)) throw Object.assign(new Error("bad item"), { status: 400 });
		if (!SUPPORTED.includes(ext(it.name))) throw Object.assign(new Error(`${it.name}: file type not supported`), { status: 415 });
		const r = await graph(user, `/drives/${it.driveId}/items/${it.id}/content`);
		if (!r.ok) throw Object.assign(new Error(`${it.name}: download failed (${r.status})`), { status: 502 });
		const len = Number(r.headers.get("content-length") ?? 0);
		if (len > MAX_BYTES) throw Object.assign(new Error(`${it.name}: over 100 MB`), { status: 413 });
		const data = Buffer.from(await r.arrayBuffer());
		if (data.length > MAX_BYTES) throw Object.assign(new Error(`${it.name}: over 100 MB`), { status: 413 });
		let name = safeName(it.name);
		const dot = name.lastIndexOf(".");
		for (let n = 2; existing.has(name); n++) name = `${safeName(it.name).slice(0, dot)} (${n})${safeName(it.name).slice(dot)}`;
		existing.add(name);
		await store.put(`${user}/${conversation}/uploads/${name}`, data);
		out.push(`uploads/${name}`);
	}
	return out;
}
