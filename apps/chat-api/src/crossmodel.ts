// Switching models inside a conversation (H57). Tool calls made by another model carry no
// reasoning signature for the current one, and Gemini then often fails the turn
// (finish MALFORMED_RESPONSE, empty answer: about half the time in tests, 0 of 6 once the history
// was text). So, for the request only, another model's tool calls and their results become plain
// text; the stored session keeps them as they were. The call is dropped from the assistant turn
// (written there as text, the model imitated it instead of calling the tool) and described in the
// result, which goes as context from the system side.

type Part = { type: string; text?: string; name?: string; arguments?: unknown; id?: string };
type Msg = { role: string; model?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; [k: string]: unknown };

const MAX_RESULT = 4000;
const textOf = (content: unknown) =>
	Array.isArray(content)
		? (content as Part[])
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("\n")
		: String(content ?? "");

export function foreignToolCallsAsText<T>(messages: T[], model: string): T[] {
	const foreign = new Set<string>();
	let changed = false;
	const calls = new Map<string, Part>();
	const out = (messages as unknown as Msg[]).flatMap((m): Msg[] => {
		if (m.role === "assistant" && m.model && m.model !== model && Array.isArray(m.content) && (m.content as Part[]).some((p) => p.type === "toolCall")) {
			changed = true;
			for (const p of m.content as Part[]) if (p.type === "toolCall" && p.id) (foreign.add(p.id), calls.set(p.id, p));
			// Keep only what the user saw; another model's reasoning is not replayed either.
			const text = (m.content as Part[]).filter((p) => p.type === "text" && p.text?.trim());
			return text.length ? [{ ...m, content: text, stopReason: "stop" }] : [];
		}
		if (m.role === "toolResult" && m.toolCallId && foreign.has(m.toolCallId)) {
			const call = calls.get(m.toolCallId);
			const body = textOf(m.content);
			const args = JSON.stringify(call?.arguments ?? {}).slice(0, 600);
			return [
				{
					role: "user",
					content: [{ type: "text", text: `<context>Earlier in this conversation the tool ${m.toolName} ran with ${args}${m.isError ? " and failed" : ""}. Its result:\n${body.slice(0, MAX_RESULT)}${body.length > MAX_RESULT ? "\n…" : ""}</context>` }],
					timestamp: m.timestamp,
				},
			];
		}
		return [m];
	});
	return changed ? (out as unknown as T[]) : messages;
}
