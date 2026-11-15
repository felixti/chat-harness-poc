// Company skills for the portal's "/" menu: name + description from each SKILL.md frontmatter.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

/** What each company skill does, in the users' language (SKILL.md descriptions are for the model). */
const PT: Record<string, string> = {
	pptx: "Apresentações PowerPoint com layouts e temas da empresa",
	docx: "Documentos Word: relatórios, memorandos, propostas, atas",
	pdf: "Relatórios em PDF e leitura de PDFs",
	"xlsx-csv": "Planilhas Excel e CSV: ler, analisar e gerar",
	dashboard: "Dashboards HTML interativos e one-pagers a partir de dados",
	design: "Regras visuais para qualquer entregável",
	research: "Pesquisa na web com fontes",
};

const LABEL: Record<string, string> = {
	pptx: "Apresentação", docx: "Documento Word", pdf: "PDF", "xlsx-csv": "Planilha", dashboard: "Dashboard", design: "Design", research: "Pesquisa",
};

let cache: { name: string; label: string; description: string }[] | undefined;

export async function companySkills(): Promise<{ name: string; label: string; description: string }[]> {
	if (cache) return cache;
	const out: { name: string; label: string; description: string }[] = [];
	for (const d of await readdir(config.skillsDir, { withFileTypes: true }).catch(() => [])) {
		if (!d.isDirectory()) continue;
		const md = await readFile(join(config.skillsDir, d.name, "SKILL.md"), "utf8").catch(() => "");
		const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
		const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
		const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
		if (name) out.push({ name, label: LABEL[name] ?? name, description: PT[name] ?? description ?? "" });
	}
	cache = out.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
	return cache;
}
