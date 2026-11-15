// AG-UI (https://github.com/ag-ui-protocol/ag-ui, MIT) on the wire: the portal and any future
// client (Teams bot, CopilotKit, another front) speak the same event protocol. Human-in-the-loop
// uses AG-UI interrupts: the run ends with RUN_FINISHED { outcome: interrupt }, the state is saved
// with the conversation, and the next request resumes it on any replica (stateless).
import { randomUUID } from "node:crypto";

export type AguiEvent = { type: string; timestamp?: number; [k: string]: unknown };

export interface Interrupt {
	id: string;
	reason: "tool_call" | "input_required";
	message: string;
	toolCallId?: string;
	responseSchema?: Record<string, unknown>;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
}

export interface ResumeEntry {
	interruptId: string;
	status: "resolved" | "cancelled";
	payload?: unknown;
}

/** One run's event stream. Text and tool-call frames are opened and closed for the caller. */
export class AguiRun {
	readonly threadId: string;
	readonly runId: string;
	private readonly emit: (e: AguiEvent) => void;
	private textId?: string;
	constructor(emit: (e: AguiEvent) => void, threadId: string, runId: string = randomUUID()) {
		this.emit = (e) => emit({ ...e, timestamp: Date.now() });
		this.threadId = threadId;
		this.runId = runId;
	}
	started() {
		this.emit({ type: "RUN_STARTED", threadId: this.threadId, runId: this.runId });
	}
	text(delta: string) {
		if (!this.textId) {
			this.textId = randomUUID();
			this.emit({ type: "TEXT_MESSAGE_START", messageId: this.textId, role: "assistant" });
		}
		this.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: this.textId, delta });
	}
	private closeText() {
		if (this.textId) this.emit({ type: "TEXT_MESSAGE_END", messageId: this.textId });
		this.textId = undefined;
	}
	toolStart(toolCallId: string, name: string, args: unknown) {
		this.closeText();
		this.emit({ type: "TOOL_CALL_START", toolCallId, toolCallName: name });
		this.emit({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args ?? {}) });
		this.emit({ type: "TOOL_CALL_END", toolCallId });
	}
	toolResult(toolCallId: string, content: string, isError: boolean) {
		this.emit({ type: "TOOL_CALL_RESULT", messageId: randomUUID(), toolCallId, role: "tool", content: content.slice(0, 2000), metadata: { isError } });
	}
	custom(name: string, value: unknown) {
		this.emit({ type: "CUSTOM", name, value });
	}
	finished(interrupts: Interrupt[] = []) {
		this.closeText();
		this.emit({
			type: "RUN_FINISHED",
			threadId: this.threadId,
			runId: this.runId,
			outcome: interrupts.length ? { type: "interrupt", interrupts } : { type: "success" },
		});
	}
	error(message: string, code?: string) {
		this.closeText();
		this.emit({ type: "RUN_ERROR", message, ...(code ? { code } : {}) });
	}
}

/** Text of a tool result for TOOL_CALL_RESULT (Pi results are { content: [{ type, text }] }). */
export function resultText(result: unknown): string {
	const c = (result as { content?: { type?: string; text?: string }[] })?.content;
	if (Array.isArray(c)) return c.filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n");
	return typeof result === "string" ? result : "";
}
