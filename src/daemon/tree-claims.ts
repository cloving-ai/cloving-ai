import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const pollMilliseconds = 250;

export async function clearedTreeClaims(directory: string): Promise<void> {
  await rm(join(directory, "tree-claims"), { recursive: true, force: true });
}

export async function takeClaim(claim: string): Promise<boolean> {
  await mkdir(dirname(claim), { recursive: true });
  return mkdir(claim).then(
    () => true,
    () => false,
  );
}

export async function releaseClaim(claim: string): Promise<void> {
  await rm(claim, { recursive: true, force: true });
}

export async function claimReleased(
  claim: string,
  request: { readonly signal: AbortSignal; readonly milliseconds: number },
): Promise<void> {
  const deadline = performance.now() + request.milliseconds;
  while (existsSync(claim)) {
    if (performance.now() >= deadline) throw new Error("work-tree-removing");
    await delay(pollMilliseconds, undefined, { signal: request.signal });
  }
}
