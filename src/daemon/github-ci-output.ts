import { githubText } from "./github-calls.ts";
import { field, repositoryPath, type Operation } from "./github-operation.ts";

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app: { readonly slug: string } | null;
  readonly details_url: string | null;
}

export const passing = new Set(["success", "neutral", "skipped"]);

export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
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

export async function failedOutput(
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
