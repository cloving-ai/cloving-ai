import { part } from "./run-command-render.ts";
import { visible } from "./terminal-text.ts";

export function turnDetailsLines(value: unknown): readonly string[] {
  const state = part(value, "state");
  if (state === "deleted")
    return ["Turn details were deleted by the retention rule"];
  if (state !== "archived") return [];
  return [
    `Turn details are archived in the journal folder of the archive: ${visible(part(value, "folder"))}`,
  ];
}

export function turnWaitLines(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((wait: unknown) => {
    const attempt = part(wait, "attempt");
    const remaining = part(wait, "remainingMilliseconds");
    if (typeof attempt !== "number" || typeof remaining !== "number") return [];
    const seconds = Math.ceil(remaining / 1000);
    return [
      `Worker turn ${visible(part(wait, "operationId"))} waits for a retry: attempt ${String(attempt + 1)} starts at ${visible(part(wait, "waitEndsAt"))}, ${String(seconds)} s left`,
    ];
  });
}
