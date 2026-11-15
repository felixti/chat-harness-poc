// Model and reasoning effort for the next messages (H57). The list comes from the server
// (/api/models); the choice is a per-browser preference, sent with each turn.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { api, type Effort, type ModelChoice } from "./api";

const KEY = "assistente.model";
const EFFORT_LABEL: Record<Effort, { label: string; hint: string }> = {
	low: { label: "Rápido", hint: "Pensa pouco: respostas curtas e diretas" },
	medium: { label: "Equilibrado", hint: "O padrão para o dia a dia" },
	high: { label: "Profundo", hint: "Pensa mais: análises, planos, código; mais lento" },
};

export interface ModelPref {
	model?: string;
	effort?: Effort;
}

export function loadModelPref(): ModelPref {
	try {
		return (JSON.parse(localStorage.getItem(KEY) ?? "null") as ModelPref | null) ?? {};
	} catch {
		return {};
	}
}

export function ModelPicker({ pref, setPref, disabled }: { pref: ModelPref; setPref: (p: ModelPref) => void; disabled?: boolean }) {
	const [models, setModels] = useState<ModelChoice[]>([]);
	const [def, setDef] = useState<{ model?: string; effort: Effort }>({ effort: "medium" });
	const [efforts, setEfforts] = useState<Effort[]>(["low", "medium", "high"]);
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		api
			.models()
			.then((r) => {
				setModels(r.models);
				setEfforts(r.efforts);
				setDef({ model: r.default, effort: r.defaultEffort });
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent | KeyboardEvent) => {
			if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
		};
		addEventListener("mousedown", close);
		addEventListener("keydown", close);
		return () => {
			removeEventListener("mousedown", close);
			removeEventListener("keydown", close);
		};
	}, [open]);

	// A model removed on the server falls back to the default.
	const model = models.find((m) => m.id === pref.model) ?? models.find((m) => m.id === def.model);
	const effort = pref.effort && efforts.includes(pref.effort) ? pref.effort : def.effort;
	const save = (p: ModelPref) => {
		const next = { ...pref, ...p };
		try {
			localStorage.setItem(KEY, JSON.stringify(next));
		} catch {
			/* private mode: kept for this page */
		}
		setPref(next);
	};
	if (!models.length) return null;

	return (
		<div className="model-picker" ref={box}>
			<button type="button" className="model-btn" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={disabled ? "Aguarde a resposta terminar" : "Modelo e esforço"} onClick={() => setOpen((v) => !v)}>
				<span className="model-name">{model?.label}</span>
				<span className="model-effort">{EFFORT_LABEL[effort].label}</span>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="model-menu" role="dialog" aria-label="Modelo e esforço">
					<p className="model-menu-h">Modelo</p>
					<div role="radiogroup" aria-label="Modelo">
						{models.map((m) => (
							<button key={m.id} type="button" role="radio" aria-checked={m.id === model?.id} className="model-opt" onClick={() => save({ model: m.id })}>
								<span>
									<strong>{m.label}</strong>
									{m.note && <small>{m.note}</small>}
								</span>
								{m.id === model?.id && <Check size={16} />}
							</button>
						))}
					</div>
					<p className="model-menu-h">Esforço de raciocínio</p>
					<div className="effort-switch" role="radiogroup" aria-label="Esforço">
						{efforts.map((e) => (
							<button key={e} type="button" role="radio" aria-checked={e === effort} title={EFFORT_LABEL[e].hint} onClick={() => save({ effort: e })}>
								{EFFORT_LABEL[e].label}
							</button>
						))}
					</div>
					<p className="model-menu-hint">{EFFORT_LABEL[effort].hint}. Vale para as próximas mensagens.</p>
				</div>
			)}
		</div>
	);
}
