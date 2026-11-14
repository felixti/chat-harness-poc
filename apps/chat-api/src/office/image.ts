// generate_image: one HTTP call to an image model through the platform LLM gateway (OpenRouter
// chat completions with modalities ["image","text"]). No subprocess, no binaries: the bytes come
// back as a data URL and are written to the workspace for the deck (background_image / image layout).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { insideWorkspace } from "../tools.ts";
import { config } from "../config.ts";
import { loadThemes } from "./pptx.ts";

const MAX_IMAGES = 6; // per agent session: covers and section openers, not every slide
const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 90_000;
const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;

/** Guardrails appended to every prompt: generated text, logos and real people are the usual failures. */
export const IMAGE_RULES =
	"Do not draw any text, letters, numbers, captions, logos, watermarks, charts, user interfaces, people or faces. " +
	"Leave calm negative space so a title can sit on top. Professional, editorial, high quality.";

export function buildPrompt(prompt: string, palette?: string[]): string {
	const colors = palette?.length ? ` Color palette: ${palette.map((c) => `#${c}`).join(", ")}; keep the image within these hues.` : "";
	return `${prompt.trim()}${colors} ${IMAGE_RULES}`;
}

/** Data URL from the model's first image. */
export function firstImage(body: any): { mime: string; data: Buffer } {
	const url: string | undefined = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
	const m = url && /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(url);
	if (!m) {
		const why = body?.error?.message ?? body?.choices?.[0]?.message?.content ?? "no image in the response";
		throw new Error(`image model returned no image: ${String(why).slice(0, 200)}`);
	}
	return { mime: m[1].replace("jpg", "jpeg"), data: Buffer.from(m[2], "base64") };
}

export function imageTool(workspace: string, themesDir: string) {
	let used = 0;
	return defineTool({
		name: "generate_image",
		label: "generate_image",
		description:
			"Generate an illustration with an image model and save it in the workspace. Use it only for deck covers, " +
			"section slides and the `image` layout (at most 3 per deck); never for charts, numbers, diagrams or logos " +
			"(use real charts and icons). Pass the deck theme so the colors match. Returns the saved path and the image to check.",
		promptSnippet: "generate_image: prompt -> PNG/JPEG in the workspace for deck covers (read skill pptx)",
		parameters: Type.Object({
			prompt: Type.String({ description: "What to show: subject, mood, composition (e.g. 'abstract aerial view of a port at dusk, wide, calm sky on the left'). English works best." }),
			output: Type.String({ description: "Path without extension or with .png/.jpg, e.g. outputs/img/cover. The real extension follows the model's format." }),
			aspect_ratio: Type.Optional(Type.Union(RATIOS.map((r) => Type.Literal(r)), { description: "Default 16:9 (full-slide background)" })),
			theme: Type.Optional(Type.String({ description: "Deck theme name; its colors go into the prompt" })),
		}),
		async execute(_id, p, signal) {
			if (used >= MAX_IMAGES) throw new Error(`image limit reached (${MAX_IMAGES} per session); reuse the images you have`);
			let palette: string[] | undefined;
			if (p.theme) {
				const t = (await loadThemes(themesDir))[p.theme];
				if (t) palette = [t.bg, t.accent, t.accent2, t.surface];
			}
			const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
				body: JSON.stringify({
					model: config.imageModel,
					modalities: ["image", "text"],
					image_config: { aspect_ratio: p.aspect_ratio ?? "16:9" },
					messages: [{ role: "user", content: buildPrompt(p.prompt, palette) }],
				}),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(`image model HTTP ${res.status}: ${String((body as any)?.error?.message ?? "").slice(0, 200)}`);
			const img = firstImage(body);
			if (img.data.length > MAX_BYTES) throw new Error("image over 8 MB");
			used++;
			const ext = img.mime === "jpeg" ? ".jpg" : `.${img.mime}`;
			const output = p.output.replace(/\.(png|jpe?g|webp)$/i, "") + ext;
			const file = insideWorkspace(workspace, output);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, img.data);
			const cost = (body as any)?.usage?.cost;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Image saved: ${output} (${Math.round(img.data.length / 1024)} KiB${cost ? `, US$${Number(cost).toFixed(3)}` : ""}; ${MAX_IMAGES - used} left this session). ` +
							"Check it below: if it has text, logos, faces or clashing colors, generate again with a clearer prompt. " +
							`Use it in the deck as "background_image": "${output}" (title or section slide) or "path" in the image layout.`,
					},
					{ type: "image" as const, data: img.data.toString("base64"), mimeType: `image/${img.mime}` },
				],
				details: undefined,
			};
		},
	});
}
