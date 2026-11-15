// Brand mark (H59): a chat bubble with a four-point spark cut out of it (concept generated with
// MiniMax H3, redrawn as SVG so it stays sharp at 16 px and follows the theme's accent).
export const MARK_PATH =
	"M16.5 3.5a12 12 0 1 1 0 24a12 12 0 1 1 0-24Z" + // bubble
	"M16.5 6.5A9 9 0 0 0 25.5 15.5A9 9 0 0 0 16.5 24.5A9 9 0 0 0 7.5 15.5A9 9 0 0 0 16.5 6.5Z"; // spark (hole)
export const TAIL_PATH = "M9.8 21.5C9.6 24.2 8.4 26.6 6.9 28.4C6.6 28.8 6.9 29.3 7.4 29.2C9.6 29 11.7 28.3 13.6 27Z";

export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
			<path d={MARK_PATH} fill="currentColor" fillRule="evenodd" />
			<path d={TAIL_PATH} fill="currentColor" />
		</svg>
	);
}

/** Mark + name, for the sidebar and the header. */
export function Logo({ size = 22 }: { size?: number }) {
	return (
		<span className="logo">
			<LogoMark size={size} className="logo-mark" />
			<span className="logo-word">Assistente</span>
		</span>
	);
}
