import { setTimeout as delay } from "node:timers/promises";
import {
  field,
  githubTiming,
  repositoryPath,
  type Operation,
} from "./github-operation.ts";
import { githubRead, retryGithub } from "./github-retry.ts";

export type MergeCheck = "beforeMerge" | null;

export interface ReviewedPull {
  readonly number: number;
  readonly commit: string;
  readonly check?: MergeCheck | undefined;
}

function commitOf(value: unknown, name: string): string {
  if (typeof value !== "object" || value === null)
    throw new Error("github-call-failed");
  const commit: unknown = Reflect.get(value, name);
  if (typeof commit !== "string") throw new Error("github-call-failed");
  return commit;
}

export async function knownMerge(
  operation: Operation,
  expected: ReviewedPull & { readonly updated: string },
): Promise<{
  readonly head: string;
  readonly open: boolean;
  readonly merged: string | undefined;
}> {
  const pull: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      `${repositoryPath}/pulls/${String(expected.number)}`,
    ]),
  );
  const head = commitOf(field(pull, "head"), "sha");
  const open = field(pull, "state") === "open";
  if (field(pull, "merged") !== true) return { head, open, merged: undefined };
  if (head !== expected.commit && head !== expected.updated)
    throw new Error("merged-other-commit");
  return { head, open, merged: commitOf(pull, "merge_commit_sha") };
}

async function mergedNow(
  operation: Operation,
  pull: ReviewedPull,
): Promise<string> {
  const reply: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      "-X",
      "PUT",
      `${repositoryPath}/pulls/${String(pull.number)}/merge`,
      "-f",
      "merge_method=merge",
      "-f",
      `sha=${pull.commit}`,
    ]),
  );
  return commitOf(reply, "sha");
}

async function waitForHead(
  operation: Operation,
  pull: ReviewedPull,
): Promise<void> {
  const timing = operation.settings.timing ?? githubTiming;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0)
      await delay(timing.pollMilliseconds, undefined, {
        signal: operation.signal,
      });
    const current: unknown = JSON.parse(
      await githubRead(operation, [
        "api",
        `${repositoryPath}/pulls/${String(pull.number)}`,
      ]),
    );
    if (commitOf(field(current, "head"), "sha") === pull.commit) return;
  }
  throw new Error("head-not-updated");
}

export function mergePull(
  operation: Operation,
  pull: ReviewedPull & { readonly updated: string },
): Promise<string | Error> {
  return retryGithub(operation, {
    action: async (attempt) => {
      const known = attempt > 0 ? await knownMerge(operation, pull) : undefined;
      if (known?.merged !== undefined) return known.merged;
      const updated = { number: pull.number, commit: pull.updated };
      if (pull.updated !== pull.commit) await waitForHead(operation, updated);
      return mergedNow(operation, updated);
    },
    statuses: pull.updated === pull.commit ? [] : [405, 409],
  }).catch(async (error: unknown) => {
    if (!(error instanceof Error)) throw error;
    const refused =
      error.message === "github-call-failed" &&
      [405, 409].includes(Number(field(error, "status")));
    if (error.message !== "github-network-failed" && !refused) throw error;
    const known = await knownMerge(operation, pull);
    if (known.merged !== undefined) return known.merged;
    if (refused && known.open) return error;
    throw error;
  });
}
