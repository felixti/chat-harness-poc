import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { api, type LibraryFile, type Skill } from "./api";

export interface Attachment {
	path: string;
	name: string;
	state: "uploading" | "ready" | "error";
}

type MenuItem = { key: string; title: string; detail: string; pick: () => void };

export function Composer({
	busy,
	ensureConv,
	onSend,
	onStop,
	centered,
	seed,
	attachments,
	setAttachments,
	notify,
	registerDrop,
}: {
	busy: boolean;
	ensureConv: () => string;
	onSend: (text: string, skills: string[]) => void;
	onStop: () => void;
	centered: boolean;
	seed?: { text: string; n: number };
	attachments: Attachment[];
	setAttachments: (f: (a: Attachment[]) => Attachment[]) => void;
	notify: (t: string) => void;
	registerDrop: (f: (files: FileList) => void) => void;
}) {
	const [text, setText] = useState("");
	const [skills, setSkills] = useState<string[]>([]);
	const [catalog, setCatalog] = useState<Skill[]>([]);
	const [library, setLibrary] = useState<LibraryFile[]>([]);
	const [sel, setSel] = useState(0);
	const ta = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		api.skills().then(setCatalog).catch(() => {});
	}, []);
	useEffect(() => {
		if (seed) {
			setText(seed.text);
			ta.current?.focus();
		}
	}, [seed]);
	useLayoutEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
	}, [text]);

	// "/" at the start picks a skill; "@word" anywhere picks one of the user's files.
	const slash = /^\/([\w-]*)$/.exec(text)?.[1];
	const at = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1];
	useEffect(() => {
		if (at !== undefined && !library.length) api.library().then(setLibrary).catch(() => {});
	}, [at, library.length]);

	const items = useMemo<MenuItem[]>(() => {
		if (slash !== undefined)
			return catalog
				.filter((s) => s.name.includes(slash.toLowerCase()) && !skills.includes(s.name))
				.slice(0, 12)
				.map((s) => ({
					key: s.name,
					title: s.name,
					detail: s.description,
					pick: () => {
						setSkills((k) => [...k, s.name]);
						setText("");
					},
				}));
		if (at !== undefined) {
			const q = at.toLowerCase();
			return library
				.filter((f) => f.name.toLowerCase().includes(q) || (f.title ?? "").toLowerCase().includes(q))
				.slice(0, 10)
				.map((f) => ({
					key: f.id,
					title: f.name,
					detail: `${f.kind === "upload" ? "Enviado" : "Gerado"} em ${f.modified?.slice(0, 10) ?? ""}${f.title ? ` · ${f.title}` : ""}`,
					pick: () => {
						setText((t) => t.replace(/(^|\s)@[^\s@]*$/, "$1"));
						attachFromLibrary(f);
					},
				}));
		}
		return [];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slash, at, catalog, library, skills]);
	useEffect(() => setSel(0), [items.length]);

	function attachFromLibrary(f: LibraryFile) {
		const conv = ensureConv();
		const tmp: Attachment = { path: f.id, name: f.name, state: "uploading" };
		setAttachments((a) => [...a, tmp]);
		api
			.attach(conv, f.id)
			.then((r) => setAttachments((a) => a.map((x) => (x === tmp ? { path: r.path, name: f.name, state: "ready" } : x))))
			.catch((e) => {
				setAttachments((a) => a.filter((x) => x !== tmp));
				notify(`Não consegui anexar ${f.name}: ${e.message}`);
			});
	}

	function upload(files: FileList | File[]) {
		const conv = ensureConv();
		for (const file of [...files]) {
			const tmp: Attachment = { path: file.name, name: file.name, state: "uploading" };
			setAttachments((a) => [...a, tmp]);
			api
				.upload(conv, file)
				.then((r) => setAttachments((a) => a.map((x) => (x === tmp ? { path: r.path, name: file.name, state: "ready" } : x))))
				.catch((e) => {
					setAttachments((a) => a.filter((x) => x !== tmp));
					notify(`Falha ao enviar ${file.name}: ${e.message}`);
				});
		}
	}

	useEffect(() => {
		registerDrop((f) => upload(f));
	});

	const uploading = attachments.some((a) => a.state === "uploading");
	const canSend = !busy && !uploading && (text.trim().length > 0 || attachments.length > 0);

	function submit() {
		if (!canSend) return;
		const files = attachments.filter((a) => a.state === "ready").map((a) => a.path);
		const body = [text.trim(), files.length ? `(arquivos anexados: ${files.join(", ")})` : ""].filter(Boolean).join("\n\n");
		onSend(body, skills);
		setText("");
		setSkills([]);
		setAttachments(() => []);
	}

	function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (items.length) {
			if (e.key === "ArrowDown") return e.preventDefault(), setSel((s) => (s + 1) % items.length);
			if (e.key === "ArrowUp") return e.preventDefault(), setSel((s) => (s - 1 + items.length) % items.length);
			if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), items[sel]?.pick();
			if (e.key === "Escape") return e.preventDefault(), setText((t) => t.replace(/(^\/[\w-]*|(^|\s)@[^\s@]*)$/, ""));
		}
		if (e.key === "Escape" && busy) return onStop();
		if (e.key === "Backspace" && !text && skills.length) return setSkills((k) => k.slice(0, -1));
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	}

	return (
		<div className={`composer-wrap${centered ? " centered" : ""}`}>
			<div
				className="composer"
				onPaste={(e) => {
					if (e.clipboardData.files.length) {
						e.preventDefault();
						upload(e.clipboardData.files);
					}
				}}
			>
				{items.length > 0 && (
					<div className="menu" role="listbox" aria-label={slash !== undefined ? "Skills" : "Seus arquivos"}>
						<div className="menu-title">{slash !== undefined ? "Usar uma skill" : "Anexar um dos seus arquivos"}</div>
						{items.map((it, i) => (
							<button key={it.key} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), it.pick())}>
								<span className="n">{it.title}</span>
								<span className="d">{it.detail}</span>
							</button>
						))}
					</div>
				)}
				{(skills.length > 0 || attachments.length > 0) && (
					<div className="chips">
						{skills.map((s) => (
							<span className="chip skill" key={s}>
								<span>/{s}</span>
								<button type="button" aria-label={`Remover skill ${s}`} onClick={() => setSkills((k) => k.filter((x) => x !== s))}>
									<X size={12} />
								</button>
							</span>
						))}
						{attachments.map((a) => (
							<span className="chip" key={a.path + a.name}>
								<FileText size={13} />
								<span>{a.state === "uploading" ? `Enviando ${a.name}…` : a.name}</span>
								<button type="button" aria-label={`Remover ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y !== a))}>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				<div className="composer-row">
					<button type="button" className="icon-btn" aria-label="Anexar arquivos" title="Anexar arquivos" onClick={() => fileInput.current?.click()}>
						<Paperclip size={18} />
					</button>
					<input
						ref={fileInput}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							if (e.target.files?.length) upload(e.target.files);
							e.target.value = "";
						}}
					/>
					<textarea
						ref={ta}
						rows={1}
						value={text}
						autoFocus
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKey}
						placeholder="Pergunte qualquer coisa. Use / para skills e @ para seus arquivos"
						aria-label="Mensagem"
					/>
					{busy ? (
						<button type="button" className="send-btn" aria-label="Parar" title="Parar (Esc)" onClick={onStop}>
							<Square size={14} fill="currentColor" />
						</button>
					) : (
						<button type="button" className="send-btn" aria-label="Enviar" title="Enviar (Enter)" disabled={!canSend} onClick={submit}>
							<ArrowUp size={18} />
						</button>
					)}
				</div>
			</div>
			{!centered && <div className="hint">O Assistente pode errar. Confira números e fontes antes de compartilhar.</div>}
		</div>
	);
}
