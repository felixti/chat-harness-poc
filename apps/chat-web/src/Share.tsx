// Share links (H72): the owner's dialog (create, copy, revoke) and the read-only page a link opens.
import { useEffect, useRef, useState } from "react";
import { AppWindow, Copy, Download, Link2, Lock, Trash2, X } from "lucide-react";
import { api, shareFileUrl, shareLink, type ShareSummary, type ShareView as View } from "./api";
import { copyText } from "./Markdown";
import { AssistantMessage, UserMessage } from "./Message";
import { buildCanvasPage } from "./canvasPage";
import { useTheme } from "./theme";

const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
const DAYS = [7, 30, 90];
const noop = () => {};

/** "Compartilhar": a frozen copy of the conversation, or of one canvas when `canvas` is set. */
export function ShareDialog({ conv, canvas, canvasTitle, onClose, notify }: { conv: string; canvas?: string; canvasTitle?: string; onClose: () => void; notify: (t: string) => void }) {
	const dlg = useRef<HTMLDialogElement>(null);
	const [list, setList] = useState<ShareSummary[]>();
	const [days, setDays] = useState(30);
	const [busy, setBusy] = useState(false);
	const [fresh, setFresh] = useState<string>();
	useEffect(() => {
		dlg.current?.showModal();
		api
			.sharesOf(conv)
			.then((l) => setList(l.filter((s) => (canvas ? s.canvas === canvas : s.kind === "conversation"))))
			.catch(() => setList([]));
	}, [conv, canvas]);

	async function create() {
		setBusy(true);
		try {
			const s = await api.createShare(conv, { canvas, days });
			setList((l) => [s, ...(l ?? [])]);
			setFresh(s.id);
			await copyText(shareLink(s.id)).then(() => notify("Link copiado."), noop);
		} catch (e) {
			notify(`Não consegui criar o link: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	}
	async function revoke(id: string) {
		if (!confirm("Revogar este link? Quem tiver o link não consegue mais abrir.")) return;
		await api.revokeShare(id).then(() => setList((l) => l?.filter((s) => s.id !== id)), (e) => notify(`Não consegui revogar: ${(e as Error).message}`));
	}

	return (
		<dialog className="sheet share-dlg" ref={dlg} onClose={onClose} aria-label="Compartilhar">
			<header>
				<strong>{canvas ? `Compartilhar canvas “${canvasTitle ?? canvas}”` : "Compartilhar conversa"}</strong>
				<button type="button" className="icon-btn" aria-label="Fechar" onClick={() => dlg.current?.close()}>
					<X size={18} />
				</button>
			</header>
			<div className="share-body">
				<p className="share-note">
					<Lock size={14} aria-hidden="true" /> Só quem entra com a conta da empresa abre o link. Ele mostra uma cópia de agora, sem as próximas mensagens; {canvas ? "o estado atual do canvas vai junto." : "os arquivos gerados vão junto, os anexos não."}
				</p>
				<div className="share-new">
					<label>
						Expira em
						<select value={days} onChange={(e) => setDays(Number(e.target.value))}>
							{DAYS.map((d) => (
								<option key={d} value={d}>
									{d} dias
								</option>
							))}
						</select>
					</label>
					<button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>
						<Link2 size={15} style={{ verticalAlign: -3 }} /> {busy ? "Criando…" : "Criar link"}
					</button>
				</div>
				{list && list.length > 0 && (
					<ul className="share-list">
						{list.map((s) => (
							<li key={s.id} className={s.id === fresh ? "fresh" : ""}>
								<div className="t">
									<code>{shareLink(s.id).replace(/^https?:\/\//, "")}</code>
									<span className="hint">
										Criado em {day(s.createdAt)} · {s.expired ? "expirado" : `expira em ${day(s.expiresAt)}`}
									</span>
								</div>
								<button type="button" className="icon-btn small" aria-label="Copiar link" title="Copiar link" onClick={() => void copyText(shareLink(s.id)).then(() => notify("Link copiado."))}>
									<Copy size={15} />
								</button>
								<button type="button" className="icon-btn small danger" aria-label="Revogar link" title="Revogar" onClick={() => void revoke(s.id)}>
									<Trash2 size={15} />
								</button>
							</li>
						))}
					</ul>
				)}
				{list && !list.length && <p className="hint">Nenhum link ainda.</p>}
			</div>
		</dialog>
	);
}

/** The page a link opens (#s/<id>): read-only, no composer, no feedback. */
export function SharedPage({ id, onClose }: { id: string; onClose: () => void }) {
	const [v, setV] = useState<View>();
	const [error, setError] = useState<string>();
	const [page, setPage] = useState<string>();
	const theme = useTheme();
	useEffect(() => {
		setV(undefined);
		setError(undefined);
		api.share(id).then(setV, (e) => setError((e as { status?: number }).status === 404 ? "Este link não existe, expirou ou foi revogado." : `Não consegui abrir o link: ${(e as Error).message}`));
	}, [id]);
	useEffect(() => {
		if (!v?.canvas) return;
		let gone = false;
		// A shared canvas runs like in the panel (sandboxed, no network); its state changes are not saved.
		void buildCanvasPage(v.canvas.html, { theme, state: v.canvas.state, token: crypto.randomUUID(), title: v.canvas.title }).then((h) => !gone && setPage(h));
		return () => {
			gone = true;
		};
	}, [v, theme]);

	if (error)
		return (
			<div className="welcome">
				<div className="notice error" role="alert">
					<span style={{ flex: 1 }}>{error}</span>
					<button type="button" className="btn small" onClick={onClose}>
						Voltar
					</button>
				</div>
			</div>
		);
	if (!v) return <div className="welcome running-label">Abrindo o link…</div>;
	const banner = (
		<div className="share-banner" role="note">
			<Link2 size={15} aria-hidden="true" />
			<span>
				Cópia somente leitura de {day(v.createdAt)}
				{v.mine ? " · você criou este link" : ""} · expira em {day(v.expiresAt)}
			</span>
		</div>
	);
	if (v.kind === "canvas" && v.canvas)
		return (
			<div className="shared canvas-shared">
				{banner}
				<h1 className="shared-title">
					<AppWindow size={18} aria-hidden="true" /> {v.canvas.title}
				</h1>
				<div className="canvas-body">{page ? <iframe title={v.canvas.title} sandbox="allow-scripts" srcDoc={page} /> : <div className="canvas-loading running-label">Montando o canvas…</div>}</div>
			</div>
		);
	return (
		<div className="scroller shared">
			<div className="column">
				{banner}
				<h1 className="shared-title">{v.title}</h1>
				{(v.messages ?? []).map((m) =>
					m.role === "user" ? (
						<UserMessage key={m.id} m={m} canEdit={false} onEdit={noop} />
					) : (
						<AssistantMessage key={m.id} m={m} last={false} busy={false} onVote={noop} onRegenerate={noop} onPreview={noop} />
					),
				)}
				{v.files && v.files.length > 0 && (
					<section className="shared-files" aria-label="Arquivos gerados">
						<h2>Arquivos gerados</h2>
						<ul>
							{v.files.map((f) => (
								<li key={f.path}>
									<a href={shareFileUrl(v.id, f.path)}>
										<Download size={15} aria-hidden="true" /> {f.path.replace(/^outputs\//, "")}
									</a>
								</li>
							))}
						</ul>
						{!!v.skipped && <p className="hint">{v.skipped} arquivo(s) grande(s) ficaram de fora do link.</p>}
					</section>
				)}
			</div>
		</div>
	);
}
