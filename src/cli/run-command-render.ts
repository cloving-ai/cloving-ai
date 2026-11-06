import { record, type Fields } from "../protocol.ts";
import { show, visible } from "./terminal-text.ts";

export function part(value: unknown, name: string): unknown {
  return record(value)?.[name];
}

export function listing(value: unknown): string {
  const items = Array.isArray(value) ? value.map(show) : [];
  return items.length === 0 ? "none" : items.join(", ");
}

export function receiptLines(result: Fields): readonly string[] {
  const receipt = result["receipt"];
  return [
    `Command ID: ${show(result["commandId"])}`,
    `Receipt: sequence ${show(part(receipt, "sequence"))}, recorded at ${show(part(receipt, "recordedAt"))}`,
    ...(result["replayed"] === true
      ? ["This is the receipt of the earlier equal command."]
      : []),
  ];
}

export function runCommandLines(result: Fields): readonly string[] {
  const committed = result["committed"];
  const observed = result["observed"];
  return [
    `Run ${show(result["runId"])}: ${show(result["command"])} is committed. State ${show(part(committed, "state"))}, revision ${show(part(committed, "revision"))}.`,
    ...receiptLines(result),
    `Revoked intents: ${show(part(committed, "revokedIntents"))}`,
    `Observed: ${show(part(observed, "condition"))}`,
    `Unresolved effects: ${listing(part(observed, "unresolvedEffects"))}`,
  ];
}

export function runContinuedLines(result: Fields): readonly string[] {
  return [
    `Run ${show(result["runId"])} continues ${show(result["continuedFrom"])}. The steps from event ${show(result["reuseBefore"])} run again.`,
    ...receiptLines(result),
  ];
}

export function continuationLines(run: unknown): readonly string[] {
  const continuedFrom = part(run, "continuedFrom");
  const continuedBy = part(run, "continuedBy");
  return [
    ...(continuedFrom === undefined
      ? []
      : [`Continues: ${visible(continuedFrom)}`]),
    ...(continuedBy === undefined
      ? []
      : [`Continued by: ${visible(continuedBy)}`]),
  ];
}
