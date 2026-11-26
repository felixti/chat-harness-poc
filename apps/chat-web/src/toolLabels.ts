// Plain-language labels for tool steps. The technical name stays one click away.
const base = (p: unknown) => (typeof p === "string" ? p.split("/").pop() ?? p : "");

export function toolLabel(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const file = base(a.path ?? a.source ?? a.output ?? a.file_id);
	if (name.startsWith("mcp__brave__")) {
		if (name.includes("news")) return `Buscando notícias${a.query ? `: ${a.query}` : ""}`;
		if (name.includes("llm_context")) return "Lendo páginas da web";
		return `Pesquisando na web${a.query ? `: ${a.query}` : ""}`;
	}
	if (name.startsWith("mcp__github__")) return "Consultando o GitHub";
	if (name.startsWith("mcp__azuredevops__")) return azdoLabel(name);
	if (name.startsWith("mcp__context7__")) return "Consultando documentação técnica";
	if (name.startsWith("mcp__crawlforge__")) return crawlLabel(name, a);
	if (name.startsWith("mcp__")) return `Usando ${name.split("__")[1] ?? "um conector"}`;
	switch (name) {
		case "read":
			return file.endsWith("SKILL.md") ? "Lendo as instruções da skill" : `Lendo ${file}`;
		case "write":
		case "edit":
			return `Escrevendo ${file}`;
		case "ls":
			return "Listando arquivos";
		case "bash":
			return "Processando os dados";
		case "parse_document":
			return `Lendo ${file}`;
		case "tool_search":
			return "Procurando a ferramenta certa";
		case "describe_data":
			return `Analisando ${file}`;
		case "query_data":
			return "Consultando os dados";
		case "schedule_task":
			return "Agendando a tarefa";
		case "start_research":
			return "Iniciando a pesquisa aprofundada";
		case "analyze_data":
			return (args as { sql?: string } | undefined)?.sql ? "Consultando os dados com SQL" : "Vendo as tabelas disponíveis";
		case "generate_pptx":
			return "Montando a apresentação";
		case "generate_docx":
			return "Gerando o documento Word";
		case "generate_xlsx":
			return "Gerando a planilha";
		case "generate_pdf":
			return "Gerando o PDF";
		case "generate_dashboard":
			return "Montando o dashboard";
		case "generate_image":
			return "Criando uma imagem";
		case "memory":
			return "Atualizando a memória";
		case "remember":
			return "Guardando um fato";
		case "recall":
			return `Consultando a memória${a.about ? `: ${a.about}` : ""}`;
		case "forget":
			return "Esquecendo um fato";
		case "session_search":
			return "Buscando conversas anteriores";
		case "skill_save":
			return "Salvando o procedimento";
		case "skill_delete":
			return "Apagando um procedimento";
		case "my_files":
			return "Procurando nos seus arquivos";
		case "attach_file":
			return `Anexando ${file}`;
		case "plan":
			return "Atualizando o plano";
		case "show_ui":
			return `Montando o formulário${a.title ? `: ${a.title}` : ""}`;
		case "canvas":
			return a.action === "read" ? "Lendo o canvas" : a.action === "create" ? `Criando o canvas${a.title ? `: ${a.title}` : ""}` : "Ajustando o canvas";
		default:
			return name.replace(/_/g, " ");
	}
}

/** Past tense for a finished turn's summary ("Consultou a memória, Gerou a planilha · 3 etapas"). */
export function toolDone(name: string): string {
	if (name.startsWith("mcp__brave__")) return name.includes("llm_context") ? "Leu páginas da web" : "Pesquisou na web";
	if (name.startsWith("mcp__github__")) return "Consultou o GitHub";
	if (name.startsWith("mcp__azuredevops__")) return "Consultou o Azure DevOps";
	if (name.startsWith("mcp__context7__")) return "Consultou documentação";
	if (name.startsWith("mcp__crawlforge__")) return name.endsWith("scrape") || name.endsWith("extract") ? "Leu páginas da web" : name.endsWith("search") ? "Pesquisou na web" : "Pesquisou a fundo na web";
	if (name.startsWith("mcp__")) return "Usou um conector";
	const DONE: Record<string, string> = {
		read: "Leu arquivos", write: "Escreveu arquivos", edit: "Editou arquivos", ls: "Listou arquivos", bash: "Processou os dados",
		parse_document: "Leu o documento", tool_search: "Escolheu as ferramentas", describe_data: "Analisou os dados", query_data: "Consultou os dados", analyze_data: "Analisou os dados com SQL", schedule_task: "Agendou a tarefa", start_research: "Iniciou a pesquisa aprofundada",
		generate_pptx: "Montou a apresentação", generate_docx: "Gerou o documento Word", generate_xlsx: "Gerou a planilha", generate_pdf: "Gerou o PDF",
		generate_dashboard: "Montou o dashboard", generate_image: "Criou uma imagem", memory: "Atualizou a memória", remember: "Guardou um fato",
		recall: "Consultou a memória", forget: "Esqueceu um fato", session_search: "Buscou conversas anteriores", skill_save: "Salvou o procedimento",
		skill_delete: "Apagou um procedimento", my_files: "Procurou nos seus arquivos", attach_file: "Anexou um arquivo", canvas: "Montou o canvas", plan: "Planejou", show_ui: "Mostrou um formulário",
	};
	return DONE[name] ?? name.replace(/_/g, " ");
}

function azdoLabel(name: string): string {
	const t = name.slice("mcp__azuredevops__".length);
	if (t.startsWith("wit") || t === "search_workitem") return "Consultando work items no Azure DevOps";
	if (t.startsWith("repo") || t === "search_code") return "Consultando repositórios no Azure DevOps";
	if (t.startsWith("pipelines")) return "Consultando pipelines no Azure DevOps";
	if (t.startsWith("wiki") || t === "search_wiki") return "Consultando a wiki no Azure DevOps";
	if (t.startsWith("work")) return "Consultando sprints no Azure DevOps";
	if (t.startsWith("testplan")) return "Consultando planos de teste no Azure DevOps";
	return "Consultando o Azure DevOps";
}

function crawlLabel(name: string, a: Record<string, unknown>): string {
	const host = typeof a.url === "string" ? (a.url.match(/^https?:\/\/([^/]+)/)?.[1] ?? a.url) : "";
	const q = typeof a.query === "string" ? `: ${a.query}` : "";
	if (name.endsWith("scrape")) return `Lendo ${host || "a página"}`;
	if (name.endsWith("extract")) return `Extraindo dados de ${host || "a página"}`;
	if (name.endsWith("memory_search")) return `Buscando nas páginas já lidas${q}`;
	if (name.endsWith("search")) return `Pesquisando na web${q}`;
	if (name.endsWith("ask")) return `Pesquisando e respondendo${q}`;
	return `Pesquisando a fundo${q}`; // agent_run, research
}
