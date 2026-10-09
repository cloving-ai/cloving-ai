import type {
  VerificationInputs,
  VerificationSnapshot,
} from "./verification-types.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

export async function captureVerificationInputs(
  inventory: VerificationInputs,
): Promise<string> {
  return (await snapshotVerificationInputs(inventory)).identity;
}

export async function snapshotVerificationInputs(
  inventory: VerificationInputs,
): Promise<VerificationSnapshot> {
  const records: Record<string, readonly string[]> = {};
  for (const kind of [
    "source",
    "tests",
    "dependencies",
    "tools",
    "policy",
    "exceptions",
  ] as const) {
    const files = inventory[kind];
    if (kind !== "exceptions" && files.length === 0)
      throw new Error(`empty-verification-inputs: ${kind}`);
    const identities: string[] = [];
    for (const file of files) {
      const canonical = await realpath(file);
      const status = await lstat(file);
      if (!status.isFile())
        throw new Error(`invalid-verification-file: ${file}`);
      identities.push(
        JSON.stringify({
          path: canonical,
          mode: status.mode & 0o777,
          digest: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        }),
      );
    }
    if (new Set(identities).size !== identities.length)
      throw new Error(`duplicate-verification-input: ${kind}`);
    records[kind] = identities.sort();
  }
  return {
    identity: createHash("sha256")
      .update(JSON.stringify(records))
      .digest("hex"),
    groups: records,
  };
}
