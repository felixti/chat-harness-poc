// AG-UI interrupts as cards: an approval for a write action, or the clarify questions.
import { useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import type { Interrupt, ResumeEntry } from "./api";

export type Respond = (interrupt: Interrupt, entry: Omit<ResumeEntry, "interruptId">, display: string) => void;

function ApprovalCard({ it, onRespond, disabled }: { it: Interrupt; onRespond: Respond; disabled: boolean }) {
	const [details, setDetails] = useState(false);
	return (
		<div className="int-card" role="group" aria-label="Aprovação necessária">
			<div className="int-head">
				<ShieldCheck size={17} />
				<span>Precisa da sua aprovação</span>
			</div>
			<p className="int-msg">{it.message}</p>
			<button type="button" className="int-details" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
				<ChevronRight size={14} className="chev" /> Detalhes técnicos
			</button>
			{details && (
				<pre className="int-json">
					{it.metadata?.toolName}
					{"\n"}
					{JSON.stringify(it.metadata?.input ?? {}, null, 2)}
				</pre>
			)}
			<div className="int-actions">
				<button type="button" className="btn" disabled={disabled} onClick={() => onRespond(it, { status: "resolved", payload: { approved: false } }, `Recusado: ${it.message}`)}>
					Recusar
				</button>
				<button type="button" className="btn primary" disabled={disabled} onClick={() => onRespond(it, { status: "resolved", payload: { approved: true } }, `Aprovado: ${it.message}`)}>
					Aprovar
				</button>
			</div>
			<p className="int-note">Só esta ação, com estes dados, será executada.</p>
		</div>
	);
}

function QuestionsCard({ it, onRespond, disabled }: { it: Interrupt; onRespond: Respond; disabled: boolean }) {
	const qs = it.metadata?.questions ?? [];
	const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(qs.filter((q) => q.recommended).map((q) => [q.id, q.recommended!])));
	const [other, setOther] = useState<Record<string, string>>({});
	const value = (id: string) => (other[id]?.trim() ? other[id].trim() : answers[id]);
	const complete = qs.every((q) => value(q.id));
	const send = () => {
		const final = Object.fromEntries(qs.map((q) => [q.id, value(q.id) ?? ""]));
		onRespond(it, { status: "resolved", payload: { answers: final } }, qs.map((q) => `${q.question} ${final[q.id]}`).join("\n"));
	};
	return (
		<div className="int-card" role="group" aria-label="Perguntas">
			{qs.map((q) => (
				<fieldset key={q.id} className="int-q">
					<legend>{q.question}</legend>
					<div className="int-options" role="radiogroup">
						{q.options.map((o) => (
							<button
								key={o.label}
								type="button"
								role="radio"
								aria-checked={answers[q.id] === o.label && !other[q.id]?.trim()}
								className="int-opt"
								disabled={disabled}
								onClick={() => {
									setAnswers((a) => ({ ...a, [q.id]: o.label }));
									setOther((x) => ({ ...x, [q.id]: "" }));
								}}
							>
								<span className="lbl">
									{o.label}
									{q.recommended === o.label && <span className="rec">recomendado</span>}
								</span>
								{o.description && <span className="desc">{o.description}</span>}
							</button>
						))}
					</div>
					<input className="int-other" placeholder="Outra resposta" aria-label={`Outra resposta para: ${q.question}`} value={other[q.id] ?? ""} disabled={disabled} onChange={(e) => setOther((x) => ({ ...x, [q.id]: e.target.value }))} />
				</fieldset>
			))}
			<div className="int-actions">
				<button type="button" className="btn" disabled={disabled} onClick={() => onRespond(it, { status: "cancelled" }, "Pular perguntas")}>
					Pular
				</button>
				<button type="button" className="btn primary" disabled={disabled || !complete} onClick={send}>
					Enviar respostas
				</button>
			</div>
		</div>
	);
}

export function InterruptCards({ interrupts, onRespond, disabled }: { interrupts: Interrupt[]; onRespond: Respond; disabled: boolean }) {
	return (
		<div className="int-list">
			{interrupts.map((it) => (it.reason === "tool_call" ? <ApprovalCard key={it.id} it={it} onRespond={onRespond} disabled={disabled} /> : <QuestionsCard key={it.id} it={it} onRespond={onRespond} disabled={disabled} />))}
		</div>
	);
}
