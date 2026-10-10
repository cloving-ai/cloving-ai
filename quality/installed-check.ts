import type { VerifierInstallation } from "./verifier-installation.ts";
import type {
  CapturedExecution,
  VerificationCommand,
} from "./verification-types.ts";
import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { assertVerifierInstallation } from "./verifier-installation.ts";
import { snapshotTree } from "./tree-snapshot.ts";
import { captureExecution } from "./verification-process.ts";

export async function executeInstalledCheck(
  installation: VerifierInstallation,
  check: { readonly candidate: string; readonly timeoutMilliseconds: number },
): Promise<{
  verifier: string;
  candidate: string;
  role: "static-analysis";
  command: VerificationCommand;
  execution: CapturedExecution;
}> {
  const { candidate, timeoutMilliseconds } = check;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0)
    throw new Error("invalid-installed-check-timeout");
  const pinned = structuredClone(installation);
  await assertVerifierInstallation(pinned);
  const directory = await realpath(candidate);
  for (const path of [
    relative(directory, pinned.directory),
    relative(pinned.directory, directory),
  ]) {
    if (path !== ".." && !path.startsWith(`..${sep}`))
      throw new Error("overlapping-verifier-candidate");
  }
  const entry = join(pinned.directory, "tools/check-protected-quality.ts");
  if ((await realpath(entry)) !== entry)
    throw new Error("invalid-installed-check-entry");
  const before = await snapshotTree(directory);
  const command = {
    id: "protected-quality",
    executable: await realpath(process.execPath),
    arguments: [entry, directory],
    directory: pinned.directory,
    timeoutMilliseconds,
  };
  const execution = await captureExecution(command);
  await assertVerifierInstallation(pinned);
  if ((await snapshotTree(directory)).identity !== before.identity)
    throw new Error("installed-check-candidate-changed");
  return {
    verifier: pinned.identity,
    candidate: before.identity,
    role: "static-analysis",
    command,
    execution,
  };
}
