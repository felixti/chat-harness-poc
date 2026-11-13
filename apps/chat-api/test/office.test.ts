// Smoke tests for the Office writers: valid files, lint behaves, no subprocess needed.
import "../src/no-subprocess.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderDeck, loadThemes } from "../src/office/pptx.ts";
import { markdownToDocx } from "../src/office/docx.ts";
import { renderWorkbook, parseCsv } from "../src/office/xlsx.ts";

const zip = (b: Buffer) => b.subarray(0, 2).toString() === "PK";
const png = (b: Buffer) => b.subarray(1, 4).toString() === "PNG";
const themes = await loadThemes(new URL("../../../skills/pptx/themes", import.meta.url).pathname);

test("sample deck renders 14 slides with only the notes warning", async () => {
	const spec = JSON.parse(await readFile(new URL("sample-deck.json", import.meta.url), "utf8"));
	for (const theme of Object.keys(themes)) {
		const r = await renderDeck({ ...spec, theme }, { workspace: ".", resolve: (p) => p, themes });
		assert.ok(zip(r.bytes));
		assert.equal(r.slides, 14);
		assert.equal(r.previews.length, 14);
		assert.ok(r.previews.every(png));
		// Measured checks (overflow, collisions, contrast) are clean in every shipped theme.
		assert.deepEqual(r.warnings, ["slides 12, 13: no speaker notes (add \"notes\")"], theme);
	}
});

test("themes come from the skill folder; custom themes and contrast are checked", async () => {
	assert.ok(Object.keys(themes).length >= 13);
	const slides = [{ layout: "statement", text: "Uma frase **importante** aqui", notes: "n" }];
	const inline = await renderDeck({ title: "t", theme: { extends: "insight", accent: "#7A1F5C" }, slides }, { workspace: ".", resolve: (p) => p, themes, preview: false });
	assert.deepEqual(inline.warnings, []);
	const bad = await renderDeck(
		{ title: "t", theme: { muted: "#E4E7EC" }, slides: [{ layout: "kpis", title: "Três números", items: [{ value: "42", label: "Clientes" }], notes: "n" }] },
		{ workspace: ".", resolve: (p) => p, themes },
	);
	assert.match(bad.warnings.join("\n"), /muted text on background contrast/);
	assert.match(bad.warnings.join("\n"), /\(measured\): text "Clientes…" is hard to read/);
	const unknown = await renderDeck({ title: "t", theme: "neon", slides }, { workspace: ".", resolve: (p) => p, themes, preview: false });
	assert.match(unknown.warnings[0], /unknown theme "neon"/);
});

test("preview measures overflowing text", async () => {
	const r = await renderDeck(
		{ title: "t", slides: [{ layout: "quote", quote: "palavra ".repeat(120), author: "x", notes: "n" }] },
		{ workspace: ".", resolve: (p) => p, themes },
	);
	assert.match(r.warnings.join("\n"), /\(measured\): text "palavra.*overflows its box/);
});

test("lint flags overloaded slides", async () => {
	const r = await renderDeck(
		{ title: "t", slides: [{ layout: "bullets", title: "x".repeat(120), bullets: Array(8).fill("bullet"), notes: "n" }, { layout: "nope", notes: "n" }] },
		{ workspace: ".", resolve: (p) => p },
	);
	const all = r.warnings.join("\n");
	assert.match(all, /title has 120 chars/);
	assert.match(all, /8 bullets/);
	assert.match(all, /unknown layout "nope"/);
});

test("icons, cards and big_number render; unknown icon is linted", async () => {
	const r = await renderDeck(
		{ title: "t", theme: "tech_night", slides: [
			{ layout: "big_number", value: "R$ 42 mi", title: "x", notes: "n" },
			{ layout: "cards", title: "x", items: [{ icon: "rocket", title: "a" }, { icon: "rockett", title: "b" }, { icon: "timer", title: "c" }], notes: "n" },
		] },
		{ workspace: ".", resolve: (p) => p, themes },
	);
	assert.ok(zip(r.bytes));
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /unknown icon "rockett" \(try: .*rocket/);
});

test("docx from markdown", async () => {
	const b = await markdownToDocx("## A\n\n| x | y |\n|--|--:|\n| a | 1 |\n\n- one\n  - two\n\n> quote", { title: "T", toc: true });
	assert.ok(zip(b));
});

test("xlsx with formulas, totals and csv", async () => {
	const csv = 'País;Lucro\n"EUA";"1.234,50"\nCanadá;99\n';
	assert.deepEqual(parseCsv(csv), [["País", "Lucro"], ["EUA", "1.234,50"], ["Canadá", "99"]]);
	const r = await renderWorkbook(
		{ sheets: [{ name: "S", columns: [{ header: "País" }, { header: "Lucro", format: "currency" }], rows_csv: "x.csv", totals: true, data_bars: ["Lucro"] }] },
		async () => csv,
	);
	assert.ok(zip(r.bytes));
	assert.deepEqual(r.warnings, []);
});
