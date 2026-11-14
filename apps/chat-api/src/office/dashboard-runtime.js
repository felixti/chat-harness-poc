// Dashboard runtime: one source for the numbers. The server imports it to compute values for the
// lint and the summary; generate_dashboard inlines this file into the HTML, where the same code
// recomputes every widget when a filter changes. Plain JS, no dependencies besides the echarts
// global in the browser. Text always goes through textContent (never innerHTML).

/** Lowercase, no accents, single spaces: field names match "Região", "regiao", " REGIAO ". */
export function norm(s) {
	return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Column index by name (accent/case-insensitive), or -1. */
export function col(ds, name) {
	if (name === undefined || name === null) return -1;
	const k = norm(name);
	return ds.cols.findIndex((c) => norm(c) === k);
}

const NF = (o) => new Intl.NumberFormat("pt-BR", o);

/** pt-BR display: integer, decimal, currency (R$), percent (0.12 = 12%), compact (4,1 mi). */
export function fmt(v, f) {
	if (v === null || v === undefined || Number.isNaN(v)) return "–";
	if (typeof v !== "number") return String(v);
	switch (f) {
		case "currency":
			return Math.abs(v) >= 1e6 ? `R$ ${compact(v)}` : NF({ style: "currency", currency: "BRL", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
		case "percent":
			return NF({ style: "percent", maximumFractionDigits: 1 }).format(v);
		case "decimal":
			return NF({ minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(v);
		case "compact":
			return compact(v);
		case "integer":
			return NF({ maximumFractionDigits: 0 }).format(v);
		default:
			return Math.abs(v) >= 1e6 ? compact(v) : NF({ maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
	}
}

function compact(v) {
	const a = Math.abs(v);
	const [d, u] = a >= 1e9 ? [1e9, " bi"] : a >= 1e6 ? [1e6, " mi"] : a >= 1e3 ? [1e3, " mil"] : [1, ""];
	return NF({ maximumFractionDigits: v / d >= 100 ? 0 : 1 }).format(v / d) + u;
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** Date bucket for an ISO date string: month "2026-03", quarter "2026-T1", year "2026". */
export function bucket(v, b) {
	const m = /^(\d{4})-(\d{2})/.exec(String(v ?? ""));
	if (!b || !m) return v;
	if (b === "year") return m[1];
	if (b === "quarter") return `${m[1]}-T${Math.ceil(Number(m[2]) / 3)}`;
	return `${m[1]}-${m[2]}`;
}

/** Axis label for a bucket key: "2026-03" -> "mar/26". */
export function bucketLabel(k, b) {
	if (b === "month") {
		const m = /^(\d{4})-(\d{2})$/.exec(String(k));
		if (m) return `${MONTHS[Number(m[2]) - 1]}/${m[1].slice(2)}`;
	}
	return String(k);
}

const ISO = /^\d{4}-\d{2}-\d{2}/;

/** One condition: exact value (accent/case-insensitive); on a date column also a period
 *  ("2026", "2026-03", "2026-T1"); or a range {"from": ..., "to": ...} (inclusive). */
export function matches(v, c) {
	if (c && typeof c === "object") {
		if (typeof v === "number") return (c.from === undefined || v >= Number(c.from)) && (c.to === undefined || v <= Number(c.to));
		const s = String(v ?? "");
		return (c.from === undefined || s >= String(c.from)) && (c.to === undefined || s <= String(c.to) + "\uffff");
	}
	if (typeof v === "string" && ISO.test(v)) {
		const k = String(c);
		return /^\d{4}-T[1-4]$/.test(k) ? bucket(v, "quarter") === k : v.startsWith(k);
	}
	return norm(v) === norm(c);
}

/** Rows that match every condition: {field: value | [values] | {from, to}}; unknown fields are ignored. */
export function where(ds, rows, cond) {
	const tests = Object.entries(cond ?? {})
		.map(([f, v]) => [col(ds, f), Array.isArray(v) ? v : [v]])
		.filter(([i]) => i >= 0);
	if (!tests.length) return rows;
	return rows.filter((r) => tests.every(([i, cs]) => cs.some((c) => matches(r[i], c))));
}

/** Aggregate one field over rows: sum, avg, count, distinct, min, max. count needs no field. */
export function aggregate(ds, rows, m) {
	const agg = m.agg ?? (m.field ? "sum" : "count");
	if (agg === "count" && !m.field) return rows.length;
	const i = col(ds, m.field);
	if (i < 0) return NaN;
	const vals = rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== "");
	if (agg === "count") return vals.length;
	if (agg === "distinct") return new Set(vals.map(norm)).size;
	const nums = vals.filter((v) => typeof v === "number");
	if (!nums.length) return NaN;
	if (agg === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
	if (agg === "min") return Math.min(...nums);
	if (agg === "max") return Math.max(...nums);
	return nums.reduce((a, b) => a + b, 0);
}

function measures(w) {
	if (Array.isArray(w.y)) return w.y.map((m) => (typeof m === "string" ? { field: m, agg: w.agg } : m));
	return [{ field: w.y, agg: w.agg, label: w.y_label }];
}

const PIE = new Set(["pie", "doughnut"]);
const TIME = new Set(["line", "area"]);

/** Categories x series for a chart widget, sorted and cut to `top`. */
export function chartData(ds, rows, w) {
	const xi = col(ds, w.x);
	const ms = measures(w);
	const si = w.series ? col(ds, w.series) : -1;
	const groups = new Map();
	for (const r of rows) {
		const k = bucket(r[xi], w.x_bucket);
		if (k === null || k === undefined || k === "") continue;
		const key = String(k);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}
	let cats = [...groups.keys()];
	let series;
	if (si >= 0) {
		const names = [...new Set(rows.map((r) => String(r[si] ?? "")))].filter(Boolean);
		series = names.map((n) => ({ name: n, values: cats.map((c) => aggregate(ds, groups.get(c).filter((r) => String(r[si]) === n), ms[0])) }));
	} else {
		series = ms.map((m) => ({ name: m.label ?? m.field ?? "Quantidade", values: cats.map((c) => aggregate(ds, groups.get(c), m)) }));
	}
	const total = (i) => series.reduce((a, s) => a + (Number.isFinite(s.values[i]) ? s.values[i] : 0), 0);
	let order = cats.map((_, i) => i);
	const byX = w.sort === "x" || (w.sort === undefined && (TIME.has(w.chart) || w.x_bucket));
	if (byX) order.sort((a, b) => String(cats[a]).localeCompare(String(cats[b]), "pt-BR", { numeric: true }));
	else order.sort((a, b) => (w.sort === "asc" ? total(a) - total(b) : total(b) - total(a)));
	if (w.top && order.length > w.top) {
		const rest = order.slice(w.top);
		order = order.slice(0, w.top);
		if (PIE.has(w.chart) || w.others) {
			cats = [...order.map((i) => cats[i]), "Outros"];
			series = series.map((s) => ({ name: s.name, values: [...order.map((i) => s.values[i]), rest.reduce((a, i) => a + (Number.isFinite(s.values[i]) ? s.values[i] : 0), 0)] }));
			return { cats, labels: cats.map((c) => bucketLabel(c, w.x_bucket)), series };
		}
	}
	cats = order.map((i) => cats[i]);
	series = series.map((s) => ({ name: s.name, values: order.map((i) => s.values[i]) }));
	return { cats, labels: cats.map((c) => bucketLabel(c, w.x_bucket)), series };
}

/** Table rows: raw columns, or grouped by `group_by` with each numeric column aggregated. */
export function tableData(ds, rows, w) {
	const cols = (w.columns ?? ds.cols).map((c) => (typeof c === "string" ? { field: c } : c));
	let body;
	if (w.group_by) {
		const gi = col(ds, w.group_by);
		const groups = new Map();
		for (const r of rows) {
			const k = String(r[gi] ?? "");
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(r);
		}
		body = [...groups.entries()].map(([k, rs]) => cols.map((c) => (norm(c.field) === norm(w.group_by) ? k : aggregate(ds, rs, { field: c.field, agg: c.agg ?? "sum" }))));
	} else {
		body = rows.map((r) => cols.map((c) => r[col(ds, c.field)]));
	}
	const si = w.sort ? cols.findIndex((c) => norm(c.field) === norm(w.sort.by ?? w.sort)) : -1;
	if (si >= 0) {
		const desc = w.sort.desc !== false;
		body.sort((a, b) => {
			const x = a[si], y = b[si];
			const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pt-BR", { numeric: true });
			return desc ? -d : d;
		});
	}
	const total = body.length;
	if (w.top) body = body.slice(0, w.top);
	return { head: cols.map((c) => c.label ?? c.field), formats: cols.map((c) => c.format), rows: body, total };
}

/** Value (and delta vs `compare`) for a KPI widget. */
export function kpiData(ds, rows, w) {
	if (w.value !== undefined && !w.field && w.agg !== "count") return { value: w.value, literal: true };
	const m = { field: w.field, agg: w.agg };
	const value = aggregate(ds, where(ds, rows, w.where), m);
	if (!w.compare) return { value };
	const base = aggregate(ds, where(ds, rows, { ...w.where, ...w.compare.where }), m);
	return { value, base, delta: base ? (value - base) / Math.abs(base) : NaN };
}

/** Rows of a dataset after the active filters (only filters whose field the dataset has). */
export function filtered(ds, active) {
	return where(ds, ds.rows, Object.fromEntries(Object.entries(active ?? {}).filter(([f, v]) => v !== "" && col(ds, f) >= 0)));
}

// ---------- browser only ----------

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = String(text);
	return e;
}

/** Tiny markdown: paragraphs, "- " bullets, **bold**. */
function rich(parent, text) {
	let list = null;
	for (const line of String(text ?? "").split("\n")) {
		const bullet = /^\s*[-•]\s+/.test(line);
		const host = bullet ? (list ??= parent.appendChild(el("ul"))) : ((list = null), line.trim() ? parent.appendChild(el("p")) : null);
		if (!host) continue;
		const target = bullet ? host.appendChild(el("li")) : host;
		line.replace(/^\s*[-•]\s+/, "").split(/(\*\*[^*]+\*\*)/).forEach((part) => {
			if (part) target.appendChild(part.startsWith("**") ? el("strong", "", part.slice(2, -2)) : document.createTextNode(part));
		});
	}
}

function tint(hex, k, toward) {
	const a = parseInt(hex, 16), b = parseInt(toward, 16);
	return [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k).toString(16).padStart(2, "0")).join("");
}

export function chartOption(w, d, t) {
	const c = (h) => `#${h}`;
	const font = { fontFamily: t.bodyFont + ", Segoe UI, system-ui, sans-serif", color: c(t.muted) };
	const f = (v) => fmt(v, w.format);
	const single = d.series.length === 1;
	const hiIdx = w.highlight === undefined ? -1 : typeof w.highlight === "number" ? w.highlight : d.cats.findIndex((x) => norm(x) === norm(w.highlight));
	const colorAt = (si, i) => (single && hiIdx >= 0 ? (i === hiIdx ? c(t.accent) : c(tint(t.muted, 0.55, t.bg))) : c(t.chart[si % t.chart.length]));
	const base = {
		textStyle: font,
		animation: false, // prints and screenshots must never catch a half-drawn chart
		color: t.chart.map(c),
		tooltip: { trigger: PIE.has(w.chart) ? "item" : "axis", valueFormatter: f, textStyle: { fontFamily: font.fontFamily } },
		legend: single && !PIE.has(w.chart) ? undefined : { top: 0, type: "scroll", textStyle: font },
	};
	if (PIE.has(w.chart)) {
		return {
			...base,
			series: [{
				type: "pie",
				radius: w.chart === "doughnut" ? ["48%", "72%"] : "72%",
				top: 24,
				itemStyle: { borderColor: c(t.bg), borderWidth: 2 },
				// Names live in the legend; slices carry only the share, so narrow cards never cut labels.
				label: { formatter: (p) => fmt(p.percent / 100, "percent"), color: c(t.ink), fontFamily: font.fontFamily },
				labelLine: { length: 6, length2: 6 },
				data: d.labels.map((name, i) => ({ name, value: d.series[0].values[i], itemStyle: hiIdx >= 0 ? { color: colorAt(0, i) } : undefined })),
			}],
		};
	}
	const horizontal = w.chart === "bar" || w.chart === "stacked_bar";
	const stacked = w.chart.startsWith("stacked");
	const cat = { type: "category", data: d.labels, axisLine: { lineStyle: { color: c(t.line) } }, axisTick: { show: false }, axisLabel: { color: c(t.muted), hideOverlap: true }, inverse: horizontal };
	const val = { type: "value", splitLine: { lineStyle: { color: c(t.line), opacity: 0.6 } }, axisLabel: { color: c(t.muted), formatter: (v) => fmt(v, w.format === "percent" ? "percent" : "compact") } };
	const showLabels = single && d.cats.length <= 12 && !TIME.has(w.chart);
	return {
		...base,
		grid: { left: 8, right: horizontal ? 56 : 16, top: single ? 16 : 36, bottom: 8, containLabel: true },
		xAxis: horizontal ? val : cat,
		yAxis: horizontal ? cat : val,
		series: d.series.map((s, si) => ({
			type: TIME.has(w.chart) ? "line" : "bar",
			name: s.name,
			stack: stacked ? "total" : undefined,
			areaStyle: w.chart === "area" ? { opacity: 0.18 } : undefined,
			showSymbol: d.cats.length <= 12,
			symbolSize: 6,
			barMaxWidth: 36,
			lineStyle: TIME.has(w.chart) ? { width: 2.5 } : undefined,
			label: showLabels ? { show: true, position: horizontal ? "right" : "top", formatter: (p) => f(p.value), color: c(t.ink) } : undefined,
			data: s.values.map((v, i) => ({ value: Number.isFinite(v) ? v : null, itemStyle: { color: colorAt(si, i) } })),
		})),
	};
}

/** Builds the page inside #app and wires the filters. */
export function mount(spec, data, t) {
	const app = document.getElementById("app");
	const charts = [];
	const active = {};
	const ds = (name) => data[name ?? Object.keys(data)[0]];
	const header = app.appendChild(el("header"));
	header.appendChild(el("h1", "", spec.title));
	if (spec.subtitle) header.appendChild(el("p", "sub", spec.subtitle));
	const meta = [spec.author, spec.date].filter(Boolean).join("  ·  ");
	if (meta) header.appendChild(el("p", "meta", meta));
	if (spec.filters?.length) {
		const bar = header.appendChild(el("div", "filters"));
		for (const fl of spec.filters) {
			const values = new Set();
			for (const d of Object.values(data)) {
				const i = col(d, fl.field);
				if (i >= 0) for (const r of d.rows) if (r[i] !== null && r[i] !== "") values.add(String(bucket(r[i], fl.bucket)));
			}
			const label = bar.appendChild(el("label", "", fl.label ?? fl.field));
			const sel = label.appendChild(el("select"));
			sel.appendChild(el("option", "", "Todos")).value = "";
			[...values].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true })).forEach((v) => (sel.appendChild(el("option", "", bucketLabel(v, fl.bucket))).value = v));
			if (fl.default !== undefined) sel.value = String(fl.default);
			active[fl.field] = sel.value;
			sel.addEventListener("change", () => {
				active[fl.field] = sel.value;
				render();
			});
		}
		bar.appendChild(el("span", "print-only", ""));
	}
	const grid = app.appendChild(el("main", "grid"));
	const slots = [];
	for (const sec of spec.sections ?? [{ items: spec.items ?? [] }]) {
		if (sec.title) grid.appendChild(el("h2", "section", sec.title));
		for (const w of sec.items ?? []) {
			const box = grid.appendChild(el("section", `w w-${w.type} span-${w.span ?? (w.type === "kpi" ? 1 : w.type === "table" ? 4 : 2)}`));
			if (w.title && w.type !== "kpi") box.appendChild(el("h3", "", w.title));
			const body = box.appendChild(el("div", "body"));
			if (w.type === "chart") {
				const inst = echarts.init(body, null, { renderer: "svg" });
				charts.push(inst);
				slots.push({ w, body, inst });
			} else slots.push({ w, body });
			if (w.note) box.appendChild(el("p", "note", w.note));
		}
	}
	const foot = app.appendChild(el("footer"));
	if (spec.source) foot.appendChild(el("span", "", `Fonte: ${String(spec.source).replace(/^\s*(fontes?|sources?)\s*:\s*/i, "")}`));
	foot.appendChild(el("span", "", `Gerado em ${new Date(spec.generated ?? Date.now()).toLocaleDateString("pt-BR")}`));

	function render() {
		const printLine = document.querySelector(".print-only");
		if (printLine) printLine.textContent = Object.entries(active).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ") || "Todos os dados";
		for (const s of slots) {
			const d = ds(s.w.data);
			if (s.w.type === "text") {
				s.body.replaceChildren();
				rich(s.body, s.w.text);
				continue;
			}
			const rows = filtered(d, active);
			if (s.w.type === "kpi") {
				const k = kpiData(d, rows, s.w);
				s.body.replaceChildren();
				s.body.appendChild(el("div", "label", s.w.label ?? s.w.title ?? ""));
				s.body.appendChild(el("div", "value", k.literal ? k.value : fmt(k.value, s.w.format ?? "compact")));
				if (Number.isFinite(k.delta)) {
					const up = k.delta >= 0;
					const good = (s.w.good ?? "up") === "up" ? up : !up;
					s.body.appendChild(el("div", `delta ${good ? "good" : "bad"}`, `${up ? "▲" : "▼"} ${fmt(Math.abs(k.delta), "percent")} ${s.w.compare.label ?? ""}`));
				} else if (s.w.caption) s.body.appendChild(el("div", "delta", s.w.caption));
			} else if (s.w.type === "chart") {
				const cd = chartData(d, where(d, rows, s.w.where), s.w);
				s.inst.setOption(chartOption(s.w, cd, t), true);
			} else if (s.w.type === "table") {
				const td = tableData(d, where(d, rows, s.w.where), s.w);
				const table = el("table");
				const tr = table.appendChild(el("thead")).appendChild(el("tr"));
				td.head.forEach((h, i) => tr.appendChild(el("th", typeof td.rows[0]?.[i] === "number" ? "num" : "", h)));
				const tb = table.appendChild(el("tbody"));
				td.rows.forEach((r, ri) => {
					const row = tb.appendChild(el("tr", s.w.highlight_row === ri ? "hi" : ""));
					r.forEach((v, i) => row.appendChild(el("td", typeof v === "number" ? "num" : "", fmt(v, td.formats[i]))));
				});
				s.body.replaceChildren(table);
				if (td.total > td.rows.length) s.body.appendChild(el("p", "note", `Mostrando ${td.rows.length} de ${td.total} linhas`));
			}
		}
	}
	render();
	const resize = () => charts.forEach((c) => c.resize());
	window.addEventListener("resize", resize);
	// Print has another width than the screen: redraw the charts for it and back.
	window.addEventListener("beforeprint", resize);
	window.addEventListener("afterprint", resize);
	window.matchMedia?.("print").addEventListener?.("change", resize);
}
