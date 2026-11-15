// Optional vim-style navigation (off by default, toggled in the "Atalhos" dialog, kept per browser).
// Keys only act outside text fields, so typing in the composer or a search box is never hijacked.
import { useEffect, useRef, useState } from "react";

const KEY = "assistente.vim";

export function useVimSetting(): [boolean, (v: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(KEY) === "1";
		} catch {
			return false;
		}
	});
	const set = (v: boolean) => {
		setOn(v);
		try {
			localStorage.setItem(KEY, v ? "1" : "0");
		} catch {
			/* storage blocked: the setting lasts for this page only */
		}
	};
	return [on, set];
}

export const isTyping = (t: EventTarget | null) => {
	const el = t as HTMLElement | null;
	return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** A key or a two-key sequence ("gg", "dd"). Sequences wait 700 ms for the second key. */
export type VimMap = Record<string, () => void>;

export function useVimKeys(enabled: boolean, map: VimMap, onHelp: () => void) {
	const ref = useRef({ map, onHelp });
	ref.current = { map, onHelp };
	useEffect(() => {
		let pending = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing || e.altKey || e.metaKey) return;
			if (document.querySelector("dialog[open]")) return; // dialogs keep their own keys
			if (isTyping(e.target)) {
				// Esc leaves the field so the next keys navigate again.
				if (enabled && e.key === "Escape") (e.target as HTMLElement).blur();
				return;
			}
			if (e.key === "?" && !e.ctrlKey) return e.preventDefault(), ref.current.onHelp();
			if (!enabled) return;
			const k = e.ctrlKey ? `C-${e.key}` : e.key;
			if (e.ctrlKey && k !== "C-d" && k !== "C-u") return;
			const seq = pending + k;
			const { map } = ref.current;
			clearTimeout(timer);
			if (map[seq]) {
				pending = "";
				e.preventDefault();
				return map[seq]();
			}
			if (Object.keys(map).some((m) => m.length > 1 && m.startsWith(seq))) {
				pending = seq;
				timer = setTimeout(() => (pending = ""), 700);
				return e.preventDefault();
			}
			pending = "";
			if (map[k]) {
				e.preventDefault();
				map[k]();
			}
		};
		addEventListener("keydown", onKey);
		return () => (removeEventListener("keydown", onKey), clearTimeout(timer));
	}, [enabled]);
}

export const SHORTCUTS: [string, string][] = [
	["j / k", "Rolar a conversa"],
	["Ctrl+d / Ctrl+u", "Meia página para baixo / para cima"],
	["gg / G", "Início / fim da conversa"],
	["J / K", "Próxima / anterior conversa"],
	["o", "Nova conversa"],
	["i", "Escrever uma mensagem"],
	["Esc", "Sair do campo de texto"],
	["/", "Buscar conversas"],
	["dd", "Apagar a conversa aberta"],
	["v", "Selecionar várias conversas"],
];

export const SELECT_SHORTCUTS: [string, string][] = [
	["j / k", "Mover na lista"],
	["x / Espaço", "Marcar / desmarcar"],
	["V", "Marcar todas as visíveis"],
	["d", "Apagar as marcadas"],
	["Esc", "Sair da seleção"],
];
