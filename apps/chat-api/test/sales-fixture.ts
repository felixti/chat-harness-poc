// Deterministic sales workbook for dashboard tests: a title row above the header, real dates,
// 3,000 rows over 2025-2026 (2026 runs to October).
import ExcelJS from "exceljs";

export async function writeSalesWorkbook(path: string, rows = 3000): Promise<void> {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("Vendas");
	ws.addRow(["Relatório de vendas 2025-2026 (fonte: ERP)"]);
	ws.addRow([]);
	ws.addRow(["Data", "Região", "Produto", "Canal", "Receita (R$)", "Unidades"]);
	const reg = ["Sudeste", "Sul", "Nordeste", "Centro-Oeste", "Norte"];
	const weights = [0.45, 0.2, 0.18, 0.1, 0.07];
	const prod = ["Plano Básico", "Plano Pro", "Plano Enterprise", "Add-on IA", "Suporte Premium", "Treinamento", "Consultoria"];
	const canal = ["Online", "Parceiros", "Inside sales"];
	let seed = 7;
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const pick = (a: string[], w?: number[]) => {
		if (!w) return a[Math.floor(rnd() * a.length)];
		let r = rnd();
		for (let i = 0; i < a.length; i++) if ((r -= w[i]) <= 0) return a[i];
		return a[0];
	};
	for (let i = 0; i < rows; i++) {
		const y = rnd() < 0.5 ? 2025 : 2026;
		const m = Math.floor(rnd() * (y === 2026 ? 10 : 12));
		const p = pick(prod);
		const base = p.includes("Enterprise") ? 9000 : p.includes("Pro") ? 2500 : p.includes("Consultoria") ? 6000 : 800;
		const u = 1 + Math.floor(rnd() * 5);
		const revenue = Math.round(base * u * (y === 2026 ? 1.15 : 1) * (0.7 + rnd() * 0.6) * 100) / 100;
		ws.addRow([new Date(Date.UTC(y, m, 1 + Math.floor(rnd() * 27))), pick(reg, weights), p, pick(canal), revenue, u]);
	}
	await wb.xlsx.writeFile(path);
}
