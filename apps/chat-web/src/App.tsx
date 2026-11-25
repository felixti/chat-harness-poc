import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Folder, PanelLeft, SquarePen, X } from "lucide-react";
import { api, chat, fileUrl, HttpError, SessionExpired, type CanvasEvent, type ConversationSummary, type Project, type FileInfo, type Interrupt, type LibraryFile, type MemoryUsed, type Message, type ResumeEntry, type Source, type ToolStep } from "./api";

/** Steps held by an open interrupt read as "waiting", not as failed. */
function markWaiting(parts: (ToolStep | { type: "text"; text: string })[], interrupts?: Interrupt[]) {
	const waiting = new Set((interrupts ?? []).map((i) => i.toolCallId));
	return parts.map((p) => (p.type === "tool" && waiting.has(p.id) ? { ...p, isError: false, waiting: true } : p));
}
import { AssistantMessage, UserMessage } from "./Message";
import { parseAction } from "./RichParts";
import { Composer, type Attachment } from "./Composer";
import { Sidebar, type DrawerTab } from "./Sidebar";
import { Drawer } from "./Drawer";
import { DrivePicker } from "./DrivePicker";
import { CanvasPanel, type CanvasTarget } from "./CanvasPanel";
import { SELECT_SHORTCUTS, SHORTCUTS, useVimKeys, useVimSetting } from "./vim";
import { loadModelPref, ModelPicker, type ModelPref } from "./ModelPicker";
import { fmtBrl, fmtUsd, type Spend } from "./cost";
import { Logo, LogoMark } from "./Logo";
import { ProjectView } from "./ProjectView";

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
	// Projects (H71): the open project page, or the project of the open conversation.
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProject] = useState<string>();
	const [conv, setConv] = useState<string>();
	const convRef = useRef<string | undefined>(undefined);
	convRef.current = conv;
	const [title, setTitle] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [files, setFiles] = useState<FileInfo[]>([]);
	const [votes, setVotes] = useState<Record<string, "up" | "down">>({});
	const [busy, setBusy] = useState(false);
	const [sideOpen, setSideOpen] = useState(!isMobile());
	const [drawer, setDrawer] = useState<DrawerTab>();
	const [refreshKey, setRefreshKey] = useState(0);
	const [toast, setToast] = useState<string>();
	const [notice, setNotice] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void } }>();
	const [seed, setSeed] = useState<{ text: string; n: number }>();
	const [modelPref, setModelPref] = useState<ModelPref>(loadModelPref);
	// Cost (H58): this conversation and the user's month, from the server's ledger.
	const [convCost, setConvCost] = useState<Spend>();
	const [monthCost, setMonthCost] = useState<Spend>();
	useEffect(() => {
		api.usage().then((u) => setMonthCost(u.month)).catch(() => {});
	}, []);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const [preview, setPreview] = useState<FileInfo>();
	const [picker, setPicker] = useState(false);
	const [canvas, setCanvas] = useState<CanvasTarget>();
	// A canvas needs room: on laptop widths the history sidebar steps aside while it is open.
	useEffect(() => {
		if (canvas && innerWidth < 1440) setSideOpen(false);
	}, [canvas?.name]); // eslint-disable-line react-hooks/exhaustive-deps
	const abort = useRef<AbortController>(undefined);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const pendingConv = useRef<string>(undefined);
	const previewDlg = useRef<HTMLDialogElement>(null);
	const dropTarget = useRef<(f: FileList) => void>(undefined);
	const [vim, setVim] = useVimSetting();
	const [selecting, setSelecting] = useState(false);
	const keysDlg = useRef<HTMLDialogElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const notify = useCallback((t: string) => {
		setToast(t);
		setTimeout(() => setToast(undefined), 2600);
	}, []);
	// The sign-in session ended (Envoy answered 401): offer to sign in again, keeping the
	// conversation and the unsent text across the login redirect.
	useEffect(() => {
		const onExpired = () =>
			setNotice({
				text: "Sua sessão expirou. Entre de novo para continuar; o texto que você digitou fica guardado.",
				error: true,
				action: {
					label: "Entrar de novo",
					run: () => {
						const draft = document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value;
						try {
							sessionStorage.setItem("assistente.relogin", JSON.stringify({ conv: convRef.current, draft }));
						} catch {
							/* private mode: the sign-in still works */
						}
						location.reload();
					},
				},
			});
		addEventListener("session-expired", onExpired);
		return () => removeEventListener("session-expired", onExpired);
	}, []);

	const refreshList = useCallback(() => void api.conversations().then(setList).catch(() => {}), []);
	const refreshProjects = useCallback(() => void api.projects().then(setProjects).catch(() => {}), []);

	useEffect(() => {
		refreshList();
		refreshProjects();
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
		// Back from signing in again: reopen the conversation and restore the unsent text.
		let relogin: { conv?: string; draft?: string } | undefined;
		try {
			relogin = JSON.parse(sessionStorage.getItem("assistente.relogin") ?? "null") ?? undefined;
			sessionStorage.removeItem("assistente.relogin");
		} catch {
			relogin = undefined;
		}
		if (relogin?.draft) setSeed({ text: relogin.draft, n: Date.now() });
		const c = location.hash.slice(1) || after?.conv || relogin?.conv;
		// A new conversation that only had attachments does not exist on the server yet: keep its id.
		if (c?.startsWith("p/")) openProject(c.slice(2));
		else if (c) void open(c, () => (pendingConv.current = c));
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
			setProject(d.projectId);
			const msgs = d.messages;
			const lastA = msgs.map((m) => m.role).lastIndexOf("assistant");
			if (d.interrupts?.length && lastA >= 0 && msgs[lastA].role === "assistant") {
				const m = msgs[lastA] as Extract<Message, { role: "assistant" }>;
				msgs[lastA] = { ...m, interrupts: d.interrupts, parts: markWaiting(m.parts, d.interrupts) };
			}
			setMessages(msgs);
			setFiles(d.files);
			setVotes(d.feedback);
			setConvCost(d.cost);
			setNotice(undefined);
			setCanvas((c) => (id === conv ? c : undefined));
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

	/** The project page: a new conversation started there belongs to the project. */
	function openProject(id: string) {
		startNew();
		setProject(id);
		history.replaceState(null, "", `#p/${id}`);
	}

	async function newProject() {
		const name = prompt("Nome do projeto")?.trim();
		if (!name) return;
		try {
			const p = await api.createProject(name);
			setProjects((ps) => [p, ...ps]);
			openProject(p.id);
		} catch (e) {
			notify(`Não consegui criar o projeto: ${(e as Error).message}`);
		}
	}

	async function moveConv(id: string, projectId: string | null) {
		try {
			await api.move(id, projectId);
			refreshList();
			if (id === conv) setProject(projectId ?? undefined);
			notify(projectId ? `Movida para ${projects.find((p) => p.id === projectId)?.name ?? "o projeto"}.` : "Conversa fora do projeto.");
		} catch (e) {
			notify(`Não consegui mover: ${(e as Error).message}`);
		}
	}

	function startNew() {
		abort.current?.abort();
		setProject(undefined);
		setCanvas(undefined);
		setConv(undefined);
		setTitle("");
		setMessages([]);
		setFiles([]);
		setVotes({});
		setConvCost(undefined);
		setNotice(undefined);
		setAttachments([]);
		pendingConv.current = undefined;
		history.replaceState(null, "", location.pathname);
		if (isMobile()) setSideOpen(false);
	}

	async function run(text: string, skills: string[], edit = false, display?: string, resume?: ResumeEntry[]) {
		const id = ensureConv();
		const before = new Set(files.map((f) => f.path));
		const user: Message = { role: "user", id: `local-${Date.now()}`, text: display ?? text };
		const live: Extract<Message, { role: "assistant" }> = { role: "assistant", id: `live-${Date.now()}`, parts: [], streaming: true };
		setMessages((m) => {
			// A new run answers (or supersedes) any open interrupt card.
			let base = m.map((x) => (x.role === "assistant" && x.interrupts ? { ...x, interrupts: undefined } : x));
			if (edit) {
				const lastUser = base.map((x) => x.role).lastIndexOf("user");
				base = lastUser >= 0 ? base.slice(0, lastUser) : base;
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
		const setTool = (toolCallId: string, f: (t: ToolStep) => ToolStep) =>
			patch((a) => ({ ...a, parts: a.parts.map((p) => (p.type === "tool" && p.id === toolCallId ? f(p) : p)) }));
		const argText = new Map<string, string>();
		let convId = id;
		try {
			for await (const ev of chat({ threadId: id, message: resume ? undefined : text, skills, edit, resume, ...modelPref, ...(!conv && project ? { projectId: project } : {}) }, ctrl.signal)) {
				switch (ev.type) {
					case "RUN_STARTED":
						convId = ev.threadId;
						if (!conv) {
							setConv(convId);
							setTitle(display ?? text);
							history.replaceState(null, "", `#${convId}`);
						}
						break;
					case "TEXT_MESSAGE_CONTENT":
						patch((a) => {
							const parts = [...a.parts];
							const lastPart = parts[parts.length - 1];
							if (lastPart?.type === "text") parts[parts.length - 1] = { type: "text", text: lastPart.text + ev.delta };
							else parts.push({ type: "text", text: ev.delta });
							return { ...a, parts };
						});
						break;
					case "REASONING_MESSAGE_CONTENT":
						patch((a) => ({ ...a, reasoning: (a.reasoning ?? "") + ev.delta }));
						break;
					case "TOOL_CALL_START":
						patch((a) => ({ ...a, parts: [...a.parts, { type: "tool", id: ev.toolCallId, name: ev.toolCallName, args: {}, running: true }] }));
						break;
					case "TOOL_CALL_ARGS": {
						const t = (argText.get(ev.toolCallId) ?? "") + ev.delta;
						argText.set(ev.toolCallId, t);
						try {
							const args = JSON.parse(t);
							setTool(ev.toolCallId, (p) => ({ ...p, args }));
						} catch {
							/* partial JSON: wait for the rest */
						}
						break;
					}
					case "TOOL_CALL_RESULT":
						setTool(ev.toolCallId, (p) => ({ ...p, running: false, isError: !!ev.metadata?.isError }));
						break;
					case "CUSTOM":
						if (ev.name === "memory_used") patch((a) => ({ ...a, memory: ev.value as MemoryUsed }));
						else if (ev.name === "sources") patch((a) => ({ ...a, sources: ev.value as Source[] }));
						else if (ev.name === "usage") {
							const u = ev.value as { conversation: Spend; month: Spend };
							setConvCost(u.conversation);
							setMonthCost(u.month);
						} else if (ev.name === "memory_saved") patch((a) => ({ ...a, saved: ev.value as string[] }));
						else if (ev.name === "canvas") {
							const c = ev.value as CanvasEvent;
							setDrawer(undefined);
							setCanvas({ name: c.name, version: c.version, live: c });
						} else if (ev.name === "model_error") patch((a) => ({ ...a, error: `Algo deu errado: ${(ev.value as { message?: string }).message ?? ""}` }));
						else if (ev.name === "files") {
							const fs = ev.value as FileInfo[];
							setFiles(fs);
							patch((a) => ({ ...a, newFiles: fs.filter((f) => !before.has(f.path)) }));
						}
						break;
					case "RUN_FINISHED": {
						const interrupts = ev.outcome?.type === "interrupt" ? ev.outcome.interrupts : undefined;
						const waiting = new Set((interrupts ?? []).map((i) => i.toolCallId));
						patch((a) => ({
							...a,
							streaming: false,
							interrupts,
							// A call held for approval is not a failure: show it as waiting.
							parts: a.parts.map((p) => (p.type === "tool" && waiting.has(p.id) ? { ...p, isError: false, running: false, waiting: true } : p)),
						}));
						break;
					}
					case "RUN_ERROR":
						patch((a) => ({ ...a, error: `Algo deu errado: ${ev.message}` }));
						break;
				}
			}
		} catch (e) {
			if (e instanceof SessionExpired) {
				// Nothing was sent: put the text back in the composer for after the sign-in.
				setMessages((m) => m.filter((x) => x.id !== live.id && x.id !== user.id));
				if (!resume) setSeed({ text, n: Date.now() });
			} else if (ctrl.signal.aborted) patch((a) => ({ ...a, streaming: false, error: a.parts.length ? undefined : "Resposta interrompida." }));
			else if (e instanceof HttpError && e.status === 409) {
				setMessages((m) => m.filter((x) => x.id !== live.id && x.id !== user.id));
				setNotice({ text: resume ? "Esse pedido de aprovação já foi respondido ou expirou." : "Esta conversa está respondendo em outra aba ou dispositivo. Aguarde terminar e tente de novo.", error: true });
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
						if (lastA >= 0 && msgs[lastA].role === "assistant")
							msgs[lastA] = { ...msgs[lastA], memory: extras.memory, saved: extras.saved, newFiles: extras.newFiles, error: extras.error, interrupts: d.interrupts?.length ? d.interrupts : undefined, parts: markWaiting(msgs[lastA].parts, d.interrupts) };
						setMessages(msgs);
						setTitle(d.title);
						setVotes(d.feedback);
					})
					.catch(() => {});
		}
	}

	/** Answer an interrupt card: approval (approved true/false) or the answers to questions. */
	function respond(interrupt: Interrupt, entry: Omit<ResumeEntry, "interruptId">, display: string) {
		void run(display, [], false, display, [{ interruptId: interrupt.id, ...entry }]);
	}


	const send = (text: string, skills: string[]) => void run(text, skills);
	const lastUser = [...messages].reverse().find((m) => m.role === "user") as Extract<Message, { role: "user" }> | undefined;
	const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
	// Index of the last message that submitted each A2UI surface: earlier copies render as sent.
	const actions = new Map<string, number>();
	messages.forEach((m, i) => {
		const a = m.role === "user" ? parseAction(m.text) : undefined;
		if (a) actions.set(a.surface, i);
	});

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
	const canvasTitles = new Map<string, string>();
	for (const m of messages)
		if (m.role === "assistant")
			for (const p of m.parts) {
				const a = (p.type === "tool" && p.name === "canvas" ? p.args : undefined) as { name?: string; title?: string } | undefined;
				if (a?.name && a.title) canvasTitles.set(a.name, a.title);
			}
	// canvas.send(text) from a page: the text goes to the message box; the user sends it.
	const sendFromCanvas = useCallback((text: string) => setSeed({ text, n: Date.now() }), []);

	function deleteConv(id: string) {
		return api.remove(id).then(() => {
			refreshList();
			if (id === conv) startNew();
			notify("Conversa apagada.");
		});
	}
	async function deleteMany(ids: string[]) {
		try {
			const r = await api.removeMany(ids);
			refreshList();
			if (conv && r.deleted.includes(conv)) startNew();
			notify(r.deleted.length === 1 ? "1 conversa apagada." : `${r.deleted.length} conversas apagadas.`);
		} catch (e) {
			notify(`Não consegui apagar: ${(e as Error).message}`);
			refreshList();
		}
	}

	const scrollBy = (dy: number) => scroller.current?.scrollBy({ top: dy, behavior: "smooth" });
	const step = (d: number) => {
		const i = list.findIndex((c) => c.id === conv);
		const next = list[i < 0 ? (d > 0 ? 0 : list.length - 1) : i + d];
		if (next) void open(next.id);
	};
	useVimKeys(
		vim && !selecting,
		{
			j: () => scrollBy(80),
			k: () => scrollBy(-80),
			"C-d": () => scrollBy((scroller.current?.clientHeight ?? 600) / 2),
			"C-u": () => scrollBy(-(scroller.current?.clientHeight ?? 600) / 2),
			gg: () => scroller.current?.scrollTo({ top: 0, behavior: "smooth" }),
			G: () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }),
			J: () => step(1),
			K: () => step(-1),
			o: startNew,
			i: () => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
			"/": () => {
				setSideOpen(true);
				requestAnimationFrame(() => searchRef.current?.focus());
			},
			dd: () => {
				if (conv && confirm("Apagar esta conversa e os arquivos dela? Não dá para desfazer.")) void deleteConv(conv);
			},
			v: () => {
				setSideOpen(true);
				setSelecting(true);
			},
		},
		() => keysDlg.current?.showModal(),
	);
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
				onDelete={(id) => void deleteConv(id)}
				onDeleteMany={deleteMany}
				selecting={selecting}
				setSelecting={setSelecting}
				vim={vim}
				onShortcuts={() => keysDlg.current?.showModal()}
				monthCost={monthCost}
				searchRef={searchRef}
				projects={projects}
				currentProject={project}
				onOpenProject={openProject}
				onNewProject={() => void newProject()}
				onMove={(id, pid) => void moveConv(id, pid)}
				onDrawer={(t) => {
					setCanvas(undefined);
					setDrawer((d) => (d === t ? undefined : t));
				}}
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
					{project && conv && projects.some((p) => p.id === project) && (
						<button type="button" className="crumb" title="Abrir o projeto" onClick={() => openProject(project)}>
							<Folder size={15} /> {projects.find((p) => p.id === project)?.name} <ChevronRight size={14} />
						</button>
					)}
					{title ? <span className="conv-title">{title}</span> : !sideOpen && <Logo />}
					<span className="spacer" />
					{convCost && convCost.turns > 0 && (
						<span className="cost-chip" title={`Custo desta conversa: ${fmtBrl(convCost.brl)} (${fmtUsd(convCost.usd)}) em ${convCost.turns} ${convCost.turns === 1 ? "resposta" : "respostas"}. Estimativa pelos preços do provedor.`}>
							Conversa: {fmtBrl(convCost.brl)}
						</span>
					)}
					<ModelPicker pref={modelPref} setPref={setModelPref} disabled={busy} />
				</div>
				{notice && (
					<div className="notice-wrap" style={{ padding: "0 24px" }}>
						<div className={`notice${notice.error ? " error" : ""}`} role="status">
							<span style={{ flex: 1 }}>{notice.text}</span>
							{notice.action && (
								<button type="button" className="btn small" onClick={notice.action.run}>
									{notice.action.label}
								</button>
							)}
							<button type="button" className="icon-btn small" aria-label="Fechar aviso" onClick={() => setNotice(undefined)}>
								<X size={15} />
							</button>
						</div>
					</div>
				)}
				{empty && project && !busy ? (
					<ProjectView
						id={project}
						conversations={list.filter((c) => c.projectId === project)}
						composer={composer}
						onOpen={(id) => void open(id)}
						onChanged={refreshProjects}
						onDeleted={() => {
							refreshProjects();
							refreshList();
							startNew();
						}}
						notify={notify}
					/>
				) : empty ? (
					<div className="welcome">
						<LogoMark size={44} className="welcome-mark" />
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
								{messages.map((m, idx) =>
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
											onRespond={respond}
												sentSurface={(sid) => (actions.get(sid) ?? -1) > idx}
												onUiAction={(text) => void run(text, [])}
											canvasTitles={canvasTitles}
											onCanvas={(name) => {
												setDrawer(undefined);
												setCanvas({ name });
											}}
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
			{canvas && (
				<CanvasPanel
					conv={conv}
					target={canvas}
					onClose={() => setCanvas(undefined)}
					onSend={sendFromCanvas}
					notify={notify}
				/>
			)}
			{!canvas && drawer && <Drawer tab={drawer} setTab={setDrawer} onClose={() => setDrawer(undefined)} conv={conv} files={files} onUse={useFromLibrary} onPreview={openPreview} onCloud={cloud} refreshKey={refreshKey} />}
			<dialog className="keys" ref={keysDlg} aria-label="Atalhos de teclado">
				<header>
					<strong>Atalhos de teclado</strong>
					<button type="button" className="icon-btn" aria-label="Fechar" onClick={() => keysDlg.current?.close()}>
						<X size={18} />
					</button>
				</header>
				<div className="body">
					<label className="toggle">
						<input type="checkbox" checked={vim} onChange={(e) => setVim(e.target.checked)} />
						Modo vim
					</label>
					<p className="hint">Navegue sem mouse. Funciona fora dos campos de texto; fica salvo neste navegador.</p>
					<div>
						<h3>Navegação</h3>
						<dl className={vim ? "" : "off"}>
							{SHORTCUTS.map(([k, d]) => (
								<div key={k} style={{ display: "contents" }}>
									<dt>{k.split(" / ").map((x, n) => (<span key={x}>{n > 0 && " / "}<kbd>{x}</kbd></span>))}</dt>
									<dd>{d}</dd>
								</div>
							))}
							<dt><kbd>?</kbd></dt>
							<dd>Mostrar esta janela</dd>
						</dl>
					</div>
					<div>
						<h3>Seleção de conversas (também sem o modo vim)</h3>
						<dl>
							{SELECT_SHORTCUTS.map(([k, d]) => (
								<div key={k} style={{ display: "contents" }}>
									<dt>{k.split(" / ").map((x, n) => (<span key={x}>{n > 0 && " / "}<kbd>{x}</kbd></span>))}</dt>
									<dd>{d}</dd>
								</div>
							))}
							<dt><kbd>Ctrl</kbd> / <kbd>Shift</kbd> + clique</dt>
							<dd>Começar a seleção / marcar um intervalo</dd>
						</dl>
					</div>
				</div>
			</dialog>
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
