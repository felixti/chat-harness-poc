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
	/** Held by an AG-UI interrupt until the user approves. */
	waiting?: boolean;
}
export interface CanvasMeta {
	name: string;
	title: string;
	versions: { v: number; at: string; note?: string }[];
}
export interface CanvasDoc extends CanvasMeta {
	version?: number;
	html: string;
	state: unknown;
}
/** CUSTOM "canvas": a version saved during the running turn (not in storage until the turn ends). */
export interface CanvasEvent {
	name: string;
	title: string;
	version: number;
	html: string;
}
/** A web page a search/crawl tool returned in this reply (CUSTOM "sources"). */
export interface Source {
	url: string;
	title: string;
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
/** AG-UI interrupt (approval or questions), as sent in RUN_FINISHED.outcome. */
export interface Interrupt {
	id: string;
	reason: "tool_call" | "input_required";
	message: string;
	toolCallId?: string;
	metadata?: {
		toolName?: string;
		input?: unknown;
		questions?: { id: string; question: string; options: { label: string; description?: string }[]; recommended?: string; multiSelect?: boolean }[];
	};
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
			/** The model's reasoning (REASONING_* events), shown collapsed. */
			reasoning?: string;
			sources?: Source[];
			memory?: MemoryUsed;
			saved?: string[];
			newFiles?: FileInfo[];
			error?: string;
			streaming?: boolean;
			interrupts?: Interrupt[];
	  };
export interface ConversationDetail {
	id: string;
	title: string;
	messages: Message[];
	files: FileInfo[];
	feedback: Record<string, "up" | "down">;
	interrupts?: Interrupt[];
	cost?: import("./cost").Spend;
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

export type Effort = "low" | "medium" | "high";
export interface ModelChoice {
	id: string;
	label: string;
	note: string;
}

export class HttpError extends Error {
	status: number;
	code?: string;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** The Entra ID sign-in session ended. Envoy answers portal requests with 401 instead of a
 *  redirect to the login page (denyRedirect in deploy/route.yaml), which fetch cannot follow. */
export class SessionExpired extends Error {}

/** fetch for the portal API: marks the request so Envoy does not redirect it, and turns a
 *  gateway 401 (not JSON; chat-api's own 401s are) into SessionExpired + a window event. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("x-requested-with", "fetch");
	const r = await fetch(path, { ...init, headers });
	if (r.status === 401 && !r.headers.get("content-type")?.includes("json")) {
		dispatchEvent(new Event("session-expired"));
		throw new SessionExpired("Sua sessão expirou.");
	}
	return r;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const r = await apiFetch(path, init);
	if (!r.ok) {
		const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
		throw new HttpError(r.status, j.error ?? `HTTP ${r.status}`, j.code);
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
	usage: () => req<{ month: import("./cost").Spend; usdBrl: number }>("api/usage"),
	models: () => req<{ models: ModelChoice[]; default: string; efforts: Effort[]; defaultEffort: Effort }>("api/models"),
	conversation: (id: string) => req<ConversationDetail>(`api/conversations/${id}`),
	rename: (id: string, title: string) => req(`api/conversations/${id}`, send("PATCH", { title })),
	remove: (id: string) => req(`api/conversations/${id}`, send("DELETE")),
	canvases: (conv: string) => req<CanvasMeta[]>(`api/conversations/${conv}/canvas`),
	canvas: (conv: string, name: string, v?: number) => req<CanvasDoc>(`api/conversations/${conv}/canvas/${name}${v ? `?v=${v}` : ""}`),
	saveCanvasState: (conv: string, name: string, state: unknown) => req(`api/conversations/${conv}/canvas/${name}/state`, send("PUT", state)),
	removeMany: (ids: string[]) => req<{ deleted: string[] }>("api/conversations/delete", send("POST", { ids })),
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
	saveToOneDrive: (conv: string, path: string, again = false) => req<{ webUrl: string; name: string; existed: boolean }>(`api/conversations/${conv}/onedrive`, send("POST", { path, again })),
	importDrive: (conv: string, items: { driveId: string; id: string; name: string }[]) => req<{ paths: string[] }>(`api/conversations/${conv}/import`, send("POST", { items })),
	disconnect: (id: string) => req(`api/connectors/${id}`, send("DELETE")),
};

export const fileUrl = (conv: string, path: string, inline = false) =>
	`api/conversations/${conv}/files/${encodeURIComponent(path)}${inline ? "?inline=1" : ""}`;

/** AG-UI events the portal handles (https://github.com/ag-ui-protocol/ag-ui). */
export type AguiEvent =
	| { type: "RUN_STARTED"; threadId: string; runId: string }
	| { type: "TEXT_MESSAGE_START"; messageId: string }
	| { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
	| { type: "TEXT_MESSAGE_END"; messageId: string }
	| { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
	| { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
	| { type: "TOOL_CALL_END"; toolCallId: string }
	| { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string; metadata?: { isError?: boolean } }
	| { type: "CUSTOM"; name: string; value: unknown }
	| { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
	| { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: string; content: unknown }
	| { type: "RUN_FINISHED"; threadId: string; runId: string; outcome?: { type: "success" } | { type: "interrupt"; interrupts: Interrupt[] } }
	| { type: "RUN_ERROR"; message: string; code?: string };

export interface ResumeEntry {
	interruptId: string;
	status: "resolved" | "cancelled";
	payload?: unknown;
}

/** POST an AG-UI RunAgentInput to /api/chat and yield events. Aborting stops the run on the server. */
export async function* chat(
	input: { threadId: string; message?: string; skills?: string[]; edit?: boolean; resume?: ResumeEntry[]; model?: string; effort?: Effort },
	signal: AbortSignal,
): AsyncGenerator<AguiEvent> {
	const body = {
		threadId: input.threadId,
		runId: crypto.randomUUID(),
		state: {},
		messages: input.message ? [{ id: crypto.randomUUID(), role: "user", content: input.message }] : [],
		tools: [],
		context: [],
		forwardedProps: { skills: input.skills ?? [], edit: !!input.edit, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) },
		...(input.resume ? { resume: input.resume } : {}),
	};
	const r = await apiFetch("api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
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
			if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as AguiEvent;
		}
	}
}
