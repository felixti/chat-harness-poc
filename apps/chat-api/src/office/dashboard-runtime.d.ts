// Types for the plain-JS runtime that is also inlined into the dashboard HTML.
export interface Dataset {
	cols: string[];
	rows: unknown[][];
}
export function norm(s: unknown): string;
export function col(ds: Dataset, name: unknown): number;
export function fmt(v: unknown, f?: string): string;
export function bucket(v: unknown, b?: string): unknown;
export function where(ds: Dataset, rows: unknown[][], cond?: Record<string, unknown>): unknown[][];
export function aggregate(ds: Dataset, rows: unknown[][], m: { field?: string; agg?: string }): number;
export function chartData(ds: Dataset, rows: unknown[][], w: any): { cats: string[]; labels: string[]; series: { name: string; values: number[] }[] };
export function tableData(ds: Dataset, rows: unknown[][], w: any): { head: string[]; formats: (string | undefined)[]; rows: unknown[][]; total: number };
export function kpiData(ds: Dataset, rows: unknown[][], w: any): { value: unknown; base?: number; delta?: number; literal?: boolean };
export function filtered(ds: Dataset, active: Record<string, string>): unknown[][];
