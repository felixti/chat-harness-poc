// Scheduled tasks (H69) and background runs with their own cost (H68): the "Tarefas" page and the
// run card above the composer of a conversation with a run going (a task or a deep research).
import { useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, ChevronDown, ChevronRight, MessageSquare, Pause, Play, Plus, Square, Telescope, Trash2, X } from "lucide-react";
import { api, type Job, type Schedule, type ScheduleInput, type When } from "./api";
import { fmtBrl } from "./cost";
import { toolLabel } from "./toolLabels";

const dt = (iso?: string) =>
	iso
		? new Date(iso).toLocaleString("pt-BR", {
				day: "2-digit",
				month: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			})
		: "";
const active = (j: Job) => j.status === "queued" || j.status === "running";
const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

/** The step a run is on, in plain words. */
export function stepText(j: Job): string {
	if (j.status === "queued") return +new Date(j.runAt) > Date.now() + 5000 ? `Na fila (conversa ocupada) · tenta às ${dt(j.runAt).slice(-5)}` : "Na fila";
	const p = j.progress ?? "";
	const reading = /^reading (\d+)\/(\d+): (.*)$/.exec(p);
	if (reading) return `Lendo fontes ${reading[1]}/${reading[2]}: ${reading[3]}`;
	if (p === "writing") return j.kind === "research" ? "Escrevendo o relatório" : "Escrevendo a resposta";
	if (p === "checking") return "Conferindo cada afirmação nas fontes";
	if (p === "delivering") return "Publicando o relatório na conversa";
	if (!p || p === "starting") return "Começando";
	return toolLabel(p, {});
}

/** Final state, in plain words. */
export function endText(j: Job): string {
	if (j.status === "done") return j.waiting ? "Concluída · aguardando sua aprovação" : "Concluída";
	if (j.status === "stopped") return j.stopReason === "budget" ? "Parada pelo orçamento" : "Parada por você";
	if (j.status === "failed") return j.stopReason === "attempts" ? "Falhou (3 tentativas)" : "Falhou";
	return stepText(j);
}

function CostBar({ j }: { j: Job }) {
	const pct = Math.min(100, j.capBrl > 0 ? (j.costBrl / j.capBrl) * 100 : 0);
	return (
		<div className="run-cost" title={`Custo desta execução até agora, pelo id ${j.id}. Teto: ${fmtBrl(j.capBrl)}; ao chegar nele a execução para.`}>
			<span>
				<strong>{fmtBrl(j.costBrl)}</strong> de {fmtBrl(j.capBrl)}
			</span>
			<span className="bar" aria-hidden="true">
				<span style={{ width: `${pct}%` }} />
			</span>
		</div>
	);
}

/** Above the composer: the run going in this conversation (live step and cost), or the one that just ended. */
export function RunCard({ conv, busy, onFinished, notify }: { conv: string; busy: boolean; onFinished: () => void; notify: (t: string) => void }) {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [hidden, setHidden] = useState<string>();
	const live = useRef(false);
	const finished = useRef(onFinished);
	finished.current = onFinished;
	const load = useCallback(async () => {
		const l = await api.jobs({ conversation: conv }).catch(() => undefined);
		if (!l) return;
		const wasLive = live.current;
		live.current = l.some(active);
		setJobs(l);
		// The run posted in this conversation: reload it to show the answer.
		if (wasLive && !live.current) finished.current();
	}, [conv]);
	useEffect(() => {
		setJobs([]);
		setHidden(undefined);
		live.current = false;
		void load();
	}, [conv, load]);
	// A turn that just ended may have started a run (start_research, "executar agora").
	useEffect(() => {
		if (!busy) void load();
	}, [busy, load]);
	useEffect(() => {
		if (!jobs.some(active)) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	}, [jobs, load]);

	const j = jobs.find(active) ?? jobs[0];
	if (!j || j.id === hidden) return null;
	// A finished run stays as a one-line receipt only when it ended in the last hour.
	if (!active(j) && Date.now() - +new Date(j.endedAt ?? j.createdAt) > 3_600_000) return null;
	const Icon = j.kind === "research" ? Telescope : AlarmClock;
	return (
		<div className={`run-card${active(j) ? " live" : ""}`} role="status" aria-live="polite">
			<Icon size={16} aria-hidden="true" />
			<div className="t">
				<strong>{j.kind === "research" ? "Pesquisa aprofundada" : "Tarefa agendada"}</strong>
				<span className="hint">{active(j) ? (j.stopping ? "Parando…" : stepText(j)) : `${endText(j)}${j.error && j.status === "failed" ? `: ${j.error.slice(0, 120)}` : ""}`}</span>
			</div>
			<CostBar j={j} />
			{active(j) ? (
				<button
					type="button"
					className="btn small"
					disabled={j.stopping}
					onClick={() =>
						void api.stopJob(j.id).then(
							() => load(),
							(e) => notify(`Não consegui parar: ${(e as Error).message}`),
						)
					}
				>
					<Square size={13} style={{ verticalAlign: -2 }} /> Parar
				</button>
			) : (
				<button type="button" className="icon-btn small" aria-label="Fechar" onClick={() => setHidden(j.id)}>
					<X size={15} />
				</button>
			)}
		</div>
	);
}

const emptyForm = (): ScheduleInput => ({
	title: "",
	prompt: "",
	when: { freq: "weekdays", time: "08:00" },
	capBrl: 1,
});

function WhenFields({ when, set }: { when: When; set: (w: When) => void }) {
	const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
	return (
		<div className="when">
			<label>
				Quando
				<select
					value={when.freq}
					onChange={(e) => {
						const freq = e.target.value as When["freq"];
						set({
							freq,
							time: when.time,
							...(freq === "weekly" ? { weekday: 1 } : freq === "monthly" ? { day: 1 } : freq === "once" ? { date: tomorrow } : {}),
						});
					}}
				>
					<option value="once">Uma vez</option>
					<option value="daily">Todo dia</option>
					<option value="weekdays">Dias úteis</option>
					<option value="weekly">Toda semana</option>
					<option value="monthly">Todo mês</option>
				</select>
			</label>
			{when.freq === "weekly" && (
				<label>
					Dia
					<select value={when.weekday} onChange={(e) => set({ ...when, weekday: Number(e.target.value) })}>
						{WEEKDAYS.map((d, i) => (
							<option key={d} value={i}>
								{d}
							</option>
						))}
					</select>
				</label>
			)}
			{when.freq === "monthly" && (
				<label>
					Dia do mês
					<input type="number" min={1} max={28} value={when.day} onChange={(e) => set({ ...when, day: Number(e.target.value) })} />
				</label>
			)}
			{when.freq === "once" && (
				<label>
					Data
					<input type="date" min={new Date().toISOString().slice(0, 10)} value={when.date} onChange={(e) => set({ ...when, date: e.target.value })} />
				</label>
			)}
			<label>
				Hora
				<input type="time" value={when.time} onChange={(e) => set({ ...when, time: e.target.value })} />
			</label>
		</div>
	);
}

function History({ s, onOpen }: { s: Schedule; onOpen: () => void }) {
	const [runs, setRuns] = useState<Job[]>();
	useEffect(() => {
		void api.jobs({ schedule: s.id }).then(setRuns, () => setRuns([]));
	}, [s.id, s.lastJob]);
	if (!runs) return <p className="hint">Carregando…</p>;
	if (!runs.length) return <p className="hint">Nenhuma execução ainda.</p>;
	const total = runs.reduce((t, r) => t + r.costBrl, 0);
	return (
		<div className="runs">
			<table>
				<thead>
					<tr>
						<th>Execução</th>
						<th>Resultado</th>
						<th className="num">Custo</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((r) => (
						<tr key={r.id} title={`run id ${r.id}`}>
							<td>{dt(r.startedAt ?? r.createdAt)}</td>
							<td>{active(r) ? stepText(r) : endText(r)}</td>
							<td className="num">{fmtBrl(r.costBrl)}</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr>
						<td colSpan={2}>
							{runs.length} {runs.length === 1 ? "execução" : "execuções"}
						</td>
						<td className="num">{fmtBrl(total)}</td>
					</tr>
				</tfoot>
			</table>
			{/* The conversation exists once a run has posted in it. */}
			{runs.some((r) => !active(r)) && (
				<button type="button" className="btn small" onClick={onOpen}>
					<MessageSquare size={14} style={{ verticalAlign: -2 }} /> Abrir a conversa da tarefa
				</button>
			)}
		</div>
	);
}

/** The "Tarefas" page: what runs when, the last run's result and cost, and the history. */
export function TasksView({ projectId, onOpen, notify }: { projectId?: string; onOpen: (conv: string) => void; notify: (t: string) => void }) {
	const [list, setList] = useState<Schedule[]>();
	const [form, setForm] = useState<ScheduleInput>();
	const [saving, setSaving] = useState(false);
	const [open, setOpen] = useState<string>();
	const load = useCallback(() => api.schedules().then(setList, () => setList([])), []);
	useEffect(() => {
		void load();
	}, [load]);
	// While a run goes, refresh its line every few seconds.
	useEffect(() => {
		if (!list?.some((s) => s.last && active(s.last))) return;
		const t = setInterval(() => void load(), 4000);
		return () => clearInterval(t);
	}, [list, load]);

	async function create() {
		if (!form) return;
		setSaving(true);
		try {
			await api.createSchedule({ ...form, projectId });
			setForm(undefined);
			await load();
			notify("Tarefa agendada.");
		} catch (e) {
			notify(`Não consegui agendar: ${(e as Error).message}`);
		} finally {
			setSaving(false);
		}
	}
	const act = (p: Promise<unknown>, done: string) =>
		void p.then(
			() => (notify(done), load()),
			(e) => notify(`Não consegui: ${(e as Error).message}`),
		);

	return (
		<div className="tasks-page">
			<div className="tasks-inner">
				<header className="tasks-head">
					<h1>
						<AlarmClock size={20} aria-hidden="true" /> Tarefas
					</h1>
					{!form && (
						<button type="button" className="btn primary" onClick={() => setForm(emptyForm())}>
							<Plus size={15} style={{ verticalAlign: -3 }} /> Nova tarefa
						</button>
					)}
				</header>
				<p className="hint">
					O assistente executa o pedido no horário marcado (horário de Brasília), com as mesmas ferramentas do chat, e publica a resposta na conversa da tarefa. Cada execução mostra quanto custou e
					para no teto. Você também pode pedir no chat: “todo dia às 8h, me traga…”.
				</p>
				{form && (
					<form
						className="task-form"
						onSubmit={(e) => {
							e.preventDefault();
							void create();
						}}
					>
						<label>
							Nome
							<input required maxLength={80} value={form.title} placeholder="Resumo das notícias de IA" onChange={(e) => setForm({ ...form, title: e.target.value })} />
						</label>
						<label>
							O que fazer
							<textarea
								required
								rows={4}
								maxLength={4000}
								value={form.prompt}
								placeholder="Pesquise as 5 notícias mais relevantes de IA das últimas 24 horas e resuma cada uma em 2 linhas, com o link."
								onChange={(e) => setForm({ ...form, prompt: e.target.value })}
							/>
						</label>
						<WhenFields when={form.when} set={(when) => setForm({ ...form, when })} />
						<label className="cap">
							Teto por execução (R$)
							<input type="number" min={0.1} max={20} step={0.1} value={form.capBrl} onChange={(e) => setForm({ ...form, capBrl: Number(e.target.value) })} />
						</label>
						<div className="actions">
							<button type="button" className="btn" onClick={() => setForm(undefined)}>
								Cancelar
							</button>
							<button type="submit" className="btn primary" disabled={saving}>
								{saving ? "Agendando…" : "Agendar"}
							</button>
						</div>
					</form>
				)}
				{list && !list.length && !form && <p className="empty">Nenhuma tarefa ainda.</p>}
				<ul className="task-list">
					{list?.map((s) => (
						<li key={s.id} className={s.active ? "" : "paused"}>
							<div className="row">
								<button type="button" className="expand" aria-expanded={open === s.id} onClick={() => setOpen((o) => (o === s.id ? undefined : s.id))}>
									{open === s.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
									<span className="t">
										<strong>{s.title}</strong>
										<span className="hint">
											{s.whenText}
											{s.active && s.nextRunAt ? ` · próxima ${dt(s.nextRunAt)}` : s.active ? "" : " · pausada"}
										</span>
									</span>
								</button>
								<span className="last" title={s.last ? `run id ${s.last.id}` : undefined}>
									{s.last ? (
										<>
											<span className={`dot ${s.last.status}`} aria-hidden="true" />
											{active(s.last) ? stepText(s.last) : `${endText(s.last)} · ${fmtBrl(s.last.costBrl)}`}
										</>
									) : (
										<span className="hint">Teto {fmtBrl(s.capBrl)}</span>
									)}
								</span>
								<button
									type="button"
									className="icon-btn small"
									title="Executar agora"
									aria-label="Executar agora"
									disabled={!!s.last && active(s.last)}
									onClick={() => act(api.runSchedule(s.id), "Execução na fila: começa em alguns segundos.")}
								>
									<Play size={15} />
								</button>
								{s.when.freq !== "once" || s.active ? (
									<button
										type="button"
										className="icon-btn small"
										title={s.active ? "Pausar" : "Retomar"}
										aria-label={s.active ? "Pausar" : "Retomar"}
										onClick={() => act(api.updateSchedule(s.id, { active: !s.active }), s.active ? "Tarefa pausada." : "Tarefa retomada.")}
									>
										{s.active ? <Pause size={15} /> : <AlarmClock size={15} />}
									</button>
								) : null}
								<button
									type="button"
									className="icon-btn small danger"
									title="Excluir"
									aria-label="Excluir tarefa"
									onClick={() => confirm(`Excluir a tarefa “${s.title}”? A conversa e o histórico de custos ficam.`) && act(api.deleteSchedule(s.id), "Tarefa excluída.")}
								>
									<Trash2 size={15} />
								</button>
							</div>
							{open === s.id && (
								<div className="detail">
									<p className="prompt">{s.prompt}</p>
									<History s={s} onOpen={() => onOpen(s.conversation)} />
								</div>
							)}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
