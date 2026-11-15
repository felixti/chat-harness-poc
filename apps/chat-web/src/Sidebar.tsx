import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, FolderOpen, MoreHorizontal, PanelLeft, Pencil, Plug, Search, SquarePen, Trash2 } from "lucide-react";
import type { ConversationSummary } from "./api";

export type DrawerTab = "memory" | "files" | "connectors";

const DAY = 86_400_000;
function groupOf(iso: string): string {
	const d = new Date(iso);
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	if (+d >= +start) return "Hoje";
	if (+d >= +start - DAY) return "Ontem";
	if (+d >= +start - 7 * DAY) return "Últimos 7 dias";
	if (+d >= +start - 30 * DAY) return "Últimos 30 dias";
	return "Anteriores";
}

export function Sidebar({
	open,
	list,
	current,
	onToggle,
	onNew,
	onOpen,
	onRename,
	onDelete,
	onDrawer,
	drawer,
}: {
	open: boolean;
	list: ConversationSummary[];
	current?: string;
	onToggle: () => void;
	onNew: () => void;
	onOpen: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	onDrawer: (t: DrawerTab) => void;
	drawer?: DrawerTab;
}) {
	const [q, setQ] = useState("");
	const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
	const [editing, setEditing] = useState<string>();
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu) return;
		const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(undefined);
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(undefined);
		addEventListener("mousedown", close);
		addEventListener("keydown", esc);
		return () => (removeEventListener("mousedown", close), removeEventListener("keydown", esc));
	}, [menu]);

	const groups = useMemo(() => {
		const f = q.trim().toLowerCase();
		const out = new Map<string, ConversationSummary[]>();
		for (const c of list) {
			if (f && !c.title.toLowerCase().includes(f)) continue;
			const g = groupOf(c.updatedAt);
			out.set(g, [...(out.get(g) ?? []), c]);
		}
		return [...out];
	}, [list, q]);

	return (
		<nav className={`side${open ? "" : " closed"}`} aria-label="Conversas" aria-hidden={!open}>
			<div className="side-top">
				<span className="brand">Assistente</span>
				<div>
					<button type="button" className="icon-btn" aria-label="Fechar barra lateral" title="Fechar barra lateral" onClick={onToggle}>
						<PanelLeft size={18} />
					</button>
					<button type="button" className="icon-btn" aria-label="Nova conversa" title="Nova conversa" onClick={onNew}>
						<SquarePen size={18} />
					</button>
				</div>
			</div>
			<div className="side-search">
				<Search size={15} />
				<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversas" aria-label="Buscar conversas" />
			</div>
			<div className="convs">
				{!list.length && <div className="empty-side">Suas conversas aparecem aqui.</div>}
				{list.length > 0 && !groups.length && <div className="empty-side">Nenhuma conversa com “{q}”.</div>}
				{groups.map(([label, items]) => (
					<div key={label}>
						<div className="group-label">{label}</div>
						{items.map((c) => (
							<div key={c.id} className={`conv${c.id === current ? " active" : ""}`}>
								{editing === c.id ? (
									<input
										autoFocus
										defaultValue={c.title}
										aria-label="Novo título"
										onBlur={(e) => {
											setEditing(undefined);
											if (e.target.value.trim() && e.target.value.trim() !== c.title) onRename(c.id, e.target.value.trim());
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
											if (e.key === "Escape") setEditing(undefined);
										}}
									/>
								) : (
									<button type="button" className="title" onClick={() => onOpen(c.id)} title={c.title} aria-current={c.id === current ? "page" : undefined}>
										{c.title}
									</button>
								)}
								<button
									type="button"
									className="icon-btn small menu-btn"
									aria-label={`Opções de ${c.title}`}
									aria-expanded={menu?.id === c.id}
									onClick={(e) => {
										const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
										setMenu({ id: c.id, x: r.left, y: r.bottom + 4 });
									}}
								>
									<MoreHorizontal size={16} />
								</button>
							</div>
						))}
					</div>
				))}
			</div>
			<div className="side-foot">
				<button type="button" className="side-link" aria-pressed={drawer === "memory"} onClick={() => onDrawer("memory")}>
					<Brain size={17} /> Memória
				</button>
				<button type="button" className="side-link" aria-pressed={drawer === "files"} onClick={() => onDrawer("files")}>
					<FolderOpen size={17} /> Meus arquivos
				</button>
				<button type="button" className="side-link" aria-pressed={drawer === "connectors"} onClick={() => onDrawer("connectors")}>
					<Plug size={17} /> Conectores
				</button>
			</div>
			{menu && (
				<div className="popover" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="menu">
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setEditing(menu.id);
							setMenu(undefined);
						}}
					>
						<Pencil size={15} /> Renomear
					</button>
					<button
						type="button"
						role="menuitem"
						className="danger"
						onClick={() => {
							const id = menu.id;
							setMenu(undefined);
							if (confirm("Apagar esta conversa e os arquivos dela? Não dá para desfazer.")) onDelete(id);
						}}
					>
						<Trash2 size={15} /> Apagar
					</button>
				</div>
			)}
		</nav>
	);
}
