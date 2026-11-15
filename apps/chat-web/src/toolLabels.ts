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
	if (name.startsWith("mcp__context7__")) return "Consultando documentação técnica";
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
		default:
			return name.replace(/_/g, " ");
	}
}
