// One A2UI 1.0 surface (H61), rendered with the basic catalog in the portal theme. Loaded lazily.
import { useEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { A2uiSurface, MarkdownComponentContext } from "@a2ui/react";
import { Markdown } from "./Markdown";
import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";
import { actionMessage, type UiArgs } from "./RichParts";

/** Text in a surface uses the chat's markdown renderer (headings, bold, lists). */
// It renders inside the catalog's shadow roots, so its styles travel with it.
const MD_CSS = `.ui-md{font-size:14.5px;line-height:1.5;color:inherit}.ui-md>:first-child{margin-top:0}.ui-md>:last-child{margin-bottom:0}
.ui-md.ui-md :is(h1,h2,h3,h4){font-size:16px;font-weight:600;line-height:1.3;margin:0 0 4px}.ui-md p{margin:0 0 6px}
.ui-md ul,.ui-md ol{margin:0 0 6px;padding-left:20px}.ui-md a{color:var(--accent)}.ui-md code{font-family:var(--mono);font-size:13px}`;
const SurfaceMarkdown = ({ markdown }: { markdown: string }) => (
	<div className="ui-md">
		<style>{MD_CSS}</style>
		<Markdown text={markdown} final />
	</div>
);

/** A2UI ids are UAX #31 identifiers: "btn-text" -> "btn_text", in ids and child references
 *  (history keeps what the model wrote; the server normalizes the same way). */
function normalizeIds(components: Record<string, unknown>[]) {
	const fix = (id: unknown) => (typeof id === "string" ? id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_") : id);
	return components.map((c) => ({
		...c,
		id: fix(c.id),
		...(typeof c.child === "string" ? { child: fix(c.child) } : {}),
		...(Array.isArray(c.children) ? { children: c.children.map(fix) } : {}),
		...(Array.isArray(c.tabs) ? { tabs: (c.tabs as Record<string, unknown>[]).map((t) => ({ ...t, child: fix(t.child) })) } : {}),
	}));
}

const CATALOG = basicCatalog.id;

export default function UiSurface({ ui, sent, disabled, onAction }: { ui: UiArgs; sent: boolean; disabled: boolean; onAction: (text: string) => void }) {
	const act = useRef(onAction);
	act.current = sent || disabled ? () => {} : onAction;
	const key = JSON.stringify(ui);
	const { processor, error } = useMemo(() => {
		const p = new MessageProcessor([basicCatalog], (a) => act.current(actionMessage(a.surfaceId, a.name, a.context ?? {})));
		try {
			p.processMessages([
				{ version: "1.0", createSurface: { surfaceId: ui.surface_id, catalogId: CATALOG } },
				{ version: "1.0", updateComponents: { surfaceId: ui.surface_id, components: normalizeIds(ui.components as Record<string, unknown>[]) } },
				...(ui.data && Object.keys(ui.data).length ? [{ version: "1.0", updateDataModel: { surfaceId: ui.surface_id, path: "/", value: ui.data } }] : []),
			] as never);
			return { processor: p, error: undefined };
		} catch (e) {
			console.warn("[a2ui]", (e as Error).message);
			return { processor: p, error: (e as Error).message };
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	useEffect(() => () => void (processor as unknown as { dispose?: () => void }).dispose?.(), [processor]);
	const surface = processor.model.surfacesMap.get(ui.surface_id);
	// Once submitted, the values live in the user's message: the form would only show its defaults.
	if (sent)
		return (
			<div className="ui-sent-line">
				<Check size={14} /> {ui.title ?? "Formulário"} · enviado
			</div>
		);
	return (
		<section className="ui-surface" aria-label={ui.title ?? "Formulário"}>
			{ui.title && <div className="ui-title">{ui.title}</div>}
			{error || !surface ? (
				<div className="notice error">Não consegui mostrar este formulário.</div>
			) : (
				<div className="ui-body" inert={disabled}>
					<MarkdownComponentContext.Provider value={SurfaceMarkdown}>
						<A2uiSurface surface={surface as never} />
					</MarkdownComponentContext.Provider>
				</div>
			)}
		</section>
	);
}
