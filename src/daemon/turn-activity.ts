import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export interface ActivityFiles {
  readonly folder: string;
  readonly activityFolder?: string;
  readonly prompt: string;
}

export function activityOutput(start: ActivityFiles): WriteStream {
  const folder = start.activityFolder ?? start.folder;
  const flags = start.activityFolder === undefined ? "w" : "a";
  const prompt = `${JSON.stringify({ prompt: start.prompt })}\n`;
  writeFileSync(join(folder, "turn-prompts.jsonl"), prompt, {
    flag: flags,
    mode: 0o600,
  });
  const output = createWriteStream(join(folder, "turn.jsonl"), { flags });
  if (start.activityFolder !== undefined) output.write("\n");
  return output;
}
