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

export function activityOutput(start: ActivityFiles): WriteStream {
  const { laterAttempt } = start;
  const { folder, attempt } = laterAttempt ?? {
    folder: start.folder,
    attempt: 1,
  };
  const flags = laterAttempt === undefined ? "w" : "a";
  const prompt = `${JSON.stringify({ attempt, prompt: start.prompt })}\n`;
  writeFileSync(join(folder, "turn-prompts.jsonl"), prompt, {
    flag: flags,
    mode: 0o600,
  });
  const output = createWriteStream(join(folder, "turn.jsonl"), { flags });
  if (laterAttempt !== undefined) output.write("\n");
  return output;
}
