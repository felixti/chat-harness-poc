import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Download, Eye, Maximize2, Minimize2, RotateCw, Share2, X } from "lucide-react";
import { api, type CanvasDoc, type CanvasEvent } from "./api";
import { buildCanvasPage } from "./canvasPage";
import { copyText } from "./Markdown";
import { useTheme } from "./theme";

export interface CanvasTarget {
	name: string;
	version?: number;
	/** A version saved in the running turn, delivered by the stream. */
	live?: CanvasEvent;
}


/** Side panel that runs a canvas (H52): preview / code, versions, download, persistent state. */
export function CanvasPanel({ conv, target, onClose, onSend, notify, onShare }: { conv?: string; target: CanvasTarget; onClose: () => void; onSend: (text: string) => void; notify: (t: string) => void; onShare?: (name: string, title: string) => void }) {
	const [doc, setDoc] = useState<CanvasDoc>();
	const [tab, setTab] = useState<"preview" | "code">("preview");
	const [page, setPage] = useState<{ token: string; html: string }>();
	const [wide, setWide] = useState(false);
	const [error, setError] = useState<string>();
	const [reload, setReload] = useState(0);
	const frame = useRef<HTMLIFrameElement>(null);
	const theme = useTheme();
	const state = useRef<unknown>({});
	const token = useMemo(() => crypto.randomUUID(), [doc?.name, doc?.version, reload]); // eslint-disable-line react-hooks/exhaustive-deps

	// Load: the live version from the stream, or the stored one (with the user's state).
	useEffect(() => {
		let gone = false;
		const { name, version, live } = target;
		setError(undefined);
		const stored = conv ? api.canvas(conv, name, live ? undefined : version).catch(() => undefined) : Promise.resolve(undefined);
		void stored.then((d) => {
			if (gone) return;
			if (live) {
				const versions = [...(d?.versions ?? []).filter((x) => x.v < live.version), { v: live.version, at: new Date().toISOString() }];
				setDoc({ name, title: live.title, versions, version: live.version, html: live.html, state: d?.state ?? state.current ?? {} });
			} else if (d) setDoc(d);
			else notify("Não encontrei esse canvas. Ele pode ter sido criado numa resposta interrompida.");
		});
		return () => {
			gone = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conv, target.name, target.version, target.live?.version]);

	useEffect(() => {
		if (doc) state.current = doc.state;
	}, [doc]);
	useEffect(() => {
		if (!doc) return;
		let gone = false;
		void buildCanvasPage(doc.html, { theme, state: state.current, token, title: doc.title }).then((html) => !gone && setPage({ token, html }));
		return () => {
			gone = true;
		};
	}, [doc, token, theme]);

	// Messages from the page: only from this frame, with this frame's token.
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			const d = e.data as { type?: string; token?: string; state?: unknown; text?: string; message?: string };
			if (e.source !== frame.current?.contentWindow || d?.token !== page?.token || !doc || !conv) return;
			if (d.type === "canvas:state") {
				state.current = d.state;
				api.saveCanvasState(conv, doc.name, d.state).catch(() => notify("Não consegui salvar o estado do canvas."));
			} else if (d.type === "canvas:send" && d.text) onSend(d.text);
			else if (d.type === "canvas:error") setError(d.message);
		};
		addEventListener("message", onMsg);
		return () => removeEventListener("message", onMsg);
	}, [page?.token, doc, conv, onSend, notify]);

	async function download() {
		if (!doc) return;
		const html = await buildCanvasPage(doc.html, { theme: "light", state: state.current, token: "download", title: doc.title });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
		a.download = `${doc.name}.html`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	function pickVersion(v: number) {
		if (!conv || !doc) return;
		api
			.canvas(conv, doc.name, v)
			.then((d) => setDoc({ ...d, versions: doc.versions.length > d.versions.length ? doc.versions : d.versions }))
			.catch(() => notify("Essa versão ainda está sendo salva. Tente de novo quando a resposta terminar."));
	}

	const latest = doc?.versions.at(-1)?.v;
	return (
		<aside className={`canvas-panel${wide ? " wide" : ""}`} aria-label={`Canvas: ${doc?.title ?? target.name}`}>
			<div className="canvas-head">
				<strong className="canvas-title" title={doc?.title}>
					{doc?.title ?? "Carregando…"}
				</strong>
				{doc && doc.versions.length > 1 && (
					<select className="canvas-ver" aria-label="Versão" value={doc.version} onChange={(e) => pickVersion(Number(e.target.value))}>
						{[...doc.versions].reverse().map((v) => (
							<option key={v.v} value={v.v}>
								v{v.v}
								{v.v === latest ? " (atual)" : ""}
								{v.note ? ` · ${v.note}` : ""}
							</option>
						))}
					</select>
				)}
				<span className="spacer" />
				<div className="tabs small" role="tablist" aria-label="Modo">
					<button type="button" role="tab" className="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
						<Eye size={14} /> Preview
					</button>
					<button type="button" role="tab" className="tab" aria-selected={tab === "code"} onClick={() => setTab("code")}>
						<Code2 size={14} /> Código
					</button>
				</div>
				<button type="button" className="icon-btn small" aria-label="Recarregar" title="Recarregar" onClick={() => setReload((n) => n + 1)}>
					<RotateCw size={15} />
				</button>
				{onShare && doc && !target.live && (
					<button type="button" className="icon-btn small" aria-label="Compartilhar canvas" title="Compartilhar" onClick={() => onShare(doc.name, doc.title)}>
						<Share2 size={15} />
					</button>
				)}
				<button type="button" className="icon-btn small" aria-label="Baixar HTML" title="Baixar HTML (funciona offline)" onClick={() => void download()}>
					<Download size={15} />
				</button>
				<button type="button" className="icon-btn small hide-mobile" aria-label={wide ? "Reduzir" : "Ampliar"} title={wide ? "Reduzir" : "Ampliar"} onClick={() => setWide((w) => !w)}>
					{wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
				</button>
				<button type="button" className="icon-btn small" aria-label="Fechar canvas" title="Fechar" onClick={onClose}>
					<X size={16} />
				</button>
			</div>
			{error && (
				<div className="canvas-error" role="alert">
					<span>Erro na página: {error}</span>
					<button
						type="button"
						className="btn small"
						onClick={() => {
							onSend(`O canvas "${doc?.title}" mostrou este erro: ${error}. Corrija, por favor.`);
							setError(undefined);
						}}
					>
						Pedir correção
					</button>
				</div>
			)}
			<div className="canvas-body">
				{tab === "code" ? (
					<div className="canvas-code">
						<button type="button" className="btn small copy" onClick={() => doc && copyText(doc.html).then(() => notify("Código copiado."))}>
							Copiar código
						</button>
						<pre>
							<code>{doc?.html}</code>
						</pre>
					</div>
				) : page ? (
					<iframe key={page.token} ref={frame} title={doc?.title ?? "Canvas"} sandbox="allow-scripts" srcDoc={page.html} />
				) : (
					<div className="canvas-loading running-label">Montando o canvas…</div>
				)}
			</div>
		</aside>
	);
}
