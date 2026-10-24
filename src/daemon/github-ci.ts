import { setTimeout as delay } from "node:timers/promises";
import { githubText } from "./github-calls.ts";
import { githubRead } from "./github-retry.ts";
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

function requiredChecks(operation: Operation): Set<string> | undefined {
  const setting =
    operation.settings.environment?.["CLOVING_REQUIRED_CHECKS"] ??
    process.env["CLOVING_REQUIRED_CHECKS"];
  if (setting === undefined) return undefined;
  const names: unknown = JSON.parse(setting);
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

export async function waitForCi(
  operation: Operation,
  commit: string,
): Promise<CiResult | undefined> {
  const {
    pollMilliseconds: poll,
    ciGraceMilliseconds: grace,
    ciLimitMilliseconds: limit,
  } = {
    ...githubTiming,
    ciGraceMilliseconds: 60_000,
    ciLimitMilliseconds: 5_400_000,
    ...operation.settings.timing,
  };
  const started = Date.now();
  const required = requiredChecks(operation);
  const names = new Set(required);
  for (;;) {
    const checks = latestRuns(await checkRuns(operation, commit), required);
    for (const check of checks) names.add(check.name);
    const failed = checks.filter(
      (check) =>
        check.status === "completed" && !passing.has(check.conclusion ?? ""),
    );
    if (failed.length > 0)
      return {
        reason: "ci-failed",
        output: await failedOutput(operation, failed),
      };
    const pending = pendingChecks(checks, names);
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
