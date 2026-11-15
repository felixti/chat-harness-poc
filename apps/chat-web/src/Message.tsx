import { useState } from "react";
import { Brain, Check, ChevronRight, Copy, Download, Eye, FileSpreadsheet, FileText, Image as ImageIcon, Pencil, Presentation, RefreshCw, ThumbsDown, ThumbsUp, LayoutDashboard } from "lucide-react";
import { fileUrl, type FileInfo, type Message, type ToolStep } from "./api";
import { Markdown, copyText } from "./Markdown";
import { toolLabel } from "./toolLabels";

export function Steps({ steps, running }: { steps: ToolStep[]; running: boolean }) {
	const [open, setOpen] = useState(false);
	if (!steps.length) return null;
	const current = steps[steps.length - 1];
	const errors = steps.filter((s) => s.isError).length;
	const label = running
		? toolLabel(current.name, current.args)
		: `${steps.length === 1 ? "1 etapa" : `${steps.length} etapas`}${errors ? ` · ${errors} com erro` : ""} · ${[...new Set(steps.map((s) => toolLabel(s.name, s.args).split(":")[0]))].slice(0, 3).join(", ")}`;
	return (
		<div className="steps">
			<button type="button" className="steps-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<ChevronRight size={14} className="chev" />
				<span className={`label${running ? " running-label" : ""}`}>{label}</span>
			</button>
			{open && (
				<ol className="steps-list">
					{steps.map((s, i) => (
						<li key={s.id || i}>
							<span className={s.isError ? "err" : undefined}>
								{toolLabel(s.name, s.args)}
								{s.isError ? " · falhou" : ""}
							</span>
							<span className="tech">
								{s.name} {JSON.stringify(s.args ?? {}).slice(0, 220)}
							</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

const ICONS: Record<string, typeof FileText> = { pptx: Presentation, xlsx: FileSpreadsheet, csv: FileSpreadsheet, html: LayoutDashboard, png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, webp: ImageIcon };
const KINDS: Record<string, string> = { pptx: "Apresentação", docx: "Documento Word", xlsx: "Planilha", csv: "CSV", pdf: "PDF", html: "Página HTML", png: "Imagem", jpg: "Imagem", jpeg: "Imagem", md: "Texto" };
export const sizeLabel = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function FileCard({ conv, file, onPreview }: { conv: string; file: FileInfo; onPreview?: (f: FileInfo) => void }) {
	const name = file.path.split("/").pop() ?? file.path;
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	const Icon = ICONS[ext] ?? FileText;
	const image = ["png", "jpg", "jpeg", "webp"].includes(ext);
	const previewable = image || ext === "html";
	return (
		<div className="file-card">
			<div className="ico">{image ? <img src={fileUrl(conv, file.path, true)} alt="" /> : <Icon size={18} />}</div>
			<div className="meta">
				<span className="name" title={name}>
					{name}
				</span>
				<span className="sub">
					{KINDS[ext] ?? ext.toUpperCase()} · {sizeLabel(file.size)}
				</span>
			</div>
			<div className="acts">
				{previewable && onPreview && (
					<button type="button" className="icon-btn small" aria-label={`Visualizar ${name}`} title="Visualizar" onClick={() => onPreview(file)}>
						<Eye size={16} />
					</button>
				)}
				<a className="icon-btn small" href={fileUrl(conv, file.path)} aria-label={`Baixar ${name}`} title="Baixar">
					<Download size={16} />
				</a>
			</div>
		</div>
	);
}

function Action({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
	return (
		<button type="button" className={`icon-btn small${pressed ? " on" : ""}`} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
			{children}
		</button>
	);
}

function CopyMsg({ text }: { text: string }) {
	const [ok, setOk] = useState(false);
	return (
		<Action
			label={ok ? "Copiado" : "Copiar"}
			onClick={async () => {
				await copyText(text);
				setOk(true);
				setTimeout(() => setOk(false), 1400);
			}}
		>
			{ok ? <Check size={16} /> : <Copy size={16} />}
		</Action>
	);
}

export function UserMessage({ m, canEdit, onEdit }: { m: Extract<Message, { role: "user" }>; canEdit: boolean; onEdit: (text: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(m.text);
	if (editing)
		return (
			<div className="msg user">
				<div className="edit-box">
					<textarea
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setEditing(false);
							if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
								e.preventDefault();
								setEditing(false);
								onEdit(draft.trim());
							}
						}}
						aria-label="Editar mensagem"
					/>
					<div className="row">
						<button type="button" className="btn" onClick={() => setEditing(false)}>
							Cancelar
						</button>
						<button
							type="button"
							className="btn primary"
							disabled={!draft.trim()}
							onClick={() => {
								setEditing(false);
								onEdit(draft.trim());
							}}
						>
							Enviar
						</button>
					</div>
				</div>
			</div>
		);
	return (
		<div className="msg user">
			<div className="bubble">{m.text}</div>
			<div className="msg-actions">
				<CopyMsg text={m.text} />
				{canEdit && (
					<Action
						label="Editar"
						onClick={() => {
							setDraft(m.text);
							setEditing(true);
						}}
					>
						<Pencil size={16} />
					</Action>
				)}
			</div>
		</div>
	);
}

export function AssistantMessage({
	m,
	conv,
	last,
	busy,
	vote,
	onVote,
	onRegenerate,
	onPreview,
}: {
	m: Extract<Message, { role: "assistant" }>;
	conv?: string;
	last: boolean;
	busy: boolean;
	vote?: "up" | "down";
	onVote: (v: "up" | "down" | null) => void;
	onRegenerate: () => void;
	onPreview: (f: FileInfo) => void;
}) {
	const [memOpen, setMemOpen] = useState(false);
	const steps = m.parts.filter((p): p is ToolStep => p.type === "tool");
	const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n");
	const running = !!m.streaming && !text;
	const files = (m.newFiles ?? []).filter((f) => !f.path.endsWith(".preview.png"));
	const thumbs = (m.newFiles ?? []).filter((f) => f.path.endsWith(".preview.png"));
	const used = m.memory ? m.memory.core + m.memory.facts.length + m.memory.conversations.length : 0;
	return (
		<div className={`msg assistant${last ? " last" : ""}`}>
			<Steps steps={steps} running={running} />
			{text ? <Markdown text={text} conv={conv} final={!m.streaming} /> : null}
			{m.streaming && text && <span className="caret" aria-hidden="true" />}
			{m.error && <div className="notice error">{m.error}</div>}
			{conv && thumbs.map((t) => (
				<div className="deck-thumb" key={t.path}>
					<img src={fileUrl(conv, t.path, true)} alt="Miniaturas dos slides" />
				</div>
			))}
			{conv && files.length > 0 && (
				<div className="files-row">
					{files.map((f) => (
						<FileCard key={f.path} conv={conv} file={f} onPreview={onPreview} />
					))}
				</div>
			)}
			{m.saved && m.saved.length > 0 && (
				<div className="saved-line">
					<Brain size={13} /> Guardei na memória: {m.saved.join(" · ")}
				</div>
			)}
			{!m.streaming && (
				<div className="msg-actions">
					{text && <CopyMsg text={text} />}
					{last && (
						<Action label="Gerar de novo" onClick={onRegenerate}>
							<RefreshCw size={16} />
						</Action>
					)}
					{conv && (
						<>
							<Action label="Resposta boa" pressed={vote === "up"} onClick={() => onVote(vote === "up" ? null : "up")}>
								<ThumbsUp size={16} />
							</Action>
							<Action label="Resposta ruim" pressed={vote === "down"} onClick={() => onVote(vote === "down" ? null : "down")}>
								<ThumbsDown size={16} />
							</Action>
						</>
					)}
					{used > 0 && (
						<button type="button" className="chip memory" onClick={() => setMemOpen((v) => !v)} aria-expanded={memOpen} disabled={busy && last}>
							<Brain size={13} />
							<span>Memória usada ({used})</span>
						</button>
					)}
				</div>
			)}
			{memOpen && m.memory && (
				<div className="mem-pop">
					{m.memory.core > 0 && <div>Seu perfil e notas ({m.memory.core} itens), sempre considerados.</div>}
					{m.memory.facts.length > 0 && (
						<>
							<h4>Fatos usados</h4>
							<ul>
								{m.memory.facts.map((f) => (
									<li key={f}>{f}</li>
								))}
							</ul>
						</>
					)}
					{m.memory.conversations.length > 0 && (
						<>
							<h4>Conversas recentes</h4>
							<ul>
								{m.memory.conversations.map((c) => (
									<li key={c}>{c}</li>
								))}
							</ul>
						</>
					)}
					<div className="muted" style={{ marginTop: 6 }}>
						Para editar ou esquecer, abra Memória na barra lateral.
					</div>
				</div>
			)}
		</div>
	);
}
