import { field, repositoryPath, type Operation } from "./github-operation.ts";
import { githubRead } from "./github-retry.ts";
import { operationKey, writeRecord } from "./operation-journal.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CiRerun {
  readonly run: string;
  readonly requestedAt: number;
  readonly output: string;
}

export interface CiWait {
  readonly commit: string;
  readonly startedAt: number;
  readonly reruns: CiRerun[];
}

function isRerun(value: unknown): value is CiRerun {
  return (
    typeof field(value, "run") === "string" &&
    /^\d+$/.test(String(field(value, "run"))) &&
    typeof field(value, "requestedAt") === "number" &&
    typeof field(value, "output") === "string"
  );
}

export async function ciWait(
  operation: Operation,
  commit: string,
): Promise<CiWait> {
  const text = await readFile(
    join(operation.folder, `ci-${operationKey(commit)}.json`),
    "utf8",
  ).catch((error: unknown) => {
    if (field(error, "code") === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return { commit, startedAt: Date.now(), reruns: [] };
  const stored: unknown = JSON.parse(text);
  const startedAt = field(stored, "startedAt");
  const reruns = field(stored, "reruns");
  if (
    field(stored, "commit") !== commit ||
    typeof startedAt !== "number" ||
    !Array.isArray(reruns) ||
    !reruns.every(isRerun)
  )
    throw new Error("github-call-failed");
  return { commit, startedAt, reruns };
}

export async function workflowAttempt(
  operation: Operation,
  run: string,
): Promise<{ readonly attempt: number; readonly status: string }> {
  const value: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      `${repositoryPath}/actions/runs/${run}`,
    ]),
  );
  const attempt = field(value, "run_attempt");
  const status = field(value, "status");
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof status !== "string"
  )
    throw new Error("github-call-failed");
  return { attempt, status };
}

export async function attemptChecks(
  operation: Operation,
  workflow: { readonly run: string; readonly attempt: number },
): Promise<ReadonlySet<number>> {
  const pages: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      "--paginate",
      "--slurp",
      `${repositoryPath}/actions/runs/${workflow.run}/attempts/${String(workflow.attempt)}/jobs?per_page=100`,
    ]),
  );
  if (!Array.isArray(pages) || pages.length === 0)
    throw new Error("github-call-failed");
  const ids = new Set<number>();
  for (const page of pages) {
    const jobs = field(page, "jobs");
    if (!Array.isArray(jobs)) throw new Error("github-call-failed");
    for (const job of jobs) {
      const id = /\/check-runs\/(\d+)$/.exec(
        String(field(job, "check_run_url")),
      )?.[1];
      if (id === undefined) throw new Error("github-call-failed");
      ids.add(Number(id));
    }
  }
  return ids;
}

export async function rerunCi(
  operation: Operation,
  request: {
    readonly wait: CiWait;
    readonly rerun: CiRerun;
    readonly deadline: number;
  },
): Promise<void> {
  const { wait, rerun } = request;
  wait.reruns.push(rerun);
  await writeRecord(operation.folder, {
    name: `ci-${operationKey(wait.commit)}.json`,
    value: wait,
    permissions: "private",
  });
  if (Date.now() >= request.deadline) return;
  try {
    await operation.calls.gh(["run", "rerun", rerun.run, "--failed"]);
  } catch (error) {
    operation.signal.throwIfAborted();
    throw Object.assign(new Error("github-network-failed", { cause: error }), {
      detail: field(error, "detail"),
    });
  }
}

export function attemptOutput(attempts: readonly string[]): string {
  const allowance = Math.floor(6_000 / attempts.length) - 40;
  return attempts
    .map(
      (output, index) =>
        `Attempt ${String(index + 1)}:\n${output.length <= allowance ? output : output.slice(0, 400) + "\n…\n" + output.slice(-(allowance - 404))}`,
    )
    .join("\n");
}
