import { record, type Fields } from "../protocol.ts";
import { visible } from "./terminal-text.ts";

function instant(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

export function queueHeadline(queue: Fields): string {
  const state =
    typeof queue["state"] === "string" ? `${visible(queue["state"])}, ` : "";
  return `Queue: ${state}${visible(queue["busy"])} of ${visible(queue["lanes"])} lanes busy`;
}

function holdLines(queue: Fields): readonly string[] {
  const hold = record(queue["hold"])?.["text"];
  return typeof hold === "string" ? [visible(hold)] : [];
}

export function queueStateLines(queue: Fields): readonly string[] {
  const reason = record(queue["stop"])?.["reason"];
  const failed = queue["failedRunIds"];
  const drain = record(queue["drain"]);
  const started = instant(drain?.["startedAt"]);
  const drained = instant(drain?.["drainedAt"]);
  return [
    ...holdLines(queue),
    ...(reason === undefined ? [] : [`Stop reason: ${visible(reason)}`]),
    ...(Array.isArray(failed) && failed.length > 0
      ? [`Failed runs in a row: ${failed.map(visible).join(", ")}`]
      : []),
    ...(started === undefined ? [] : [`Drain started: ${started}`]),
    ...(drained === undefined ? [] : [`Drained: ${drained}`]),
  ];
}

export function effectLeaseText(value: unknown): string | undefined {
  const limits = record(value);
  if (limits === undefined) return undefined;
  return `Effect leases: capacity ${visible(limits["capacity"])}, ${visible(limits["queueLimit"])} for queue runs, ${visible(limits["reserved"])} reserved for other runs`;
}
