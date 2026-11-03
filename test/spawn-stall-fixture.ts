import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function spawnStall(
  directory: string,
  stall: { readonly command: string; readonly milliseconds: number },
): Promise<string> {
  const hook = join(directory, "spawn-stall.mjs");
  await writeFile(
    hook,
    `
import { ChildProcess } from "node:child_process";
const spawned = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (...argumentsList) {
  const result = spawned.apply(this, argumentsList);
  if (process.argv[2] === ${JSON.stringify(stall.command)})
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(stall.milliseconds)});
  return result;
};
`,
  );
  return `--import=${pathToFileURL(hook).href}`;
}
