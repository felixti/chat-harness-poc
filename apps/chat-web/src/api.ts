// Thin client for chat-api. Same origin; identity comes from the gateway session cookie.
export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: string;
}
export interface ToolStep {
	type: "tool";
	id: string;
	name: string;
	args: unknown;
	isError?: boolean;
	running?: boolean;
}
export interface TextPart {
	type: "text";
	text: string;
}
export interface MemoryUsed {
	core: number;
	facts: string[];
	conversations: string[];
}
export interface FileInfo {
	path: string;
	size: number;
}
export type Message =
	| { role: "user"; id: string; text: string }
	| {
			role: "assistant";
			id: string;
			parts: (TextPart | ToolStep)[];
			memory?: MemoryUsed;
			saved?: string[];
			newFiles?: FileInfo[];
			error?: string;
			streaming?: boolean;
	  };
export interface ConversationDetail {
	id: string;
	title: string;
	messages: Message[];
	files: FileInfo[];
	feedback: Record<string, "up" | "down">;
}
export interface LibraryFile {
	id: string;
	conversation: string;
	title?: string;
	path: string;
	name: string;
	kind: "upload" | "output";
	size: number;
	modified?: string;
	expiresAt?: string;
}
export interface DriveEntry {
	id: string;
	driveId: string;
	name: string;
	folder: boolean;
	size: number;
	modified?: string;
	by?: string;
	supported: boolean;
}

export interface Skill {
	name: string;
	label?: string;
	description: string;
	personal?: boolean;
}
export interface Connector {
	id: string;
	name: string;
	summary: string;
	connected: boolean;
	account: string;
	readOnly: boolean;
}
export interface Fact {
	id: string;
	subject: string;
	subjectKind?: string;
	relation: string;
	object: string;
	objectKind?: string;
	at: string;
	note: string;
}

export class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const r = await fetch(path, init);
	if (!r.ok) {
		const j = (await r.json().catch(() => ({}))) as { error?: string };
		throw new HttpError(r.status, j.error ?? `HTTP ${r.status}`);
	}
	return r.json() as Promise<T>;
}
const send = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: body === undefined ? undefined : { "content-type": "application/json" },
	body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
	conversations: () => req<ConversationSummary[]>("api/conversations"),
	conversation: (id: string) => req<ConversationDetail>(`api/conversations/${id}`),
	rename: (id: string, title: string) => req(`api/conversations/${id}`, send("PATCH", { title })),
	remove: (id: string) => req(`api/conversations/${id}`, send("DELETE")),
	feedback: (id: string, turn: string, value: "up" | "down" | null) => req(`api/conversations/${id}/feedback`, send("POST", { turn, value })),
	files: (id: string) => req<FileInfo[]>(`api/conversations/${id}/files`),
	upload: (id: string, file: File) => req<{ path: string }>(`api/conversations/${id}/uploads/${encodeURIComponent(file.name)}`, { method: "POST", body: file }),
	attach: (id: string, fileId: string) => req<{ path: string }>(`api/conversations/${id}/attach`, send("POST", { file_id: fileId })),
	library: () => req<LibraryFile[]>("api/files"),
	removeLibraryFile: (fileId: string) => req(`api/files?id=${encodeURIComponent(fileId)}`, send("DELETE")),
	skills: () => req<Skill[]>("api/skills"),
	memory: () => req<{ user: string[]; memory: string[] }>("api/memory"),
	forgetEntry: (target: "user" | "memory", text: string) => req(`api/memory?target=${target}&text=${encodeURIComponent(text)}`, send("DELETE")),
	clearMemory: () => req("api/memory", send("DELETE")),
	graph: () => req<{ entities: number; facts: number; recent: Fact[] }>("api/memory/graph"),
	forgetFact: (id: string) => req(`api/memory/graph/${id}`, send("DELETE")),
	mySkills: () => req<{ name: string; description: string; updatedAt: string }[]>("api/memory/skills"),
	removeMySkill: (name: string) => req(`api/memory/skills/${name}`, send("DELETE")),
	connectors: () => req<Connector[]>("api/connectors"),
	drive: (view: string, p: { driveId?: string; id?: string; q?: string } = {}) =>
		req<DriveEntry[]>(`api/m365/browse?${new URLSearchParams({ view, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })}`),
	importDrive: (conv: string, items: { driveId: string; id: string; name: string }[]) => req<{ paths: string[] }>(`api/conversations/${conv}/import`, send("POST", { items })),
	disconnect: (id: string) => req(`api/connectors/${id}`, send("DELETE")),
};

export const fileUrl = (conv: string, path: string, inline = false) =>
	`api/conversations/${conv}/files/${encodeURIComponent(path)}${inline ? "?inline=1" : ""}`;

export type StreamEvent =
	| { type: "start"; conversationId: string }
	| { type: "delta"; text: string }
	| { type: "tool"; name: string; args: unknown }
	| { type: "tool_end"; name: string; isError?: boolean }
	| { type: "memory_used"; core: number; facts: string[]; conversations: string[] }
	| { type: "memory"; saved: string[] }
	| { type: "done"; conversationId: string; files: FileInfo[] }
	| { type: "error"; message: string };

/** POST /api/chat and yield SSE events. Aborting the signal stops the turn on the server too. */
export async function* chat(body: { conversationId?: string; message: string; skills?: string[]; edit?: boolean }, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	const r = await fetch("api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
	if (!r.ok || !r.body) {
		const j = (await r.json().catch(() => ({}))) as { error?: string };
		throw new HttpError(r.status, j.error ?? `HTTP ${r.status}`);
	}
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 2);
			if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as StreamEvent;
		}
	}
}
