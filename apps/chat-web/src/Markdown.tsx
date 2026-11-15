// Markdown with the blocks an assistant actually produces: code (highlighted), tables (copy as
// TSV for Excel), mermaid (rendered lazily, copy code or PNG), SVG (shown as an image, never as
// live DOM), ASCII diagrams (monospace, no wrap). Raw HTML in the text is not executed.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Code2, Download, Image as ImageIcon } from "lucide-react";
import { fileUrl } from "./api";

export async function copyText(text: string) {
	await navigator.clipboard.writeText(text);
}

/** SVG markup -> PNG on the clipboard (diagrams paste straight into slides and docs). */
async function copySvgAsPng(svg: string) {
	const img = new Image();
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	await new Promise<void>((ok, fail) => {
		img.onload = () => ok();
		img.onerror = () => fail(new Error("svg"));
		img.src = url;
	});
	const scale = 2;
	const w = img.naturalWidth || 800;
	const h = img.naturalHeight || 600;
	const canvas = document.createElement("canvas");
	canvas.width = w * scale;
	canvas.height = h * scale;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	URL.revokeObjectURL(url);
	const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), "image/png"));
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function download(name: string, text: string, type: string) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([text], { type }));
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function CopyAction({ get, label = "Copiar", done = "Copiado", icon }: { get: () => Promise<void> | void; label?: string; done?: string; icon?: ReactNode }) {
	const [ok, setOk] = useState(false);
	return (
		<button
			type="button"
			className="act"
			aria-label={label}
			title={label}
			onClick={async () => {
				try {
					await get();
					setOk(true);
					setTimeout(() => setOk(false), 1400);
				} catch {
					/* clipboard refused: nothing to do */
				}
			}}
		>
			{ok ? <Check size={14} /> : (icon ?? <Copy size={14} />)}
			<span className="txt">{ok ? done : label}</span>
		</button>
	);
}

const ASCII = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▶◀▲▼→←↑↓]|[+|]-{3,}|-{3,}[+|]/;
/** Mermaid emits width="100%" and a viewBox that can be tighter than what it drew; as an <img>
 *  that collapses or clips. Measure the drawing in the page, then pin viewBox, width and height. */
function sized(svg: string): string {
	const host = document.createElement("div");
	host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
	host.innerHTML = svg;
	document.body.append(host);
	const el = host.querySelector("svg");
	try {
		if (!el) return svg;
		const b = (el as SVGGraphicsElement).getBBox();
		if (b.width > 0 && b.height > 0) {
			const pad = 8;
			el.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);
			el.setAttribute("width", String(Math.ceil(b.width + 2 * pad)));
			el.setAttribute("height", String(Math.ceil(b.height + 2 * pad)));
			el.removeAttribute("style");
		}
		if (!el.getAttribute("xmlns")) el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		return new XMLSerializer().serializeToString(el);
	} finally {
		host.remove();
	}
}

const toSvgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function Figure({ svg, source, lang }: { svg: string; source: string; lang: string }) {
	const [showCode, setShowCode] = useState(false);
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang">{lang}</span>
				<button type="button" className="act" aria-label="Ver código" title="Ver código" aria-pressed={showCode} onClick={() => setShowCode((v) => !v)}>
					<Code2 size={14} />
					<span className="txt">Código</span>
				</button>
				<CopyAction get={() => copySvgAsPng(svg)} label="Copiar imagem" icon={<ImageIcon size={14} />} />
				<CopyAction get={() => copyText(source)} label="Copiar código" />
				<button type="button" className="act" onClick={() => download(`${lang}.svg`, svg, "image/svg+xml")} aria-label="Baixar SVG">
					<Download size={14} />
				</button>
			</div>
			{showCode ? (
				<pre>
					<code>{source}</code>
				</pre>
			) : (
				<div className="figure">
					<img src={toSvgUrl(svg)} alt={`Diagrama ${lang}`} />
				</div>
			)}
		</div>
	);
}

let mermaidLoad: Promise<typeof import("mermaid").default> | undefined;
let mermaidSeq = 0;

function Mermaid({ source, final }: { source: string; final: boolean }) {
	const [svg, setSvg] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!final) return;
		let alive = true;
		mermaidLoad ??= import("mermaid").then((m) => {
			const dark = matchMedia("(prefers-color-scheme: dark)").matches;
			// htmlLabels off: labels are plain SVG text, so the diagram survives being shown as an image.
			m.default.initialize({
				startOnLoad: false,
				theme: dark ? "dark" : "neutral",
				securityLevel: "strict",
				htmlLabels: false,
				flowchart: { htmlLabels: false },
				fontFamily: "ui-sans-serif, Segoe UI, Roboto, Arial",
			} as Parameters<typeof m.default.initialize>[0]);
			return m.default;
		});
		mermaidLoad
			.then((m) => m.render(`mmd-${++mermaidSeq}`, source))
			.then((r) => alive && setSvg(sized(r.svg)))
			.catch((e) => alive && setError(String(e?.message ?? e).split("\n")[0]));
		return () => {
			alive = false;
		};
	}, [source, final]);
	if (svg) return <Figure svg={svg} source={source} lang="mermaid" />;
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang">mermaid</span>
				<CopyAction get={() => copyText(source)} label="Copiar código" />
			</div>
			{error ? (
				<pre>
					<code>{source}</code>
				</pre>
			) : (
				<div className="figure pending">{final ? "Desenhando o diagrama…" : "Recebendo o diagrama…"}</div>
			)}
			{error && <div className="figure pending">Não consegui desenhar: {error}</div>}
		</div>
	);
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
	return "";
}

function CodeBlock({ lang, source, children, final }: { lang: string; source: string; children: ReactNode; final: boolean }) {
	if (lang === "mermaid") return <Mermaid source={source} final={final} />;
	if (lang === "svg" || (lang === "xml" && source.trimStart().startsWith("<svg"))) return final ? <Figure svg={sized(source)} source={source} lang="svg" /> : <Plain lang="svg" source={source} />;
	const ascii = ["text", "ascii", "txt", "plaintext", ""].includes(lang) && ASCII.test(source);
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang">{ascii ? "diagrama" : lang || "texto"}</span>
				<CopyAction get={() => copyText(source)} />
			</div>
			<pre className={ascii ? "ascii" : undefined}>{ascii ? source : <code>{children}</code>}</pre>
		</div>
	);
}

function Plain({ lang, source }: { lang: string; source: string }) {
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang">{lang}</span>
			</div>
			<pre>
				<code>{source}</code>
			</pre>
		</div>
	);
}

function Table({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLTableElement>(null);
	const tsv = () =>
		[...(ref.current?.rows ?? [])].map((r) => [...r.cells].map((c) => c.innerText.replace(/\t|\n/g, " ").trim()).join("\t")).join("\n");
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang">tabela</span>
				<CopyAction get={() => copyText(tsv())} label="Copiar para Excel" />
			</div>
			<div className="table-wrap">
				<table ref={ref}>{children}</table>
			</div>
		</div>
	);
}

/** Workspace paths in the answer (outputs/x.png) resolve to this conversation's files. */
function resolver(conv?: string) {
	return (url: string) => {
		if (/^(https?:|data:image\/|mailto:|#)/i.test(url)) return url;
		const rel = url.replace(/^\.?\//, "");
		if (conv && /^(outputs|uploads)\//.test(rel)) return fileUrl(conv, rel, true);
		return url.startsWith("/") ? url : "";
	};
}

function MarkdownImpl({ text, conv, final }: { text: string; conv?: string; final: boolean }) {
	const components = useMemo<Components>(
		() => ({
			pre: ({ children }) => {
				const code = Array.isArray(children) ? children[0] : children;
				const props = (code as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
				const lang = /language-([\w-]+)/.exec(props.className ?? "")?.[1]?.toLowerCase() ?? "";
				const source = textOf(props.children).replace(/\n$/, "");
				return (
					<CodeBlock lang={lang} source={source} final={final}>
						{props.children}
					</CodeBlock>
				);
			},
			table: ({ children }) => <Table>{children}</Table>,
			a: ({ href, children }) => (
				<a href={href} target={href?.startsWith("api/") ? undefined : "_blank"} rel="noreferrer">
					{children}
				</a>
			),
			img: ({ src, alt }) => (src ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null),
		}),
		[final],
	);
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={resolver(conv)}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

export const Markdown = memo(MarkdownImpl);
