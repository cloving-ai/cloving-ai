import type { Fields } from "../protocol.ts";
import { show, visible } from "./terminal-text.ts";

function fieldLine(label: string, value: unknown): readonly string[] {
  return Array.isArray(value) && value.length > 0
    ? [`${label}: ${visible(value.map(show).join(", "))}`]
    : [];
}

export function reloadFieldLines(result: Fields): readonly string[] {
  return [
    ...fieldLine("Reloaded fields", result["reloadedFields"]),
    ...fieldLine("Fields that need a restart", result["restartFields"]),
  ];
}
