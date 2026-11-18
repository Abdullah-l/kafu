export interface ModelOption {
  command: string;
  id: string;
  label: string;
  description: string;
}

export const MODELS: ModelOption[] = [
  { command: "modelfable", id: "fable", label: "Fable", description: "Most capable" },
  { command: "modelopus", id: "opus", label: "Opus", description: "Deep reasoning" },
  { command: "modelsonnet", id: "sonnet", label: "Sonnet", description: "Balanced speed and capability" },
  { command: "modelhaiku", id: "haiku", label: "Haiku", description: "Fastest" },
];

export const FAST_MODEL = "haiku";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function resolveEffort(input: string): string | null {
  const wanted = input.trim().toLowerCase();
  return EFFORTS.includes(wanted) ? wanted : null;
}

const FULL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i;

export function latestModel(id: string): string {
  const family = id.trim().match(FULL_ID)?.[1]?.toLowerCase();
  return family && MODELS.some((m) => m.id === family) ? family : id;
}

export function modelLabel(id: string): string {
  const option = MODELS.find((m) => m.id === id.trim());
  if (option) return `${option.label} (latest)`;
  const full = id.trim().match(FULL_ID);
  if (!full) return id;
  return `${full[1][0].toUpperCase()}${full[1].slice(1).toLowerCase()} ${full[2]}${full[3] ? `.${full[3]}` : ""}`;
}

export function choiceLabel(id: string): string {
  return modelLabel(latestModel(id));
}
