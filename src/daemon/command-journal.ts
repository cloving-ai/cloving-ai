import { randomUUID } from "node:crypto";
import { link, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { located, readRecord } from "./operation-journal.ts";
import { record } from "../protocol.ts";
import type { CommandEffect } from "../command-settings.ts";

function alreadyExists(error: unknown): boolean {
  if (Reflect.get(Object(error), "code") === "EEXIST") return false;
  throw error;
}

export async function claimCommand(folder: string): Promise<boolean> {
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  return mkdir(folder, { mode: 0o700 }).then(() => true, alreadyExists);
}

export async function commandStarted(folder: string): Promise<boolean> {
  return stat(folder).then(
    () => true,
    (error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return false;
      throw error;
    },
  );
}

export async function recordCommandResult(
  folder: string,
  value: unknown,
): Promise<boolean> {
  const staged = join(folder, `${randomUUID()}.staged`);
  await writeFile(staged, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    return await link(staged, join(folder, "result.json")).then(
      () => true,
      alreadyExists,
    );
  } finally {
    await rm(staged);
  }
}

export async function commandEffects(
  journal: string,
  effects: readonly CommandEffect[],
): Promise<readonly CommandEffect[]> {
  return Promise.all(
    effects.map(async (effect) => {
      const { folder } = located(journal, effect.operationId);
      const result = record(await readRecord(folder, "result.json"));
      const exitCode = result?.["exitCode"];
      const duration = result?.["durationMilliseconds"];
      return {
        ...effect,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        durationMilliseconds: typeof duration === "number" ? duration : null,
      };
    }),
  );
}
