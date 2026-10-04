export interface ModelOption {
  command: string;
  id: string;
  label: string;
  description: string;
}

export const MODELS: ModelOption[] = [
  { command: "modelfable", id: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable" },
  { command: "modelopus", id: "claude-opus-5-5", label: "Opus 5.5", description: "Deep reasoning" },
  { command: "modelsonnet", id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Balanced speed and capability" },
  { command: "modelhaiku", id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest" },
];

export const FAST_MODEL = "claude-haiku-4-5-20251001";

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
