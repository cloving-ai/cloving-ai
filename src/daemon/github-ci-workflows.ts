import { pullRequestTrigger, workflowApplies } from "./github-ci-filters.ts";
import { field, repositoryPath, type Operation } from "./github-operation.ts";
import { githubRead } from "./github-retry.ts";

async function pullBase(operation: Operation): Promise<{
  readonly base: string;
  readonly branch: string;
}> {
  const pull: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      `${repositoryPath}/pulls/${String(operation.payload["number"])}`,
    ]),
  );
  if (typeof pull !== "object" || pull === null || !("base" in pull))
    throw new Error("github-call-failed");
  const baseData: unknown = pull.base;
  if (typeof baseData !== "object" || baseData === null)
    throw new Error("github-call-failed");
  const base = field(baseData, "sha");
  const branch = field(baseData, "ref");
  if (
    typeof base !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(base) ||
    typeof branch !== "string"
  )
    throw new Error("github-call-failed");
  return { base, branch };
}

async function appliesToPull(
  operation: Operation,
  input: { readonly commit: string; readonly trigger: unknown },
): Promise<boolean> {
  const { commit, trigger } = input;
  if (trigger === false) return false;
  if (typeof trigger !== "object" || trigger === null) return true;
  if (
    !["paths", "paths-ignore", "branches", "branches-ignore"].some((key) =>
      Object.hasOwn(trigger, key),
    )
  )
    return true;
  const { base, branch } = await pullBase(operation);
  await operation.calls.git(operation.settings.repository, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    base,
  ]);
  const paths = await operation.calls.git(operation.settings.repository, [
    "diff",
    "--name-only",
    "-z",
    `${base}...${commit}`,
  ]);
  return workflowApplies(trigger, {
    branch,
    paths: paths.split("\0").filter((path) => path !== ""),
  });
}

export async function pullRequestWorkflows(
  operation: Operation,
  commit: string,
): Promise<readonly string[]> {
  const read = (parts: readonly string[]): Promise<string> =>
    operation.calls.git(operation.settings.repository, parts);
  const paths = await read([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    ".github/workflows",
  ]);
  const workflows: string[] = [];
  for (const path of paths.split("\0")) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    const source = await read(["show", `${commit}:${path}`]);
    if (
      await appliesToPull(operation, {
        commit,
        trigger: pullRequestTrigger(source),
      })
    )
      workflows.push(path);
  }
  if (workflows.length === 0) return workflows;
  const inactive = await inactiveWorkflows(operation);
  return workflows.filter((path) => !inactive.has(path));
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function actionPages(
  operation: Operation,
  request: { readonly path: string; readonly key: string },
): Promise<readonly unknown[]> {
  const pages: unknown = JSON.parse(
    await githubRead(operation, ["api", "--paginate", "--slurp", request.path]),
  );
  if (!isList(pages) || pages.length === 0)
    throw new Error("github-call-failed");
  return pages.flatMap((page) => {
    const items = field(page, request.key);
    if (!isList(items)) throw new Error("github-call-failed");
    return items;
  });
}

async function inactiveWorkflows(
  operation: Operation,
): Promise<ReadonlySet<string>> {
  const workflows = await actionPages(operation, {
    path: `${repositoryPath}/actions/workflows?per_page=100`,
    key: "workflows",
  });
  const inactive = new Set<string>();
  for (const workflow of workflows) {
    const path = field(workflow, "path");
    const state = field(workflow, "state");
    if (typeof path !== "string" || typeof state !== "string")
      throw new Error("github-call-failed");
    if (state !== "active") inactive.add(path);
  }
  return inactive;
}

interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly head_sha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (typeof value !== "object" || value === null) return false;
  const conclusion = field(value, "conclusion");
  return (
    typeof field(value, "id") === "number" &&
    ["path", "head_sha", "event", "status"].every(
      (key) => typeof field(value, key) === "string",
    ) &&
    (conclusion === null || typeof conclusion === "string")
  );
}

async function workflowRuns(
  operation: Operation,
  commit: string,
): Promise<readonly WorkflowRun[]> {
  const runs = await actionPages(operation, {
    path: `${repositoryPath}/actions/runs?head_sha=${commit}&event=pull_request&per_page=100`,
    key: "workflow_runs",
  });
  if (!runs.every(isWorkflowRun)) throw new Error("github-call-failed");
  return runs;
}

export async function pendingWorkflows(
  operation: Operation,
  input: { readonly commit: string; readonly paths: readonly string[] },
): Promise<readonly string[]> {
  if (input.paths.length === 0) return [];
  const latest = new Map<string, WorkflowRun>();
  for (const run of await workflowRuns(operation, input.commit)) {
    if (run.head_sha !== input.commit || run.event !== "pull_request") continue;
    const path = input.paths
      .filter(
        (expected) =>
          run.path === expected || run.path.startsWith(`${expected}@`),
      )
      .sort((left, right) => right.length - left.length)[0];
    if (path === undefined) continue;
    if (run.id > (latest.get(path)?.id ?? -1)) latest.set(path, run);
  }
  const pending = input.paths.filter((path) => {
    const run = latest.get(path);
    return (
      run?.status !== "completed" ||
      !["success", "neutral", "skipped"].includes(run.conclusion ?? "")
    );
  });
  return pending.length === 0 ? [] : ["waiting for GitHub Actions checks"];
}
