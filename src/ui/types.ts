import type { Settings } from "../config";
export type { AgentStreamEvent } from "../runner";

export interface WebSnapshot {
  pid: number;
  startedAt: number;
  settings: Settings;
}

export interface WebServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

export interface StartWebUiOptions {
  host: string;
  port: number;
  token: string;
  getSnapshot: () => WebSnapshot;
  onChat?: (
    message: string,
    onChunk: (text: string) => void,
    onUnblock: () => void,
    onAgentEvent: (ev: import("../runner").AgentStreamEvent) => void
  ) => Promise<void>;
}
