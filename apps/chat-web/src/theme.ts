// Theme (H55): light by default, dark or "follow the system" on request. The choice lives in
// localStorage; index.html applies it before the first paint (no flash). CSS reads
// :root[data-theme]; mermaid and canvases re-render through useTheme().
import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "assistente.theme";
const media = () => matchMedia("(prefers-color-scheme: dark)");

export function themePref(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === "dark" || v === "system" ? v : "light";
	} catch {
		return "light";
	}
}

const resolve = (p: ThemePref): "light" | "dark" => (p === "system" ? (media().matches ? "dark" : "light") : p);
export const isDark = () => document.documentElement.dataset.theme === "dark";

function apply(p: ThemePref) {
	document.documentElement.dataset.theme = resolve(p);
	dispatchEvent(new Event("themechange"));
}

export function setThemePref(p: ThemePref) {
	try {
		localStorage.setItem(KEY, p);
	} catch {
		/* private mode: still applies for this page */
	}
	apply(p);
}

/** The applied theme; re-renders when the user switches or, on "system", when the OS does. */
export function useTheme(): "light" | "dark" {
	const [t, setT] = useState(() => (isDark() ? "dark" : "light") as "light" | "dark");
	useEffect(() => {
		const sync = () => setT(isDark() ? "dark" : "light");
		const os = () => themePref() === "system" && apply("system");
		addEventListener("themechange", sync);
		media().addEventListener("change", os);
		return () => {
			removeEventListener("themechange", sync);
			media().removeEventListener("change", os);
		};
	}, []);
	return t;
}
