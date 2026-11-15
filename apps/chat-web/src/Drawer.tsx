import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Network, Paperclip, Search, X } from "lucide-react";
import { api, fileUrl, type Connector, type Fact, type FileInfo, type LibraryFile } from "./api";
import type { DrawerTab } from "./Sidebar";
import { FileCard, type CloudAction } from "./Message";

const KIND_LABELS: Record<string, string> = { person: "pessoa", team: "time", project: "projeto", company: "empresa", product: "produto", topic: "tema", document: "documento", decision: "decisão", other: "outro" };
const KIND_COLORS: Record<string, string> = { person: "#2563eb", team: "#7c3aed", project: "#059669", company: "#d97706", product: "#0891b2", topic: "#db2777", document: "#64748b", decision: "#dc2626", other: "#78716c" };

function Row({ children, sub, actions }: { children: React.ReactNode; sub?: string; actions?: React.ReactNode }) {
	return (
		<li className="row-item">
			<span className="txt">
				{children}
				{sub && <span className="sub">{sub}</span>}
			</span>
			{actions && <span className="acts">{actions}</span>}
		</li>
	);
}

function Forget({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" className="icon-btn small" aria-label={label} title={label} onClick={onClick}>
			<X size={15} />
		</button>
	);
}

function MemoryTab({ refreshKey }: { refreshKey: number }) {
	const [core, setCore] = useState<{ user: string[]; memory: string[] }>({ user: [], memory: [] });
	const [graph, setGraph] = useState<{ entities: number; facts: number; recent: Fact[] }>({ entities: 0, facts: 0, recent: [] });
	const [skills, setSkills] = useState<{ name: string; description: string; updatedAt: string }[]>([]);
	const [loaded, setLoaded] = useState(false);
	const dlg = useRef<HTMLDialogElement>(null);
	const load = useCallback(() => {
		Promise.all([api.memory().then(setCore), api.graph().then(setGraph), api.mySkills().then(setSkills)])
			.catch(() => {})
			.finally(() => setLoaded(true));
	}, []);
	useEffect(load, [load, refreshKey]);
	const empty = loaded && !core.user.length && !core.memory.length && !graph.facts && !skills.length;
	const bySubject = new Map<string, Fact[]>();
	for (const f of graph.recent.slice(0, 40)) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f]);
	return (
		<>
			{empty && <p className="muted">Nada guardado ainda. Conforme você conta sobre seu trabalho, projetos e preferências, o Assistente lembra aqui, e você pode apagar qualquer item.</p>}
			{(["user", "memory"] as const).map((t) =>
				core[t].length ? (
					<div className="section" key={t}>
						<h3>{t === "user" ? "Sobre você" : "Fatos e decisões"}</h3>
						<ul className="list">
							{core[t].map((e) => (
								<Row key={e} actions={<Forget label="Esquecer" onClick={() => api.forgetEntry(t, e).then(load)} />}>
									{e}
								</Row>
							))}
						</ul>
					</div>
				) : null,
			)}
			{graph.facts > 0 && (
				<div className="section">
					<h3>
						Relações · {graph.facts} {graph.facts === 1 ? "fato" : "fatos"}, {graph.entities} {graph.entities === 1 ? "entidade" : "entidades"}
						<button type="button" className="link-btn" onClick={() => dlg.current?.showModal()}>
							<Network size={14} style={{ verticalAlign: -2 }} /> Ver grafo
						</button>
					</h3>
					{[...bySubject].map(([subject, facts]) => (
						<div key={subject}>
							<div className="subject">{subject}</div>
							<ul className="list">
								{facts.map((f) => (
									<Row key={f.id} sub={`${f.note ? `${f.note} · ` : ""}${f.at}`} actions={<Forget label="Esquecer este fato" onClick={() => api.forgetFact(f.id).then(load)} />}>
										<span className="rel">{f.relation} → </span>
										{f.object}
									</Row>
								))}
							</ul>
						</div>
					))}
					<GraphDialog dlg={dlg} facts={graph.recent} />
				</div>
			)}
			{skills.length > 0 && (
				<div className="section">
					<h3>Procedimentos</h3>
					<p className="help">Passo a passo que você pediu para salvar. O Assistente segue quando o pedido combina.</p>
					<ul className="list">
						{skills.map((s) => (
							<Row
								key={s.name}
								sub={`${s.description} · ${s.updatedAt.slice(0, 10)}`}
								actions={<Forget label="Apagar procedimento" onClick={() => confirm(`Apagar o procedimento my-${s.name}?`) && api.removeMySkill(s.name).then(load)} />}
							>
								<strong>my-{s.name}</strong>
							</Row>
						))}
					</ul>
				</div>
			)}
			{(core.user.length > 0 || core.memory.length > 0) && (
				<button type="button" className="link-btn danger" onClick={() => confirm("Apagar tudo o que o Assistente lembra sobre você (perfil e notas)?") && api.clearMemory().then(load)}>
					Apagar perfil e notas
				</button>
			)}
		</>
	);
}

function GraphDialog({ dlg, facts }: { dlg: React.RefObject<HTMLDialogElement | null>; facts: Fact[] }) {
	const svg = useRef<SVGSVGElement>(null);
	const draw = useCallback(() => {
		const el = svg.current;
		if (!el) return;
		el.innerHTML = "";
		const W = el.clientWidth || 900, H = el.clientHeight || 600, NS = "http://www.w3.org/2000/svg";
		type N = { name: string; kind: string; x: number; y: number; vx: number; vy: number; deg: number };
		const nodes = new Map<string, N>();
		const edges: { a: N; b: N; rel: string }[] = [];
		const node = (name: string, kind?: string) => {
			if (!nodes.has(name)) nodes.set(name, { name, kind: kind ?? "other", x: 0, y: 0, vx: 0, vy: 0, deg: 0 });
			const n = nodes.get(name)!;
			if (kind) n.kind = kind;
			return n;
		};
		for (const f of facts) {
			const a = node(f.subject, f.subjectKind), b = node(f.object, f.objectKind);
			a.deg++, b.deg++;
			edges.push({ a, b, rel: f.relation });
		}
		const list = [...nodes.values()].sort((p, q) => q.deg - p.deg);
		list.forEach((p, i) => ((p.x = Math.cos(i * 2.39996) * 40 * Math.sqrt(i)), (p.y = Math.sin(i * 2.39996) * 40 * Math.sqrt(i))));
		for (let it = 0; it < 400; it++) {
			for (const p of list) for (const q of list) {
				if (p === q) continue;
				const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2), f = 9000 / d2;
				p.vx += (dx / d) * f, p.vy += (dy / d) * f;
			}
			for (const e of edges) {
				const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 190) * 0.03;
				e.a.vx += (dx / d) * f, e.a.vy += (dy / d) * f, e.b.vx -= (dx / d) * f, e.b.vy -= (dy / d) * f;
			}
			for (const p of list) (p.vx -= p.x * 0.002), (p.vy -= p.y * 0.002), (p.x += p.vx * 0.5), (p.y += p.vy * 0.5), (p.vx *= 0.6), (p.vy *= 0.6);
		}
		const xs = list.map((p) => p.x), ys = list.map((p) => p.y);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const k = Math.min((W - 200) / Math.max(x1 - x0, 1), (H - 90) / Math.max(y1 - y0, 1), 1.6);
		for (const p of list) (p.x = W / 2 + (p.x - (x0 + x1) / 2) * k), (p.y = H / 2 + (p.y - (y0 + y1) / 2) * k);
		const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
			const e = document.createElementNS(NS, tag);
			for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v));
			if (text) e.textContent = text;
			el.append(e);
		};
		for (const e of edges) {
			add("line", { x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, stroke: "currentColor", "stroke-opacity": 0.22 });
			add("text", { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 - 4, "text-anchor": "middle", "font-size": 11, fill: "currentColor", opacity: 0.65, "paint-order": "stroke", stroke: "var(--bg)", "stroke-width": 4 }, e.rel);
		}
		for (const p of list) {
			add("circle", { cx: p.x, cy: p.y, r: 6 + Math.min(p.deg, 8) * 1.5, fill: KIND_COLORS[p.kind] ?? KIND_COLORS.other, stroke: "var(--bg)", "stroke-width": 2 });
			add("text", { x: p.x, y: p.y + 24 + Math.min(p.deg, 8), "text-anchor": "middle", "font-size": 12, "font-weight": p.deg > 2 ? 600 : 400, fill: "currentColor", "paint-order": "stroke", stroke: "var(--bg)", "stroke-width": 4 }, p.name);
		}
	}, [facts]);
	const kinds = [...new Set(facts.flatMap((f) => [f.subjectKind ?? "other", f.objectKind ?? "other"]))];
	return (
		<dialog className="sheet" ref={dlg} onClose={() => {}} onToggle={(e) => (e.target as HTMLDialogElement).open && requestAnimationFrame(draw)}>
			<header>
				<strong>Grafo da memória</strong>
				<span className="legend">
					{kinds.map((k) => (
						<span key={k}>
							<i style={{ background: KIND_COLORS[k] ?? KIND_COLORS.other }} />
							{KIND_LABELS[k] ?? k}
						</span>
					))}
				</span>
				<button type="button" className="icon-btn" aria-label="Fechar" onClick={() => dlg.current?.close()}>
					<X size={18} />
				</button>
			</header>
			<div className="content">
				<svg ref={svg} role="img" aria-label="Entidades e relações lembradas" />
			</div>
		</dialog>
	);
}

function FilesTab({ conv, files, onUse, onPreview, onCloud, refreshKey }: { conv?: string; files: FileInfo[]; onUse: (f: LibraryFile) => void; onPreview: (f: FileInfo) => void; onCloud?: CloudAction; refreshKey: number }) {
	const [lib, setLib] = useState<LibraryFile[]>([]);
	const load = useCallback(() => void api.library().then(setLib).catch(() => {}), []);
	useEffect(load, [load, refreshKey]);
	const [q, setQ] = useState("");
	const [kind, setKind] = useState<"all" | "upload" | "output">("all");
	const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const all = lib.filter((f) => f.conversation !== conv);
	const terms = fold(q).split(/\s+/).filter(Boolean);
	// Every word must match the file name or the conversation title, accents ignored.
	const others = all.filter((f) => (kind === "all" || f.kind === kind) && terms.every((t) => fold(`${f.name} ${f.title ?? ""}`).includes(t)));
	const days = (iso?: string) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)) : undefined);
	return (
		<>
			{conv && files.length > 0 && (
				<div className="section">
					<h3>Nesta conversa</h3>
					<div className="files-row" style={{ marginTop: 0 }}>
						{files.map((f) => (
							<FileCard key={f.path} conv={conv} file={f} onPreview={onPreview} onCloud={onCloud} />
						))}
					</div>
				</div>
			)}
			<div className="section">
				<h3>De outras conversas</h3>
				<p className="help">Arquivos enviados e gerados nos últimos 30 dias. Sem uso por 30 dias, são apagados.</p>
				{all.length > 0 && (
					<div className="lib-tools">
						<div className="lib-search">
							<Search size={15} />
							<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou conversa" aria-label="Buscar nos seus arquivos" />
							{q && (
								<button type="button" className="icon-btn small" aria-label="Limpar busca" onClick={() => setQ("")}>
									<X size={14} />
								</button>
							)}
						</div>
						<div className="seg" role="radiogroup" aria-label="Tipo de arquivo">
							{(
								[
									["all", "Todos"],
									["upload", "Enviados"],
									["output", "Gerados"],
								] as const
							).map(([id, label]) => (
								<button key={id} type="button" role="radio" aria-checked={kind === id} onClick={() => setKind(id)}>
									{label}
								</button>
							))}
						</div>
					</div>
				)}
				{!all.length && <p className="muted">Nenhum arquivo de outras conversas.</p>}
				{all.length > 0 && !others.length && <p className="muted">Nenhum arquivo encontrado{q ? ` para “${q}”` : ""}.</p>}
				<ul className="list">
					{others.map((f) => (
						<Row
							key={f.id}
							sub={`${f.kind === "upload" ? "Enviado" : "Gerado"} ${f.modified?.slice(0, 10) ?? ""}${f.title ? ` · ${f.title}` : ""}${days(f.expiresAt) !== undefined ? ` · expira em ${days(f.expiresAt)} d` : ""}`}
							actions={
								<>
									<button type="button" className="icon-btn small" title="Usar nesta conversa" aria-label={`Usar ${f.name} nesta conversa`} onClick={() => onUse(f)}>
										<Paperclip size={15} />
									</button>
									<a className="icon-btn small" title="Baixar" aria-label={`Baixar ${f.name}`} href={fileUrl(f.conversation, f.path)}>
										<Download size={15} />
									</a>
									<Forget label="Remover arquivo" onClick={() => confirm(`Remover ${f.name}? Ele some também da conversa de origem.`) && api.removeLibraryFile(f.id).then(load)} />
								</>
							}
						>
							{f.name}
						</Row>
					))}
				</ul>
			</div>
		</>
	);
}

function ConnectorsTab() {
	const [list, setList] = useState<Connector[]>();
	const load = useCallback(() => void api.connectors().then(setList).catch(() => setList([])), []);
	useEffect(load, [load]);
	return (
		<div className="section">
			<p className="help">Conecte suas contas para o Assistente trabalhar com elas em seu nome. Você pode desconectar quando quiser.</p>
			{list && !list.length && <p className="muted">Nenhum conector disponível.</p>}
			<div style={{ display: "grid", gap: 10 }}>
				{list?.map((c) => (
					<div className="connector" key={c.id}>
						<header>
							<strong>{c.name}</strong>
							{c.connected ? (
								<button type="button" className="btn" onClick={() => confirm(`Desconectar ${c.name}? O acesso será revogado.`) && api.disconnect(c.id).then(load)}>
									Desconectar
								</button>
							) : (
								<a className="btn primary" style={{ display: "inline-grid", placeItems: "center", textDecoration: "none" }} href={`api/connectors/${c.id}/connect`}>
									Conectar
								</a>
							)}
						</header>
						<span className="muted">{c.summary}</span>
						<span className={`state${c.connected ? " on" : ""}`}>{c.connected ? `Conectado ${c.account}${c.readOnly ? " · somente leitura" : ""}` : "Não conectado"}</span>
					</div>
				))}
			</div>
		</div>
	);
}

export function Drawer({
	tab,
	setTab,
	onClose,
	conv,
	files,
	onUse,
	onPreview,
	onCloud,
	refreshKey,
}: {
	tab: DrawerTab;
	setTab: (t: DrawerTab) => void;
	onClose: () => void;
	conv?: string;
	files: FileInfo[];
	onUse: (f: LibraryFile) => void;
	onPreview: (f: FileInfo) => void;
	onCloud?: CloudAction;
	refreshKey: number;
}) {
	return (
		<aside className="drawer" aria-label="Painel">
			<div className="drawer-head">
				<div className="tabs" role="tablist">
					{(
						[
							["memory", "Memória"],
							["files", "Arquivos"],
							["connectors", "Conectores"],
						] as const
					).map(([id, label]) => (
						<button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
							{label}
						</button>
					))}
				</div>
				<button type="button" className="icon-btn" aria-label="Fechar painel" onClick={onClose}>
					<X size={18} />
				</button>
			</div>
			<div className="drawer-body" role="tabpanel">
				{tab === "memory" && <MemoryTab refreshKey={refreshKey} />}
				{tab === "files" && <FilesTab conv={conv} files={files} onUse={onUse} onPreview={onPreview} onCloud={onCloud} refreshKey={refreshKey} />}
				{tab === "connectors" && <ConnectorsTab />}
			</div>
		</aside>
	);
}
