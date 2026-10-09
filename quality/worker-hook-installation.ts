import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readWorkerHookPolicy } from "./worker-hook-input.ts";
import type { WorkerHookPolicy } from "./worker-hook-input.ts";

export async function installWorkerHooks(
  directory: string,
  policy: WorkerHookPolicy,
): Promise<{ settings: string; command: string }> {
  const accepted = readWorkerHookPolicy(structuredClone(policy));
  const root = join(await realpath(dirname(directory)), basename(directory));
  const workspace = await realpath(accepted.workspace);
  const location = relative(workspace, root);
  if (location !== ".." && !location.startsWith(`..${sep}`))
    throw new Error("worker-hook-policy-inside-workspace");
  await mkdir(root, { mode: 0o700 });
  const policyFile = join(root, "policy.json");
  const settings = join(root, "settings.json");
  const command = [
    await realpath(process.execPath),
    resolve(import.meta.dirname, "../tools/worker-hook.ts"),
    policyFile,
  ]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const hook = { type: "command", command, timeout: 10 };
  const configuration = {
    hooks: {
      PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [hook] }],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
    },
  };
  await writeFile(policyFile, JSON.stringify({ ...accepted, workspace }), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(settings, JSON.stringify(configuration), {
    flag: "wx",
    mode: 0o600,
  });
  return { settings, command };
}
