import type { Fields } from "../protocol.ts";
import { visible } from "./terminal-text.ts";

export function errorText(error: Fields): string {
  const { candidates } = error;
  const lines = [`${visible(error["code"])}: ${visible(error["detail"])}`];
  if (Array.isArray(candidates))
    lines.push(`Candidates: ${candidates.map(visible).join(", ")}`);
  return lines.map((line) => `${line}\n`).join("");
}
