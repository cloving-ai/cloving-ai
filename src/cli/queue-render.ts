import { record, type Fields } from "../protocol.ts";
import { queueSpendLines } from "./usage-render.ts";
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

function sourced(value: unknown, unit: string): string {
  const fields = record(value);
  return `${visible(fields?.["value"])} ${unit} (${visible(fields?.["source"])})`;
}

function settingLines(queue: Fields): readonly string[] {
  const settings = record(queue["settings"]);
  if (settings === undefined) return [];
  return [
    `Queue settings: every ${sourced(settings["everySeconds"], "s")}, ${sourced(settings["lanes"], "lanes")}, ${sourced(settings["workingLanes"], "working lanes")}`,
  ];
}

export function queueOffLines(value: unknown): readonly string[] {
  const off = record(value);
  if (off === undefined) return [];
  return [
    `Queue: off for ${visible(off["workflowId"])} (${visible(off["source"])})`,
  ];
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
    ...settingLines(queue),
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

export function queuesLines(result: Fields): readonly string[] {
  const queues = result["queues"];
  if (!Array.isArray(queues) || queues.length < 2)
    return queueLines(result["queue"]);
  return queues.flatMap((value: unknown) => {
    const queue = record(value);
    return queueLines(queue).map((line, index) =>
      index === 0
        ? line.replace("Queue:", `Queue ${visible(queue?.["workflowId"])}:`)
        : line,
    );
  });
}

export function queueLines(value: unknown): readonly string[] {
  const queue = record(value);
  if (queue === undefined) return [];
  const skipped = queue["skipped"];
  return [
    queueHeadline(queue),
    ...queueStateLines(queue),
    ...queueSpendLines(queue["spend"]),
    ...(Array.isArray(skipped)
      ? skipped.map((item: unknown) => {
          const dependencies = record(item)?.["dependencies"];
          const needs = Array.isArray(dependencies)
            ? `; needs ${dependencies.map(visible).join(", ")}`
            : "";
          return `Skipped ticket ${visible(record(item)?.["ticketId"])}: ${visible(record(item)?.["reason"])}${needs}`;
        })
      : []),
  ];
}
