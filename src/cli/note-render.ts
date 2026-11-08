import { operationStep } from "../operation-identity.ts";
import { part } from "./run-command-render.ts";
import { show, visible } from "./terminal-text.ts";

export function noteReceipt(note: unknown): string {
  const value = part(note, "receivedBy");
  if (typeof value !== "string")
    return part(note, "receipt") === "deleted"
      ? "receipt deleted by the retention rule"
      : "waiting";
  const step = operationStep(value);
  if (step === null) return `got by ${visible(value)}`;
  return `got by ${step.phase}/${step.operation}/${String(step.round)}`;
}

export function noteLines(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(
    (note: unknown) =>
      `Note at ${show(part(note, "recordedAt"))}, ${noteReceipt(note)}: ${visible(part(note, "text"))}`,
  );
}
