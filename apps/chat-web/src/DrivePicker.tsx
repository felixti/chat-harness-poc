// OneDrive / SharePoint picker: browse server-side through chat-api (the Microsoft token never
// reaches the browser), select up to 10 supported files, import them into the conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, Search, X } from "lucide-react";
import { api, HttpError, type DriveEntry } from "./api";
import { sizeLabel } from "./Message";

type Tab = "recent" | "mine" | "shared";
const TABS: [Tab, string][] = [
	["recent", "Recentes"],
	["mine", "Meus arquivos"],
	["shared", "Compartilhados comigo"],
];

export function DrivePicker({ open, onClose, onImport, conv }: { open: boolean; onClose: () => void; onImport: (items: DriveEntry[]) => Promise<void>; conv?: string }) {
	const dlg = useRef<HTMLDialogElement>(null);
	const [tab, setTab] = useState<Tab>("recent");
	const [path, setPath] = useState<DriveEntry[]>([]);
	const [q, setQ] = useState("");
	const [items, setItems] = useState<DriveEntry[]>();
	const [state, setState] = useState<"loading" | "ready" | "connect" | "error">("loading");
	const [error, setError] = useState("");
	const [picked, setPicked] = useState<Map<string, DriveEntry>>(new Map());
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) dlg.current?.showModal();
		else dlg.current?.close();
	}, [open]);

	const load = useCallback(async () => {
		setState("loading");
		setItems(undefined);
		try {
			const folder = path[path.length - 1];
			const view = q.trim() ? "search" : folder ? "folder" : tab;
			setItems(await api.drive(view, folder && !q.trim() ? { driveId: folder.driveId, id: folder.id } : { q: q.trim() }));
			setState("ready");
		} catch (e) {
			if (e instanceof HttpError && (e.status === 412 || e.status === 401)) setState("connect");
			else {
				setError((e as Error).message);
				setState("error");
			}
		}
	}, [tab, path, q]);

	useEffect(() => {
		if (!open) return;
		const t = setTimeout(load, q ? 350 : 0);
		return () => clearTimeout(t);
	}, [open, load, q]);

	const toggle = (it: DriveEntry) =>
		setPicked((m) => {
			const n = new Map(m);
			if (n.has(it.id)) n.delete(it.id);
			else if (n.size < 10) n.set(it.id, it);
			return n;
		});

	const connect = () => {
		try {
			sessionStorage.setItem("assistente.afterConnect", JSON.stringify({ conv, picker: true }));
		} catch {
			/* storage blocked: the user reopens the picker by hand */
		}
		location.href = "api/connectors/microsoft/connect";
	};

	return (
		<dialog className="sheet picker" ref={dlg} onClose={onClose} aria-label="Anexar do OneDrive ou SharePoint">
			<header>
				<strong>OneDrive e SharePoint</strong>
				<button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
					<X size={18} />
				</button>
			</header>
			<div className="picker-body">
				{state === "connect" ? (
					<div className="picker-empty">
						<p>Conecte sua conta Microsoft para escolher arquivos do OneDrive ou do SharePoint. O acesso é somente leitura e você pode desconectar em Conectores.</p>
						<button type="button" className="btn primary" onClick={connect}>
							Conectar Microsoft
						</button>
					</div>
				) : (
					<>
						<div className="picker-bar">
							<div className="tabs" role="tablist">
								{TABS.map(([id, label]) => (
									<button
										key={id}
										type="button"
										role="tab"
										className="tab"
										aria-selected={tab === id && !path.length && !q}
										onClick={() => {
											setTab(id);
											setPath([]);
											setQ("");
										}}
									>
										{label}
									</button>
								))}
							</div>
							<div className="picker-search">
								<Search size={15} />
								<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar no OneDrive" aria-label="Buscar no OneDrive" />
							</div>
						</div>
						{path.length > 0 && !q && (
							<nav className="crumbs" aria-label="Pasta atual">
								<button type="button" onClick={() => setPath([])}>
									{TABS.find(([id]) => id === tab)?.[1]}
								</button>
								{path.map((p, i) => (
									<span key={p.id}>
										<ChevronRight size={13} />
										<button type="button" onClick={() => setPath(path.slice(0, i + 1))}>
											{p.name}
										</button>
									</span>
								))}
							</nav>
						)}
						<ul className="picker-list" aria-busy={state === "loading"}>
							{state === "loading" && Array.from({ length: 6 }, (_, i) => <li key={i} className="skeleton" />)}
							{state === "error" && <li className="picker-msg">Não consegui listar: {error}</li>}
							{state === "ready" && !items?.length && <li className="picker-msg">{q ? `Nada encontrado para “${q}”.` : "Pasta vazia."}</li>}
							{state === "ready" &&
								items?.map((it) => (
									<li key={it.id}>
										{it.folder ? (
											<button type="button" className="picker-row" onClick={() => setPath([...path, it])}>
												<Folder size={17} />
												<span className="nm">{it.name}</span>
												<ChevronRight size={15} className="muted" />
											</button>
										) : (
											<label className={`picker-row${it.supported ? "" : " off"}`} title={it.supported ? undefined : "Tipo de arquivo não suportado"}>
												<input type="checkbox" disabled={!it.supported} checked={picked.has(it.id)} onChange={() => toggle(it)} />
												<FileText size={17} />
												<span className="nm">{it.name}</span>
												<span className="sub">
													{it.modified?.slice(0, 10)} · {sizeLabel(it.size)}
												</span>
											</label>
										)}
									</li>
								))}
						</ul>
					</>
				)}
			</div>
			{state !== "connect" && (
				<footer className="picker-foot">
					<span className="muted">{picked.size ? `${picked.size} selecionado${picked.size > 1 ? "s" : ""}` : "PDF, Word, Excel, PowerPoint, CSV e imagens. Até 10 por vez."}</span>
					<button type="button" className="btn" onClick={onClose}>
						Cancelar
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={!picked.size || busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onImport([...picked.values()]);
								setPicked(new Map());
								onClose();
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? "Anexando…" : "Anexar"}
					</button>
				</footer>
			)}
		</dialog>
	);
}
