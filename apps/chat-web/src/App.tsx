import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelLeft, SquarePen, X } from "lucide-react";
import { api, chat, fileUrl, HttpError, type ConversationSummary, type FileInfo, type LibraryFile, type Message, type ToolStep } from "./api";
import { AssistantMessage, UserMessage } from "./Message";
import { Composer, type Attachment } from "./Composer";
import { Sidebar, type DrawerTab } from "./Sidebar";
import { Drawer } from "./Drawer";
import { DrivePicker } from "./DrivePicker";

const STARTERS = [
	{ title: "Montar uma apresentação", hint: "Deck no padrão da empresa, com gráficos e fontes", text: "Crie uma apresentação de 8 slides para a diretoria sobre " },
	{ title: "Analisar uma planilha", hint: "Anexe um Excel ou CSV e receba os destaques", text: "Analise a planilha anexada e me diga os 3 pontos principais." },
	{ title: "Criar um dashboard", hint: "Painel HTML interativo a partir dos seus dados", text: "Monte um dashboard HTML com os dados da planilha anexada, com filtros por " },
	{ title: "Resumir um documento", hint: "PDF, Word ou PowerPoint em tópicos e decisões", text: "Resuma o documento anexado em 5 tópicos e liste as decisões pendentes." },
];
const isMobile = () => matchMedia("(max-width: 860px)").matches;
const newId = () => crypto.randomUUID();

export function App() {
	const [list, setList] = useState<ConversationSummary[]>([]);
	const [conv, setConv] = useState<string>();
	const [title, setTitle] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [files, setFiles] = useState<FileInfo[]>([]);
	const [votes, setVotes] = useState<Record<string, "up" | "down">>({});
	const [busy, setBusy] = useState(false);
	const [sideOpen, setSideOpen] = useState(!isMobile());
	const [drawer, setDrawer] = useState<DrawerTab>();
	const [refreshKey, setRefreshKey] = useState(0);
	const [toast, setToast] = useState<string>();
	const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
	const [seed, setSeed] = useState<{ text: string; n: number }>();
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const [preview, setPreview] = useState<FileInfo>();
	const [picker, setPicker] = useState(false);
	const abort = useRef<AbortController>(undefined);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const pendingConv = useRef<string>(undefined);
	const previewDlg = useRef<HTMLDialogElement>(null);
	const dropTarget = useRef<(f: FileList) => void>(undefined);

	const notify = useCallback((t: string) => {
		setToast(t);
		setTimeout(() => setToast(undefined), 2600);
	}, []);
	const refreshList = useCallback(() => void api.conversations().then(setList).catch(() => {}), []);

	useEffect(() => {
		refreshList();
		const p = new URLSearchParams(location.search);
		if (p.get("connector")) {
			setNotice(p.get("status") === "ok" ? { text: `${p.get("connector")} conectado. As ferramentas ficam disponíveis a partir da próxima mensagem.` } : { text: `Não foi possível conectar ${p.get("connector")}: ${p.get("status")}`, error: true });
			setDrawer("connectors");
			history.replaceState(null, "", location.pathname);
		}
		// Back from "Conectar Microsoft": reopen the conversation and the picker the user was in.
		let after: { conv?: string; picker?: boolean } | undefined;
		try {
			after = JSON.parse(sessionStorage.getItem("assistente.afterConnect") ?? "null") ?? undefined;
			sessionStorage.removeItem("assistente.afterConnect");
		} catch {
			after = undefined;
		}
		const c = location.hash.slice(1) || after?.conv;
		// A new conversation that only had attachments does not exist on the server yet: keep its id.
		if (c) void open(c, () => (pendingConv.current = c));
		if (after?.picker && p.get("status") === "ok") {
			setDrawer(undefined);
			setPicker(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Follow the stream only while the reader is at the bottom.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const ensureConv = useCallback(() => {
		if (conv) return conv;
		pendingConv.current ??= newId();
		return pendingConv.current;
	}, [conv]);

	async function open(id: string, onMissing?: () => void) {
		if (busy) abort.current?.abort();
		try {
			const d = await api.conversation(id);
			setConv(id);
			setTitle(d.title);
			setMessages(d.messages);
			setFiles(d.files);
			setVotes(d.feedback);
			setNotice(undefined);
			pendingConv.current = undefined;
			history.replaceState(null, "", `#${id}`);
			pinned.current = true;
			if (isMobile()) setSideOpen(false);
		} catch (e) {
			if (e instanceof HttpError && e.status === 404 && onMissing) return onMissing();
			notify(e instanceof HttpError && e.status === 404 ? "Conversa não encontrada." : "Não consegui abrir a conversa.");
			history.replaceState(null, "", location.pathname);
		}
	}

	function startNew() {
		abort.current?.abort();
		setConv(undefined);
		setTitle("");
		setMessages([]);
		setFiles([]);
		setVotes({});
		setNotice(undefined);
		setAttachments([]);
		pendingConv.current = undefined;
		history.replaceState(null, "", location.pathname);
		if (isMobile()) setSideOpen(false);
	}

	async function run(text: string, skills: string[], edit = false, display?: string) {
		const id = conv ?? pendingConv.current;
		const before = new Set(files.map((f) => f.path));
		const user: Message = { role: "user", id: `local-${Date.now()}`, text: display ?? text };
		const live: Extract<Message, { role: "assistant" }> = { role: "assistant", id: `live-${Date.now()}`, parts: [], streaming: true };
		setMessages((m) => {
			let base = m;
			if (edit) {
				const lastUser = m.map((x) => x.role).lastIndexOf("user");
				base = lastUser >= 0 ? m.slice(0, lastUser) : m;
			}
			return [...base, user, live];
		});
		setBusy(true);
		setNotice(undefined);
		pinned.current = true;
		const ctrl = new AbortController();
		abort.current = ctrl;
		let cur = live;
		const patch = (f: (a: typeof live) => typeof live) =>
			setMessages((m) => {
				cur = f(cur);
				return m.map((x) => (x.id === live.id ? cur : x));
			});
		let convId = id;
		try {
			for await (const ev of chat({ conversationId: id, message: text, skills, edit }, ctrl.signal)) {
				if (ev.type === "start") {
					convId = ev.conversationId;
					if (!conv) {
						setConv(convId);
						setTitle(display ?? text);
						history.replaceState(null, "", `#${convId}`);
					}
				} else if (ev.type === "delta") {
					patch((a) => {
						const parts = [...a.parts];
						const lastPart = parts[parts.length - 1];
						if (lastPart?.type === "text") parts[parts.length - 1] = { type: "text", text: lastPart.text + ev.text };
						else parts.push({ type: "text", text: ev.text });
						return { ...a, parts };
					});
				} else if (ev.type === "tool") {
					patch((a) => ({ ...a, parts: [...a.parts, { type: "tool", id: `${a.parts.length}`, name: ev.name, args: ev.args, running: true } as ToolStep] }));
				} else if (ev.type === "tool_end") {
					patch((a) => {
						const parts = [...a.parts];
						for (let i = parts.length - 1; i >= 0; i--) {
							const p = parts[i];
							if (p.type === "tool" && p.running && p.name === ev.name) {
								parts[i] = { ...p, running: false, isError: ev.isError };
								break;
							}
						}
						return { ...a, parts };
					});
				} else if (ev.type === "memory_used") patch((a) => ({ ...a, memory: { core: ev.core, facts: ev.facts, conversations: ev.conversations } }));
				else if (ev.type === "memory") patch((a) => ({ ...a, saved: ev.saved }));
				else if (ev.type === "error") patch((a) => ({ ...a, error: `Algo deu errado: ${ev.message}` }));
				else if (ev.type === "done") {
					setFiles(ev.files);
					patch((a) => ({ ...a, streaming: false, newFiles: ev.files.filter((f) => !before.has(f.path)) }));
				}
			}
		} catch (e) {
			if (ctrl.signal.aborted) patch((a) => ({ ...a, streaming: false, error: a.parts.length ? undefined : "Resposta interrompida." }));
			else if (e instanceof HttpError && e.status === 409) {
				setMessages((m) => m.filter((x) => x.id !== live.id && x.id !== user.id));
				setNotice({ text: "Esta conversa está respondendo em outra aba ou dispositivo. Aguarde terminar e tente de novo.", error: true });
			} else patch((a) => ({ ...a, streaming: false, error: `Não consegui responder: ${(e as Error).message}` }));
		} finally {
			patch((a) => ({ ...a, streaming: false }));
			setBusy(false);
			abort.current = undefined;
			pendingConv.current = undefined;
			refreshList();
			setRefreshKey((k) => k + 1);
			// Sync ids with the stored history (feedback is keyed by them); keep this turn's extras.
			if (convId && !ctrl.signal.aborted)
				api
					.conversation(convId)
					.then((d) => {
						const extras = cur;
						const msgs = d.messages;
						const lastA = msgs.map((m) => m.role).lastIndexOf("assistant");
						if (lastA >= 0 && msgs[lastA].role === "assistant") msgs[lastA] = { ...msgs[lastA], memory: extras.memory, saved: extras.saved, newFiles: extras.newFiles, error: extras.error };
						setMessages(msgs);
						setTitle(d.title);
						setVotes(d.feedback);
					})
					.catch(() => {});
		}
	}

	const send = (text: string, skills: string[]) => void run(text, skills);
	const lastUser = [...messages].reverse().find((m) => m.role === "user") as Extract<Message, { role: "user" }> | undefined;
	const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

	function useFromLibrary(f: LibraryFile) {
		const id = ensureConv();
		api
			.attach(id, f.id)
			.then((r) => {
				setAttachments((a) => [...a, { path: r.path, name: f.name, state: "ready" }]);
				notify(`${f.name} anexado à conversa.`);
			})
			.catch((e) => notify(`Não consegui anexar: ${e.message}`));
	}

	/** Office for the web: save the deliverable to the user's OneDrive › Assistente and open it.
	 *  The tab opens synchronously (popup blockers) and gets the link when the save returns. */
	async function cloud(f: FileInfo, mode: "open" | "save") {
		if (!conv) return;
		const tab = mode === "open" ? window.open("about:blank", "_blank") : null;
		try {
			const r = await api.saveToOneDrive(conv, f.path);
			if (tab) tab.location.href = r.webUrl;
			else notify(r.existed ? `Já está no OneDrive › Assistente como ${r.name}.` : `Salvo no OneDrive › Assistente como ${r.name}.`);
		} catch (e) {
			tab?.close();
			const err = e as HttpError;
			if (err.status === 412 || err.code === "reconsent") {
				const msg = err.code === "reconsent" ? "Para salvar, a Microsoft vai pedir permissão de escrita no seu OneDrive. Continuar?" : "Conecte sua conta Microsoft para salvar no OneDrive. Continuar?";
				if (confirm(msg)) {
					try {
						sessionStorage.setItem("assistente.afterConnect", JSON.stringify({ conv }));
					} catch {
						/* storage blocked */
					}
					location.href = "api/connectors/microsoft/connect";
				}
			} else notify(`Não consegui salvar no OneDrive: ${err.message}`);
		}
	}

	function openPreview(f: FileInfo) {
		setPreview(f);
		requestAnimationFrame(() => previewDlg.current?.showModal());
	}

	const empty = messages.length === 0;
	// A JSX value, not a nested component: the composer keeps its draft across renders.
	const composer = (
		<Composer
			busy={busy}
			centered={empty}
			ensureConv={ensureConv}
			onSend={send}
			onStop={() => abort.current?.abort()}
			seed={seed}
			attachments={attachments}
			setAttachments={setAttachments}
			notify={notify}
			registerDrop={(f) => (dropTarget.current = f)}
			onDrive={() => setPicker(true)}
		/>
	);
	return (
		<div
			className="app"
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				if (e.dataTransfer.files.length) dropTarget.current?.(e.dataTransfer.files);
			}}
		>
			<Sidebar
				open={sideOpen}
				list={list}
				current={conv}
				onToggle={() => setSideOpen((v) => !v)}
				onNew={startNew}
				onOpen={open}
				onRename={(id, t) =>
					api.rename(id, t).then(() => {
						refreshList();
						if (id === conv) setTitle(t);
					})
				}
				onDelete={(id) =>
					api.remove(id).then(() => {
						refreshList();
						if (id === conv) startNew();
						notify("Conversa apagada.");
					})
				}
				onDrawer={(t) => setDrawer((d) => (d === t ? undefined : t))}
				drawer={drawer}
			/>
			<main className="main">
				<div className="topbar">
					{!sideOpen && (
						<>
							<button type="button" className="icon-btn" aria-label="Abrir barra lateral" title="Abrir barra lateral" onClick={() => setSideOpen(true)}>
								<PanelLeft size={18} />
							</button>
							<button type="button" className="icon-btn" aria-label="Nova conversa" title="Nova conversa" onClick={startNew}>
								<SquarePen size={18} />
							</button>
						</>
					)}
					<span className="conv-title">{title || (sideOpen ? "" : "Assistente")}</span>
					<span className="spacer" />
				</div>
				{notice && (
					<div className="notice-wrap" style={{ padding: "0 24px" }}>
						<div className={`notice${notice.error ? " error" : ""}`} role="status">
							<span style={{ flex: 1 }}>{notice.text}</span>
							<button type="button" className="icon-btn small" aria-label="Fechar aviso" onClick={() => setNotice(undefined)}>
								<X size={15} />
							</button>
						</div>
					</div>
				)}
				{empty ? (
					<div className="welcome">
						<h1>Como posso ajudar?</h1>
						{composer}
						<div className="starters">
							{STARTERS.map((s) => (
								<button key={s.title} type="button" className="starter" onClick={() => setSeed({ text: s.text, n: Date.now() })}>
									<strong>{s.title}</strong>
									{s.hint}
								</button>
							))}
						</div>
					</div>
				) : (
					<>
						<div
							className="scroller"
							ref={scroller}
							onScroll={(e) => {
								const el = e.currentTarget;
								pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
							}}
						>
							<div className="column">
								{messages.map((m) =>
									m.role === "user" ? (
										<UserMessage key={m.id} m={m} canEdit={!busy && m.id === lastUser?.id} onEdit={(t) => void run(t, [], true)} />
									) : (
										<AssistantMessage
											key={m.id}
											m={m}
											conv={conv}
											last={m.id === lastAssistantId}
											busy={busy}
											vote={votes[m.id]}
											onVote={(v) => {
												if (!conv) return;
												setVotes((x) => {
													const n = { ...x };
													if (v) n[m.id] = v;
													else delete n[m.id];
													return n;
												});
												api.feedback(conv, m.id, v).catch(() => notify("Não consegui registrar a avaliação."));
											}}
											onRegenerate={() => lastUser && void run(lastUser.text, [], true)}
											onPreview={openPreview}
											onCloud={cloud}
										/>
									),
								)}
							</div>
						</div>
						{composer}
					</>
				)}
				{dragging && <div className="drop">Solte os arquivos para anexar</div>}
			</main>
			{drawer && <Drawer tab={drawer} setTab={setDrawer} onClose={() => setDrawer(undefined)} conv={conv} files={files} onUse={useFromLibrary} onPreview={openPreview} onCloud={cloud} refreshKey={refreshKey} />}
			<dialog className="sheet" ref={previewDlg} onClose={() => setPreview(undefined)}>
				{preview && conv && (
					<>
						<header>
							<strong>{preview.path.split("/").pop()}</strong>
							<a className="btn" style={{ display: "inline-grid", placeItems: "center", textDecoration: "none", color: "inherit" }} href={fileUrl(conv, preview.path)}>
								Baixar
							</a>
							<button type="button" className="icon-btn" aria-label="Fechar" onClick={() => previewDlg.current?.close()}>
								<X size={18} />
							</button>
						</header>
						<div className="content">
							{preview.path.endsWith(".html") ? (
								// Generated dashboards run their own charts: allowed to script, never to reach this page.
								<iframe title="Pré-visualização" sandbox="allow-scripts" src={fileUrl(conv, preview.path, true)} />
							) : (
								<div style={{ height: "100%", display: "grid", placeItems: "center", overflow: "auto", padding: 16 }}>
									<img src={fileUrl(conv, preview.path, true)} alt={preview.path} style={{ maxWidth: "100%", maxHeight: "100%" }} />
								</div>
							)}
						</div>
					</>
				)}
			</dialog>
			<DrivePicker
				open={picker}
				conv={conv ?? pendingConv.current}
				onClose={() => setPicker(false)}
				onImport={async (items) => {
					const id = ensureConv();
					try {
						const r = await api.importDrive(id, items.map(({ driveId, id: itemId, name }) => ({ driveId, id: itemId, name })));
						setAttachments((a) => [...a, ...r.paths.map((p) => ({ path: p, name: p.replace(/^uploads\//, ""), state: "ready" as const }))]);
						notify(r.paths.length === 1 ? "Arquivo anexado." : `${r.paths.length} arquivos anexados.`);
					} catch (e) {
						notify(`Não consegui anexar: ${(e as Error).message}`);
						throw e;
					}
				}}
			/>
			{toast && (
				<div className="toast" role="status">
					{toast}
				</div>
			)}
		</div>
	);
}
