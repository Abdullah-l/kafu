export interface Attachment {
  name: string;
  path: string;
  data: string;
}

export interface RunRequest {
  type: "run";
  id: string;
  prompt: string;
  sessionKey: string;
  model: string;
  system: string;
  timeoutMs: number;
  attachments: Attachment[];
  protectedRepos?: string[];
}

export type ServerMessage =
  | RunRequest
  | { type: "cancel"; id: string }
  | { type: "forget"; sessionKey: string }
  | { type: "welcome"; userId: string };

export type AgentMessage =
  | { type: "hello"; name: string; version: string }
  | { type: "event"; id: string; line: string }
  | { type: "meta"; id: string; model?: string; contextTokens?: number; contextWindow?: number }
  | { type: "result"; id: string; stdout: string; stderr: string; exitCode: number };

export const AGENT_PROTOCOL_VERSION = "1";
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
