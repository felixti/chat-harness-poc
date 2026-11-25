// Charts in the reply (H70): a ```echarts block holds an ECharts option, usually built by analyze_data.
// The option comes from model text, so it is sanitized: no formatter strings (ECharts renders them as
// HTML), no links, no graphic/image elements, tooltips in rich-text mode.
import { useEffect, useRef, useState } from "react";
import { Code2, Download } from "lucide-react";
import { useTheme } from "./theme";

const DROP = new Set(["formatter", "link", "sublink", "graphic", "toolbox", "image", "backgroundImage", "rich"]);
export function sanitizeOption(v: unknown, depth = 0): unknown {
	if (depth > 12) return undefined;
	if (Array.isArray(v)) return v.slice(0, 2000).map((x) => sanitizeOption(x, depth + 1));
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = sanitizeOption(x, depth + 1);
		return out;
	}
	if (typeof v === "string") return v.startsWith("image://") ? "" : v.slice(0, 500);
	return v;
}

const PALETTE = { light: ["#1d5fd1", "#e07a1f", "#2f9e6e", "#c2417d", "#7b5cd6", "#8a8a84"], dark: ["#7aa7f5", "#f0a35e", "#5cc58a", "#e57aa8", "#a48cf0", "#a3a39e"] };

export function EChart({ source, final }: { source: string; final: boolean }) {
	const el = useRef<HTMLDivElement>(null);
	const chart = useRef<{ getDataURL: (o: object) => string; dispose: () => void; resize: () => void }>(undefined);
	const [error, setError] = useState<string>();
	const [code, setCode] = useState(false);
	const theme = useTheme();
	useEffect(() => {
		if (!final || code || !el.current) return;
		let option: Record<string, unknown>;
		try {
			option = sanitizeOption(JSON.parse(source)) as Record<string, unknown>;
		} catch {
			setError("o bloco não é JSON válido");
			return;
		}
		let gone = false;
		let ro: ResizeObserver | undefined;
		void import("echarts").then((echarts) => {
			if (gone || !el.current) return;
			const cs = getComputedStyle(document.documentElement);
			const v = (n: string) => cs.getPropertyValue(n).trim();
			const axis = { axisLine: { lineStyle: { color: v("--line") } }, axisLabel: { color: v("--fg-3") }, splitLine: { lineStyle: { color: v("--line") } } };
			const c = echarts.init(el.current, undefined, { renderer: "canvas" });
			c.setOption({
				color: PALETTE[theme === "dark" ? "dark" : "light"],
				backgroundColor: "transparent",
				textStyle: { color: v("--fg-2"), fontFamily: "inherit" },
				grid: { left: 8, right: 16, top: option.title ? 48 : 24, bottom: 8, containLabel: true },
				...option,
				title: option.title ? { ...(option.title as object), textStyle: { color: v("--fg"), fontSize: 14, fontWeight: 600 } } : undefined,
				legend: option.legend ? { ...(option.legend as object), textStyle: { color: v("--fg-2") } } : undefined,
				tooltip: { ...((option.tooltip as object) ?? {}), renderMode: "richText", backgroundColor: v("--bg-raised"), borderColor: v("--line"), textStyle: { color: v("--fg") } },
				xAxis: option.xAxis ? { ...axis, ...(option.xAxis as object) } : undefined,
				yAxis: option.yAxis ? { ...axis, ...(option.yAxis as object) } : undefined,
			});
			chart.current = c as never;
			ro = new ResizeObserver(() => c.resize());
			ro.observe(el.current);
		}, (e) => setError(String(e?.message ?? e)));
		return () => {
			gone = true;
			ro?.disconnect();
			chart.current?.dispose();
			chart.current = undefined;
		};
	}, [source, final, theme, code]);

	const png = () => {
		const url = chart.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: theme === "dark" ? "#1d1d1c" : "#ffffff" });
		if (!url) return;
		const a = document.createElement("a");
		a.href = url;
		a.download = "grafico.png";
		a.click();
	};
	return (
		<div className="block">
			<div className="block-head">
				<span className="lang ui">gráfico</span>
				<button type="button" className="act" aria-pressed={code} aria-label="Ver dados do gráfico" title="Ver dados" onClick={() => setCode((x) => !x)}>
					<Code2 size={14} />
					<span className="txt">Dados</span>
				</button>
				{!code && !error && (
					<button type="button" className="act" aria-label="Baixar PNG" title="Baixar PNG" onClick={png}>
						<Download size={14} />
						<span className="txt">PNG</span>
					</button>
				)}
			</div>
			{code || error ? (
				<>
					{error && <div className="figure pending">Não consegui desenhar: {error}</div>}
					<pre>
						<code>{source}</code>
					</pre>
				</>
			) : final ? (
				<div ref={el} className="echart" role="img" aria-label="Gráfico" />
			) : (
				<div className="figure pending">Recebendo o gráfico…</div>
			)}
		</div>
	);
}
