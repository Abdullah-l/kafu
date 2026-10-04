import { join } from "path";

export const KAFU_DIR = join(process.cwd(), ".claude", "kafu");
export const LOGS_DIR = join(KAFU_DIR, "logs");
export const SETTINGS_FILE = join(KAFU_DIR, "settings.json");
export const SESSION_FILE = join(KAFU_DIR, "session.json");
export const STATE_FILE = join(KAFU_DIR, "state.json");
