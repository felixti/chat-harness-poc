// Spend shown in the portal (H58): BRL, from the server's ledger.
export interface Spend {
	usd: number;
	brl: number;
	turns: number;
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

/** R$ 0,12; below one cent: "< R$ 0,01" (a short answer costs fractions of a cent). */
export const fmtBrl = (v: number) => (v > 0 && v < 0.01 ? `< ${brl.format(0.01)}` : brl.format(v));
export const fmtUsd = (v: number) => usd.format(v);
export const monthName = () => new Date().toLocaleDateString("pt-BR", { month: "long" });
