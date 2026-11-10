import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export interface LaterAttempt {
  readonly folder: string;
  readonly attempt: number;
}

export interface ActivityFiles {
  readonly folder: string;
  readonly laterAttempt?: LaterAttempt;
  readonly prompt: string;
}

function activityPlace(start: ActivityFiles): {
  readonly folder: string;
  readonly attempt: number;
  readonly flags: "w" | "a";
} {
  const { laterAttempt } = start;
  const { folder, attempt } = laterAttempt ?? {
    folder: start.folder,
    attempt: 1,
  };
  return { folder, attempt, flags: laterAttempt === undefined ? "w" : "a" };
}

export function recordPrompt(start: ActivityFiles): void {
  const { folder, attempt, flags } = activityPlace(start);
  const prompt = `${JSON.stringify({ attempt, prompt: start.prompt })}\n`;
  writeFileSync(join(folder, "turn-prompts.jsonl"), prompt, {
    flag: flags,
    mode: 0o600,
  });
}

export function activityOutput(start: ActivityFiles): WriteStream {
  const { folder, flags } = activityPlace(start);
  const output = createWriteStream(join(folder, "turn.jsonl"), { flags });
  if (start.laterAttempt !== undefined) output.write("\n");
  return output;
}
