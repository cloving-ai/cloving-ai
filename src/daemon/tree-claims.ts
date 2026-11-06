import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const abandonedMilliseconds = 15 * 60_000;
const ownerlessMilliseconds = 60_000;
const pollMilliseconds = 250;

function alive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

async function ownerOf(claim: string): Promise<number | undefined> {
  const text = await readFile(join(claim, "owner.json"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    const processId: unknown =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "processId")
        : undefined;
    return typeof processId === "number" &&
      Number.isSafeInteger(processId) &&
      processId > 0
      ? processId
      : undefined;
  } catch {
    return undefined;
  }
}

export async function abandonedClaim(claim: string): Promise<boolean> {
  const made = await stat(claim).catch(() => undefined);
  if (made === undefined) return false;
  const age = Date.now() - made.mtimeMs;
  if (age > abandonedMilliseconds) return true;
  const owner = await ownerOf(claim);
  if (owner === undefined) return age > ownerlessMilliseconds;
  return !alive(owner);
}

export async function releaseClaim(claim: string): Promise<void> {
  await rm(claim, { recursive: true, force: true });
}

export async function takeClaim(claim: string): Promise<boolean> {
  await mkdir(dirname(claim), { recursive: true });
  if (await abandonedClaim(claim)) await releaseClaim(claim);
  const made = await mkdir(claim).then(
    () => true,
    () => false,
  );
  if (!made) return false;
  await writeFile(
    join(claim, "owner.json"),
    JSON.stringify({ processId: process.pid }),
  );
  return true;
}

export async function claimReleased(
  claim: string,
  request: { readonly signal: AbortSignal; readonly milliseconds: number },
): Promise<void> {
  const deadline = performance.now() + request.milliseconds;
  while (existsSync(claim)) {
    if (await abandonedClaim(claim)) {
      await releaseClaim(claim);
      return;
    }
    if (performance.now() >= deadline) throw new Error("work-tree-removing");
    await delay(pollMilliseconds, undefined, { signal: request.signal });
  }
}
