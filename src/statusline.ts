import { join } from "path";

const KAFU_DIR = join(process.cwd(), ".claude", "kafu");

export interface StateData {
  security: string;
  telegram: boolean;
  slack: boolean;
  startedAt: number;
  web?: { enabled: boolean; host: string; port: number };
}

export async function writeState(state: StateData) {
  await Bun.write(
    join(KAFU_DIR, "state.json"),
    JSON.stringify(state) + "\n"
  );
}
