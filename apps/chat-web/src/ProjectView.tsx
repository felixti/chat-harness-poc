// Project page (H71): instructions and reference files shared by the project's conversations,
// the composer that starts a new conversation in it, and its conversation list.
import { useEffect, useRef, useState } from "react";
import { FileText, Folder, MessageSquare, MoreHorizontal, Trash2, Upload, X } from "lucide-react";
import { api, type ConversationSummary, type ProjectDetail } from "./api";

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function ProjectView({
	id,
	conversations,
	composer,
	onOpen,
	onChanged,
	onDeleted,
	notify,
}: {
	id: string;
	conversations: ConversationSummary[];
	composer: React.ReactNode;
	onOpen: (id: string) => void;
	/** Name changed: refresh the sidebar. */
	onChanged: () => void;
	onDeleted: () => void;
	notify: (t: string) => void;
}) {
	const [p, setP] = useState<ProjectDetail>();
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState(0);
	const [menu, setMenu] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setP(undefined);
		api
			.project(id)
			.then((d) => {
				setP(d);
				setDraft(d.instructions);
			})
			.catch(() => notify("Não consegui abrir o projeto."));
	}, [id, notify]);

	if (!p) return <div className="project-page" aria-busy="true" />;
	const dirty = draft !== p.instructions;
	const used = p.files.reduce((s, f) => s + f.size, 0);

	async function saveInstructions() {
		if (!p || !dirty) return;
		setSaving(true);
		try {
			const r = await api.updateProject(p.id, { instructions: draft });
			setP({ ...p, instructions: r.instructions });
			notify("Instruções salvas. Valem a partir da próxima mensagem.");
		} catch (e) {
			notify(`Não consegui salvar: ${(e as Error).message}`);
		} finally {
			setSaving(false);
		}
	}

	async function rename(name: string) {
		if (!p || !name.trim() || name.trim() === p.name) return;
		try {
			const r = await api.updateProject(p.id, { name });
			setP({ ...p, name: r.name });
			onChanged();
		} catch (e) {
			notify(`Não consegui renomear: ${(e as Error).message}`);
		}
	}

	async function upload(list: FileList | null) {
		if (!p || !list?.length) return;
		setUploading(list.length);
		for (const f of Array.from(list)) {
			try {
				await api.addProjectFile(p.id, f);
			} catch (e) {
				notify(`${f.name}: ${(e as Error).message}`);
			}
			setUploading((n) => n - 1);
		}
		const d = await api.project(p.id).catch(() => undefined);
		if (d) setP({ ...d, instructions: p.instructions });
	}

	async function removeFile(name: string) {
		if (!p || !confirm(`Remover ${name} do projeto?`)) return;
		await api.removeProjectFile(p.id, name).catch((e) => notify(`Não consegui remover: ${(e as Error).message}`));
		setP({ ...p, files: p.files.filter((f) => f.name !== name) });
	}

	async function remove() {
		setMenu(false);
		if (!p || !confirm(`Apagar o projeto “${p.name}” e os arquivos dele? As conversas continuam, fora do projeto.`)) return;
		await api.deleteProject(p.id);
		notify("Projeto apagado.");
		onDeleted();
	}

	return (
		<div className="project-page">
			<div className="project-inner">
				<header className="project-head">
					<Folder size={22} aria-hidden="true" />
					<input key={p.id + p.name} className="project-name" defaultValue={p.name} maxLength={p.limits.name} aria-label="Nome do projeto" onBlur={(e) => void rename(e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
					<div style={{ position: "relative" }}>
						<button type="button" className="icon-btn" aria-label="Opções do projeto" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
							<MoreHorizontal size={18} />
						</button>
						{menu && (
							<div className="popover" role="menu" style={{ right: 0, top: 40 }}>
								<button type="button" role="menuitem" className="danger" onClick={() => void remove()}>
									<Trash2 size={15} /> Apagar projeto
								</button>
							</div>
						)}
					</div>
				</header>
				{composer}
				<div className="project-cards">
					<section className="project-card" aria-labelledby="pi-h">
						<h2 id="pi-h">Instruções</h2>
						<p className="hint">Como o assistente deve trabalhar neste projeto: público, tom, formato, o que evitar.</p>
						<textarea
							value={draft}
							maxLength={p.limits.instructions}
							rows={6}
							placeholder="Ex.: Os relatórios são para a diretoria financeira. Use R$, tabelas curtas e cite a planilha de origem."
							onChange={(e) => setDraft(e.target.value)}
							onBlur={() => void saveInstructions()}
						/>
						<div className="project-card-foot">
							<span className="hint">
								{draft.length}/{p.limits.instructions}
							</span>
							{dirty && (
								<button type="button" className="btn small primary" disabled={saving} onClick={() => void saveInstructions()}>
									{saving ? "Salvando…" : "Salvar"}
								</button>
							)}
						</div>
					</section>
					<section className="project-card" aria-labelledby="pf-h">
						<h2 id="pf-h">Arquivos</h2>
						<p className="hint">Todas as conversas do projeto podem ler estes arquivos.</p>
						<ul className="project-files">
							{p.files.map((f) => (
								<li key={f.name}>
									<FileText size={15} aria-hidden="true" />
									<span className="t" title={f.name}>
										{f.name}
									</span>
									<span className="hint">{kb(f.size)}</span>
									<button type="button" className="icon-btn small" aria-label={`Remover ${f.name}`} onClick={() => void removeFile(f.name)}>
										<X size={14} />
									</button>
								</li>
							))}
							{!p.files.length && <li className="hint">Nenhum arquivo ainda.</li>}
						</ul>
						<div className="project-card-foot">
							<span className="hint">
								{p.files.length}/{p.limits.files} · {kb(used)} de {kb(p.limits.totalBytes)}
							</span>
							<button type="button" className="btn small" disabled={uploading > 0 || p.files.length >= p.limits.files} onClick={() => input.current?.click()}>
								<Upload size={14} style={{ verticalAlign: -2 }} /> {uploading ? `Enviando ${uploading}…` : "Adicionar"}
							</button>
							<input ref={input} type="file" multiple hidden onChange={(e) => (void upload(e.target.files), (e.target.value = ""))} />
						</div>
					</section>
				</div>
				<section aria-labelledby="pc-h">
					<h2 id="pc-h" className="group-label" style={{ padding: "8px 0" }}>
						Conversas do projeto
					</h2>
					{conversations.length ? (
						<ul className="project-convs">
							{conversations.map((c) => (
								<li key={c.id}>
									<button type="button" onClick={() => onOpen(c.id)}>
										<MessageSquare size={15} aria-hidden="true" />
										<span className="t">{c.title}</span>
										<span className="hint">{new Date(c.updatedAt).toLocaleDateString("pt-BR")}</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="hint">As conversas que você começar aqui aparecem nesta lista.</p>
					)}
				</section>
			</div>
		</div>
	);
}
