import { settingsEnvironment } from "../cli/project-settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import { githubText } from "./github-calls.ts";
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

export interface CiResult {
  readonly reason: "ci-failed" | "ci-pending";
  readonly output: string;
}

interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app: { readonly slug: string } | null;
  readonly details_url: string | null;
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

const passing = new Set(["success", "neutral", "skipped"]);

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

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
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

function unavailable(operation: Operation, error: unknown): string {
  operation.signal.throwIfAborted();
  const detail = field(error, "detail");
  return `CI diagnostics unavailable: ${githubText(typeof detail === "string" ? detail : "GitHub logs could not be read", operation.settings)}`;
}

async function failedSteps(
  operation: Operation,
  place: { readonly run: string; readonly job: string | undefined },
): Promise<string> {
  try {
    const view: unknown = JSON.parse(
      await operation.calls.gh(["run", "view", place.run, "--json", "jobs"]),
    );
    return list(field(view, "jobs"))
      .filter((job) => String(field(job, "databaseId")) === place.job)
      .flatMap((job) => list(field(job, "steps")))
      .filter(
        (step) =>
          typeof field(step, "conclusion") === "string" &&
          !passing.has(String(field(step, "conclusion"))),
      )
      .map((step) => `Failed step: ${String(field(step, "name"))}`)
      .join("\n");
  } catch (error) {
    return unavailable(operation, error);
  }
}

async function failedCheck(
  operation: Operation,
  check: CheckRun,
): Promise<{ readonly summary: string; readonly log: string }> {
  const summary = [
    `Failed check: ${check.name} (${check.conclusion ?? "null"})`,
  ];
  const details = check.details_url ?? "";
  const run = /\/actions\/runs\/(\d+)/.exec(details)?.[1];
  let log = "Failed log unavailable.";
  if (run !== undefined) {
    const job = /\/job\/(\d+)/.exec(details)?.[1];
    summary.push(await failedSteps(operation, { run, job }));
    log = await failedLog(operation, { run, job });
  }
  return {
    summary: githubText(summary.join("\n"), operation.settings),
    log: githubText(log, operation.settings),
  };
}

async function failedLog(
  operation: Operation,
  place: { readonly run: string; readonly job: string | undefined },
): Promise<string> {
  try {
    return await operation.calls.gh([
      "run",
      "view",
      place.run,
      "--log-failed",
      ...(place.job === undefined ? [] : ["--job", place.job]),
    ]);
  } catch (error) {
    operation.signal.throwIfAborted();
    if (place.job === undefined) return unavailable(operation, error);
    return operation.calls
      .gh(["api", `${repositoryPath}/actions/jobs/${place.job}/logs`])
      .catch((failure: unknown) => unavailable(operation, failure));
  }
}

async function failedOutput(
  operation: Operation,
  checks: readonly CheckRun[],
): Promise<string> {
  const reports = [];
  for (const check of checks) reports.push(await failedCheck(operation, check));
  const summary = reports.map((report) => report.summary).join("\n");
  const available = Math.max(0, 6_000 - summary.length - reports.length);
  const allowance = Math.floor(available / reports.length);
  return [
    summary,
    ...reports.map((report) =>
      allowance === 0 ? "" : report.log.slice(-allowance),
    ),
  ]
    .join("\n")
    .slice(0, 6_000);
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
    const failed = checks.filter(
      (check) =>
        check.status === "completed" && !passing.has(check.conclusion ?? ""),
    );
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
