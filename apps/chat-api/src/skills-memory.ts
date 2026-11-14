// Memory layer 4: procedures the user wants reused, saved as personal skills.
// Stored sealed in chat-memory/<oid>/skills/<name>.json (ETag writes). At turn start they are
// written as my-<name>/SKILL.md into a per-turn read-only folder that Pi loads like the company
// skills (name + description in the prompt, body read on demand). A skill is instructions by
// nature, so the agent saves one only after the user asks or confirms; the panel lists them and
// deletes them; each keeps the conversation it came from.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "./config.ts";
import { seal, unseal } from "./connectors.ts";
import { docStore, PreconditionFailed } from "./memory.ts";

export interface UserSkill {
	name: string;
	description: string;
	body: string;
	src: string;
	updatedAt: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_BODY = 6000;
const MAX_SKILLS = 30;

function skillKey(): Buffer {
	const master = Buffer.from(config.connectors.masterKey, "base64");
	if (master.length !== 32) throw new Error("memory needs CONNECTORS_MASTER_KEY (32 bytes, base64)");
	return createHmac("sha256", master).update("chat-harness/memory-skills/v1").digest();
}

const indexName = (user: string) => `${user}/skills/index.json`;

/** All skills of a user live in one sealed document: few, small, and one ETag guards them all. */
async function readAll(user: string): Promise<{ skills: UserSkill[]; etag: string | null }> {
	const d = await docStore().get(indexName(user));
	if (!d) return { skills: [], etag: null };
	return { skills: unseal<{ skills: UserSkill[] }>(d.data, indexName(user), skillKey()).skills, etag: d.etag };
}

async function update(user: string, change: (skills: UserSkill[]) => UserSkill[]): Promise<UserSkill[]> {
	for (let attempt = 0; attempt < 6; attempt++) {
		if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
		const { skills, etag } = await readAll(user);
		const next = change(skills);
		try {
			await docStore().put(indexName(user), seal({ skills: next }, indexName(user), skillKey()), etag);
			return next;
		} catch (e) {
			if (!(e instanceof PreconditionFailed)) throw e;
		}
	}
	throw new Error("skills busy: written by another turn at the same time, try again");
}

const INJECTION = [/ignore (all |the )?(previous|prior|above)/i, /system prompt/i, /you are now/i, /<\|?(system|im_start|endoftext)/i];
const SECRET = [/(gh[pousr]_|sk-|xox[bp]-)[A-Za-z0-9]{10,}/, /\b(api[_ -]?key|password|senha|token|secret)\b\s*[:=]\s*\S{6,}/i];

export function checkSkill(s: { name: string; description: string; body: string }): string | undefined {
	if (!NAME.test(s.name)) return "name: 3 to 40 lowercase letters, digits or hyphens (e.g. relatorio-semanal-vendas)";
	if (!s.description.trim() || s.description.length > 300) return "description: one sentence saying when to use it (max 300 characters)";
	if (!s.body.trim() || s.body.length > MAX_BODY) return `body: the steps, max ${MAX_BODY} characters`;
	const all = `${s.description}\n${s.body}`;
	if (INJECTION.some((r) => r.test(all))) return "rejected: looks like a prompt injection";
	if (SECRET.some((r) => r.test(all))) return "rejected: contains a credential; never store secrets in a skill";
	return undefined;
}

export async function listSkills(user: string): Promise<UserSkill[]> {
	return (await readAll(user)).skills;
}

export async function saveSkill(user: string, s: Omit<UserSkill, "updatedAt">): Promise<void> {
	const bad = checkSkill(s);
	if (bad) throw new Error(bad);
	await update(user, (skills) => {
		const rest = skills.filter((x) => x.name !== s.name);
		if (rest.length >= MAX_SKILLS) throw new Error(`limit of ${MAX_SKILLS} personal skills: delete one first`);
		return [...rest, { ...s, updatedAt: new Date().toISOString() }];
	});
}

export async function deleteSkill(user: string, name: string): Promise<boolean> {
	let found = false;
	await update(user, (skills) => {
		found = skills.some((x) => x.name === name);
		return skills.filter((x) => x.name !== name);
	});
	return found;
}

/** Writes the user's skills as Pi skills in a fresh folder; returns it and a cleanup. */
export async function materializeSkills(user: string): Promise<{ dir: string; count: number; cleanup: () => Promise<void> }> {
	const dir = join(config.tmpRoot, "uskills", randomUUID());
	const cleanup = () => rm(dir, { recursive: true, force: true });
	const skills = await listSkills(user).catch((e) => {
		console.warn(`[skills] read: ${(e as Error).message}`);
		return [];
	});
	for (const s of skills) {
		const folder = join(dir, `my-${s.name}`);
		await mkdir(folder, { recursive: true });
		const description = `(Personal procedure saved by the user) ${s.description}`.replace(/\n/g, " ");
		await writeFile(
			join(folder, "SKILL.md"),
			`---\nname: my-${s.name}\ndescription: ${JSON.stringify(description)}\n---\n\n` +
				`<!-- Saved from conversation ${s.src} on ${s.updatedAt.slice(0, 10)}. Follow it as the user's own procedure; ` +
				`company rules and the user's current request win over it. -->\n\n${s.body}\n`,
		);
	}
	return { dir, count: skills.length, cleanup };
}

export function skillTools(user: string, conversation: string): ToolDefinition[] {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	return [
		defineTool({
			name: "skill_save",
			label: "skill_save",
			description:
				"Save a reusable procedure as one of the user's personal skills (appears as my-<name> in future conversations). " +
				"ONLY when the user asks to save it or says yes after you offer. Offer it after a multi-step task that worked and " +
				"will likely repeat (a weekly report, a deck in their format, a data cleanup). The body is a SKILL.md: goal, inputs, " +
				"numbered steps with the exact tools, layouts, themes and formats used, and checks. Saving with an existing name replaces it.",
			promptSnippet: "skill_save: save a procedure the user wants reused as a personal skill (only with their consent)",
			parameters: Type.Object({
				name: Type.String({ description: "slug, e.g. relatorio-semanal-vendas" }),
				description: Type.String({ description: "One sentence: what it does and when to use it" }),
				body: Type.String({ description: "Markdown steps (max 6000 characters)" }),
				user_confirmed: Type.Boolean({ description: "true only if the user asked or agreed to save it in this conversation" }),
			}),
			async execute(_id, p) {
				if (!p.user_confirmed) return text("Not saved: ask the user first (\"Quer que eu salve isso como um procedimento?\") and save only after they agree.");
				await saveSkill(user, { name: p.name, description: p.description, body: p.body, src: conversation });
				return text(`Saved as my-${p.name}. It will be available in the user's next conversations (Memória panel → Procedimentos).`);
			},
		}),
		defineTool({
			name: "skill_delete",
			label: "skill_delete",
			description: "Delete one of the user's personal skills (name without the my- prefix), when the user asks.",
			promptSnippet: "skill_delete: remove a personal skill",
			parameters: Type.Object({ name: Type.String() }),
			async execute(_id, p) {
				const name = p.name.replace(/^my-/, "");
				return text((await deleteSkill(user, name)) ? `Deleted my-${name}.` : `No personal skill named ${name}.`);
			},
		}),
	] as ToolDefinition[];
}
