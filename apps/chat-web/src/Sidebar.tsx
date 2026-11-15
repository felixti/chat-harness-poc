import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, FolderOpen, Keyboard, ListChecks, MoreHorizontal, PanelLeft, Pencil, Plug, Search, SquarePen, Trash2 } from "lucide-react";
import { isTyping } from "./vim";
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
	onDeleteMany,
	onDrawer,
	drawer,
	selecting,
	setSelecting,
	vim,
	onShortcuts,
	searchRef,
}: {
	open: boolean;
	list: ConversationSummary[];
	current?: string;
	onToggle: () => void;
	onNew: () => void;
	onOpen: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	onDeleteMany: (ids: string[]) => Promise<unknown>;
	selecting: boolean;
	setSelecting: (v: boolean) => void;
	vim: boolean;
	onShortcuts: () => void;
	searchRef: React.RefObject<HTMLInputElement | null>;
	onDrawer: (t: DrawerTab) => void;
	drawer?: DrawerTab;
}) {
	const [q, setQ] = useState("");
	const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
	const [editing, setEditing] = useState<string>();
	const menuRef = useRef<HTMLDivElement>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [cursor, setCursor] = useState<string>();
	const anchor = useRef<string>(undefined);

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
	const visible = useMemo(() => groups.flatMap(([, items]) => items.map((c) => c.id)), [groups]);

	// Leaving selection mode clears it; entering puts the cursor on the open conversation.
	useEffect(() => {
		if (!selecting) {
			setPicked(new Set());
			setCursor(undefined);
			anchor.current = undefined;
		} else setCursor((c) => c ?? (current && visible.includes(current) ? current : visible[0]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selecting]);
	// Conversations that disappear (deleted, filtered out) leave the selection.
	useEffect(() => setPicked((p) => (p.size && [...p].some((id) => !list.some((c) => c.id === id)) ? new Set([...p].filter((id) => list.some((c) => c.id === id))) : p)), [list]);

	function toggle(id: string, range = false) {
		setPicked((p) => {
			const n = new Set(p);
			if (range && anchor.current && visible.includes(anchor.current)) {
				const [a, b] = [visible.indexOf(anchor.current), visible.indexOf(id)].sort((x, y) => x - y);
				for (const v of visible.slice(a, b + 1)) n.add(v);
			} else if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
		if (!range) anchor.current = id;
		setCursor(id);
	}
	const allPicked = visible.length > 0 && visible.every((id) => picked.has(id));

	async function deletePicked() {
		const ids = [...picked];
		if (!ids.length) return;
		if (!confirm(ids.length === 1 ? "Apagar 1 conversa e os arquivos dela? Não dá para desfazer." : `Apagar ${ids.length} conversas e os arquivos delas? Não dá para desfazer.`)) return;
		await onDeleteMany(ids);
		setSelecting(false);
	}

	// Selection keys work with or without vim mode (only outside text fields).
	const keys = useRef({ visible, cursor, toggle, deletePicked, allPicked });
	keys.current = { visible, cursor, toggle, deletePicked, allPicked };
	useEffect(() => {
		if (!selecting) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
			const k = keys.current;
			const i = k.cursor ? k.visible.indexOf(k.cursor) : -1;
			const move = (d: number) => {
				const next = k.visible[Math.max(0, Math.min(k.visible.length - 1, i + d))];
				setCursor(next);
				document.querySelector(`[data-conv="${next}"]`)?.scrollIntoView({ block: "nearest" });
			};
			const act: Record<string, () => void> = {
				Escape: () => setSelecting(false),
				j: () => move(1),
				ArrowDown: () => move(1),
				k: () => move(-1),
				ArrowUp: () => move(-1),
				x: () => k.cursor && k.toggle(k.cursor),
				" ": () => k.cursor && k.toggle(k.cursor),
				V: () => setPicked(k.allPicked ? new Set() : new Set(k.visible)),
				d: () => void k.deletePicked(),
				Delete: () => void k.deletePicked(),
			};
			if (act[e.key]) {
				e.preventDefault();
				act[e.key]();
			}
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [selecting, setSelecting]);

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
				<input
					ref={searchRef}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Buscar conversas"
					aria-label="Buscar conversas"
					onKeyDown={(e) => {
						if (e.key === "Enter" && visible[0] && !selecting) {
							onOpen(visible[0]);
							e.currentTarget.blur();
						}
						if (e.key === "Escape") {
							if (q) setQ("");
							else e.currentTarget.blur();
						}
					}}
				/>
			</div>
			{selecting && (
				<div className="select-bar" role="toolbar" aria-label="Seleção de conversas">
					<button
						type="button"
						className={`check${allPicked ? " on" : ""}`}
						role="checkbox"
						aria-checked={allPicked ? true : picked.size ? "mixed" : false}
						aria-label="Marcar todas as visíveis"
						title="Marcar todas as visíveis"
						onClick={() => setPicked(allPicked ? new Set() : new Set(visible))}
					>
						{allPicked ? <Check size={12} strokeWidth={3} /> : picked.size ? <span className="dash" /> : null}
					</button>
					<span className="n" aria-live="polite">
						{picked.size ? `${picked.size} selecionada${picked.size > 1 ? "s" : ""}` : "Nenhuma selecionada"}
					</span>
					<button type="button" className="icon-btn small danger" aria-label="Apagar selecionadas" title="Apagar selecionadas" disabled={!picked.size} onClick={() => void deletePicked()}>
						<Trash2 size={16} />
					</button>
					<button type="button" className="btn small" onClick={() => setSelecting(false)}>
						Cancelar
					</button>
				</div>
			)}
			<div className="convs">
				{!list.length && <div className="empty-side">Suas conversas aparecem aqui.</div>}
				{list.length > 0 && !groups.length && <div className="empty-side">Nenhuma conversa com “{q}”.</div>}
				{groups.map(([label, items]) => (
					<div key={label}>
						<div className="group-label">{label}</div>
						{items.map((c) => (
							<div
								key={c.id}
								data-conv={c.id}
								className={`conv${c.id === current && !selecting ? " active" : ""}${selecting ? " selecting" : ""}${picked.has(c.id) ? " picked" : ""}${selecting && cursor === c.id ? " cursor" : ""}`}
							>
								{selecting ? (
									<button
										type="button"
										className="title pick"
										role="checkbox"
										aria-checked={picked.has(c.id)}
										title={c.title}
										onClick={(e) => toggle(c.id, e.shiftKey)}
									>
										<span className={`check${picked.has(c.id) ? " on" : ""}`} aria-hidden="true">
											{picked.has(c.id) && <Check size={12} strokeWidth={3} />}
										</span>
										<span className="t">{c.title}</span>
									</button>
								) : editing === c.id ? (
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
									<button
										type="button"
										className="title"
										onClick={(e) => {
											// Ctrl/Cmd-click or Shift-click starts a multi-selection instead of opening.
											if (e.ctrlKey || e.metaKey || e.shiftKey) {
												setSelecting(true);
												setPicked(new Set([c.id]));
												anchor.current = c.id;
												setCursor(c.id);
											} else onOpen(c.id);
										}} title={c.title} aria-current={c.id === current ? "page" : undefined}>
										{c.title}
									</button>
								)}
								{!selecting && <button
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
								</button>}
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
				<button type="button" className="side-link" onClick={onShortcuts}>
					<Keyboard size={17} /> Atalhos {vim && <span className="count">vim</span>}
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
						onClick={() => {
							const id = menu.id;
							setMenu(undefined);
							setSelecting(true);
							setPicked(new Set([id]));
							anchor.current = id;
							setCursor(id);
						}}
					>
						<ListChecks size={15} /> Selecionar várias
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
