import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function ownedClaim(
  claim: string,
  owner: { readonly processId: number },
): Promise<void> {
  await mkdir(claim, { recursive: true });
  await writeFile(join(claim, "owner.json"), JSON.stringify(owner));
}

export function endedProcess(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}
