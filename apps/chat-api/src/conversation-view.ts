// Pi session entries -> what the portal renders: user messages and assistant turns made of text
// parts and tool steps. System prompts, thinking and model bookkeeping are left out.
export interface ToolStep {
	type: "tool";
	id: string;
	name: string;
	args: unknown;
	isError?: boolean;
}
export interface TextPart {
	type: "text";
	text: string;
}
export type ViewMessage = { role: "user"; id: string; text: string; at?: string } | { role: "assistant"; id: string; parts: (TextPart | ToolStep)[]; at?: string };

type Entry = { type?: string; id?: string; timestamp?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };

/** The harness wraps pinned skills around the user's words; show only the words. */
export function cleanUserText(t: string): string {
	return t.replace(/^\/skill:[\w-]+\s+/, "").replace(/^First read and follow these skills: [^\n]*\n\n/, "");
}

export function entriesToView(entries: unknown[]): ViewMessage[] {
	const out: ViewMessage[] = [];
	const steps = new Map<string, ToolStep>();
	let current: Extract<ViewMessage, { role: "assistant" }> | undefined;
	for (const e of entries as Entry[]) {
		const m = e?.message;
		if (e?.type !== "message" || !m) continue;
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : ((m.content as { type?: string; text?: string }[]) ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			out.push({ role: "user", id: e.id ?? String(out.length), text: cleanUserText(text), at: e.timestamp });
			current = undefined;
		} else if (m.role === "assistant") {
			if (!current) {
				current = { role: "assistant", id: e.id ?? String(out.length), parts: [], at: e.timestamp };
				out.push(current);
			}
			for (const c of (Array.isArray(m.content) ? m.content : []) as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (c.type === "text" && c.text?.trim()) current.parts.push({ type: "text", text: c.text });
				else if (c.type === "toolCall" && c.name) {
					const step: ToolStep = { type: "tool", id: c.id ?? "", name: c.name, args: c.arguments };
					steps.set(step.id, step);
					current.parts.push(step);
				}
			}
		} else if (m.role === "toolResult" && m.toolCallId && m.isError) {
			const s = steps.get(m.toolCallId);
			if (s) s.isError = true;
		}
	}
	return out;
}

/** Entries before the last user message: "edit" and "regenerate" replay the turn from there. */
export function beforeLastUserMessage(entries: unknown[]): unknown[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as Entry;
		if (e?.type === "message" && e.message?.role === "user") return entries.slice(0, i);
	}
	return entries;
}
