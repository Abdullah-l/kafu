export const SECTION_MAX = 2900;
export const MESSAGE_TEXT_MAX = 39000;
const MAX_BLOCKS = 50;

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

function units(text: string): string[] {
  const parts: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length) parts.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (!inFence && fence) {
      flush();
      current.push(line);
      inFence = true;
      continue;
    }
    current.push(line);
    if (inFence && fence) {
      inFence = false;
      flush();
    } else if (!inFence && line.trim() === "") {
      flush();
    }
  }
  flush();
  return parts;
}

function splitUnit(unit: string, max: number): string[] {
  if (unit.length <= max) return [unit];
  const fenced = unit.match(/^(\s*```[^\n]*)\n([\s\S]*?)\n?(```)?\s*$/);
  if (!fenced) return hardSplit(unit, max);
  const open = fenced[1].trim();
  const body = fenced[2];
  const room = max - open.length - 8;
  return hardSplit(body, room).map((piece) => `${open}\n${piece}\n\`\`\``);
}

export function splitSections(text: string, max = SECTION_MAX): string[] {
  const sections: string[] = [];
  let current = "";
  for (const unit of units(text.trim())) {
    for (const piece of splitUnit(unit, max)) {
      const joined = current ? `${current}\n${piece}` : piece;
      if (joined.length <= max) {
        current = joined;
      } else {
        if (current.trim()) sections.push(current.trim());
        current = piece;
      }
    }
  }
  if (current.trim()) sections.push(current.trim());
  return sections;
}

export function answerBlocks(text: string, extra: Record<string, unknown>[] = []): Record<string, unknown>[] | null {
  const sections = splitSections(text);
  if (sections.length + extra.length > MAX_BLOCKS) return null;
  return [...sections.map((s) => ({ type: "section", text: { type: "mrkdwn", text: s } })), ...extra];
}
