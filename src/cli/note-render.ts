import { operationStep } from "../operation-identity.ts";
import type { Fields } from "../protocol.ts";
import { part, receiptLines } from "./run-command-render.ts";
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
      `Note at ${show(part(note, "recordedAt"))} from ${show(part(note, "source"))}, ${noteReceipt(note)}: ${visible(part(note, "text"))}`,
  );
}

function deliveryLine(result: Fields): string {
  const delivery = result["delivery"];
  if (delivery === "now")
    return `The turn in work got the note: ${noteReceipt({ receivedBy: result["operationId"] }).replace("got by ", "")}.`;
  if (delivery !== "queued") return "The note is recorded.";
  const reason = result["reason"];
  return reason === undefined
    ? "The note waits for the next turn of the run (queued)."
    : `The note waits for the next turn of the run (queued: ${show(reason)}).`;
}

export function runNotedLines(result: Fields): readonly string[] {
  return [
    `Run ${show(result["runId"])} has the note ${show(result["noteId"])}.`,
    deliveryLine(result),
    ...receiptLines(result),
  ];
}
