import { settingsEnvironment } from "../cli/project-settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import { githubRead } from "./github-retry.ts";
import {
  pendingWorkflows,
  pullRequestWorkflows,
} from "./github-ci-workflows.ts";
import {
  ciWait,
  workflowAttempt,
  attemptChecks,
  rerunCi,
  attemptOutput,
  type CiWait,
} from "./github-ci-rerun.ts";
import {
  field,
  githubTiming,
  repositoryPath,
  type Operation,
} from "./github-operation.ts";
import {
  failedOutput,
  list,
  passing,
  type CheckRun,
} from "./github-ci-output.ts";

export interface CiResult {
  readonly reason: "ci-failed" | "ci-pending";
  readonly output: string;
}

function isCheckRun(value: unknown): value is CheckRun {
  const conclusion = field(value, "conclusion");
  const details = field(value, "details_url");
  const app = field(value, "app");
  return (
    typeof field(value, "id") === "number" &&
    typeof field(value, "name") === "string" &&
    typeof field(value, "status") === "string" &&
    (conclusion === null || typeof conclusion === "string") &&
    (details === null || typeof details === "string") &&
    (app === null || typeof field(app, "slug") === "string")
  );
}

function latestRuns(
  checks: readonly CheckRun[],
  required: ReadonlySet<string> | undefined,
): readonly CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const check of checks) {
    const name = check.name;
    if (
      required === undefined
        ? check.app?.slug !== "github-actions"
        : !required.has(name)
    )
      continue;
    const previous = latest.get(name);
    if (previous === undefined || check.id > previous.id)
      latest.set(name, check);
  }
  return [...latest.values()];
}

async function checkRuns(
  operation: Operation,
  commit: string,
): Promise<readonly CheckRun[]> {
  const pages: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      "--paginate",
      "--slurp",
      `${repositoryPath}/commits/${commit}/check-runs?filter=all&per_page=100`,
    ]),
  );
  if (!Array.isArray(pages) || pages.length === 0)
    throw new Error("github-call-failed");
  return list(pages).flatMap((page) => {
    const checks = field(page, "check_runs");
    if (!Array.isArray(checks) || !checks.every(isCheckRun))
      throw new Error("github-call-failed");
    return checks;
  });
}

function requiredCheckNames(operation: Operation): unknown {
  if (operation.settings.requiredChecks !== undefined)
    return operation.settings.requiredChecks === null
      ? undefined
      : operation.settings.requiredChecks;
  const setting = settingsEnvironment(
    { ...process.env, ...operation.settings.environment },
    operation.settings.repository,
  )["CLOVING_REQUIRED_CHECKS"];
  return setting === undefined ? undefined : JSON.parse(setting);
}

function requiredChecks(operation: Operation): Set<string> | undefined {
  const names = requiredCheckNames(operation);
  if (names === undefined) return undefined;
  if (
    !Array.isArray(names) ||
    !names.every(
      (name: unknown): name is string =>
        typeof name === "string" && name.trim() !== "",
    )
  )
    throw new Error("invalid-payload");
  return new Set(names);
}

function pendingChecks(
  checks: readonly CheckRun[],
  names: ReadonlySet<string>,
): readonly string[] {
  return [...names].filter(
    (name) =>
      !checks.some(
        (check) => check.name === name && check.status === "completed",
      ),
  );
}

function runOf(check: CheckRun): string | undefined {
  return check.app?.slug === "github-actions"
    ? /\/actions\/runs\/(\d+)/.exec(check.details_url ?? "")?.[1]
    : undefined;
}

async function rerunBeforeDeadline(
  operation: Operation,
  request: {
    readonly wait: CiWait;
    readonly run: string;
    readonly checks: readonly CheckRun[];
    readonly deadline: number;
  },
): Promise<void> {
  if (Date.now() >= request.deadline) return;
  const output = await failedOutput(operation, request.checks);
  const requestedAt = Date.now();
  if (requestedAt >= request.deadline) return;
  await rerunCi(operation, {
    wait: request.wait,
    rerun: { run: request.run, requestedAt, output },
    deadline: request.deadline,
  });
}

async function rerunFailedChecks(
  operation: Operation,
  input: {
    readonly wait: CiWait;
    readonly failed: readonly CheckRun[];
    readonly deadline: number;
  },
): Promise<{
  readonly failures: readonly CheckRun[];
  readonly pending: readonly string[];
}> {
  const { wait, failed } = input;
  const failures = failed.filter((check) => runOf(check) === undefined);
  const pending: string[] = [];
  const runs = new Set(failed.flatMap((check) => runOf(check) ?? []));
  for (const run of runs) {
    const checks = failed.filter((check) => runOf(check) === run);
    const recorded = wait.reruns.find((rerun) => rerun.run === run);
    const workflow = await workflowAttempt(operation, run);
    if (
      workflow.attempt === 1 &&
      recorded === undefined &&
      workflow.status === "completed"
    )
      await rerunBeforeDeadline(operation, {
        wait,
        run,
        checks,
        deadline: input.deadline,
      });
    if (workflow.attempt === 1) {
      pending.push(`workflow ${run} rerun`);
      continue;
    }
    const ids = await attemptChecks(operation, {
      run,
      attempt: workflow.attempt,
    });
    const current = checks.filter((check) => ids.has(check.id));
    if (current.length === 0) {
      pending.push(`workflow ${run} rerun`);
      continue;
    }
    failures.push(...current);
  }
  return { failures, pending };
}

async function ciFailureOutput(
  operation: Operation,
  input: { readonly wait: CiWait; readonly failed: readonly CheckRun[] },
): Promise<string> {
  const { wait, failed } = input;
  const previous = wait.reruns.filter((rerun) =>
    failed.some((check) => runOf(check) === rerun.run),
  );
  const current = await failedOutput(operation, failed);
  return previous.length === 0
    ? current
    : attemptOutput([
        previous.map((rerun) => rerun.output).join("\n"),
        current,
      ]);
}

async function ciSettings(operation: Operation, commit: string) {
  const timing = {
    ...githubTiming,
    ciGraceMilliseconds: 60_000,
    ciLimitMilliseconds: 5_400_000,
    ...operation.settings.timing,
  };
  const required = requiredChecks(operation);
  const workflows =
    required === undefined ? await pullRequestWorkflows(operation, commit) : [];
  return {
    required,
    workflows,
    poll: timing.pollMilliseconds,
    limit: timing.ciLimitMilliseconds,
    grace: workflows.some((workflow) => workflow.kind === "push")
      ? Infinity
      : timing.ciGraceMilliseconds,
  };
}

function failedRun(check: CheckRun): boolean {
  return check.status === "completed" && !passing.has(check.conclusion ?? "");
}

export async function failedChecks(
  operation: Operation,
  commit: string,
): Promise<CiResult | undefined> {
  const failed = latestRuns(
    await checkRuns(operation, commit),
    requiredChecks(operation),
  ).filter(failedRun);
  if (failed.length === 0) return undefined;
  return { reason: "ci-failed", output: await failedOutput(operation, failed) };
}

export async function waitForCi(
  operation: Operation,
  commit: string,
): Promise<CiResult | undefined> {
  const wait = await ciWait(operation, commit);
  const started = wait.startedAt;
  const { required, workflows, grace, poll, limit } = await ciSettings(
    operation,
    commit,
  );
  const names = new Set(required);
  for (;;) {
    const checks = latestRuns(await checkRuns(operation, commit), required);
    for (const check of checks) names.add(check.name);
    const failed = checks.filter(failedRun);
    const retried = await rerunFailedChecks(operation, {
      wait,
      failed,
      deadline: started + limit,
    });
    if (retried.failures.length > 0)
      return {
        reason: "ci-failed",
        output: await ciFailureOutput(operation, {
          wait,
          failed: retried.failures,
        }),
      };
    const pending = [
      ...pendingChecks(checks, names),
      ...retried.pending,
      ...(await pendingWorkflows(operation, { commit, workflows })),
    ];
    if (
      pending.length === 0 &&
      (required !== undefined ||
        names.size > 0 ||
        Date.now() - started >= grace)
    )
      return undefined;
    const remaining = limit - (Date.now() - started);
    if (remaining <= 0)
      return {
        reason: "ci-pending",
        output: `CI wait limit reached for ${commit}. Pending checks: ${pending.join(", ") || "waiting for GitHub Actions checks"}`,
      };
    await delay(Math.min(poll, remaining), undefined, {
      signal: operation.signal,
    });
  }
}
