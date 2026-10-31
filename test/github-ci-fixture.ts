import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calls } from "../src/daemon/github-calls.ts";
import { merge } from "../src/daemon/github-merge.ts";
import { git } from "./claude-worker-fixture.ts";
import { opened, type GithubScene } from "./github-worker-fixture.ts";
import { waitForCi } from "../src/daemon/github-ci.ts";
import type {
  GithubTiming,
  Operation,
} from "../src/daemon/github-operation.ts";

export function checkRun(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: 101,
    name: "quality_linux",
    app: { slug: "github-actions" },
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/acme/demo/actions/runs/88/job/101",
    ...overrides,
  };
}

export function workflowRun(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: 88,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

interface CiScenarioOptions {
  readonly workflowFiles?: Readonly<Record<string, string>>;
  readonly changedPaths?: readonly string[];
  readonly baseBranch?: string;
  readonly workflowSnapshots?: readonly (readonly unknown[])[];
  readonly workflowPages?: unknown;
  readonly workflowStatePages?: unknown;
  readonly requiredChecks?: readonly string[] | null;
  readonly snapshots: readonly (readonly unknown[])[];
  readonly pages?: unknown;
  readonly folder?: string;
  readonly workflow?: () => unknown;
  readonly attemptJobs?: readonly number[];
  readonly jobPages?: unknown;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timing?: Partial<GithubTiming>;
  readonly signal?: AbortSignal;
  readonly onCheck?: () => void;
  readonly reply?: (parts: readonly string[]) => string;
}

function attemptJobsReply(options: CiScenarioOptions): string {
  if (Object.hasOwn(options, "jobPages"))
    return JSON.stringify(options.jobPages);
  const checks = options.snapshots.at(-1) ?? [];
  const ids =
    options.attemptJobs ??
    checks.map((check) => Number(Reflect.get(Object(check), "id")));
  return JSON.stringify([
    {
      jobs: ids.map((id) => ({
        check_run_url: `https://api.github.com/repos/acme/demo/check-runs/${String(id)}`,
      })),
    },
  ]);
}

function checkRunsReply(options: CiScenarioOptions, times: number[]): string {
  const checks =
    options.snapshots[Math.min(times.length, options.snapshots.length - 1)] ??
    [];
  times.push(Date.now());
  options.onCheck?.();
  return JSON.stringify(
    Object.hasOwn(options, "pages") ? options.pages : [{ check_runs: checks }],
  );
}

function workflowRunsReply(
  options: CiScenarioOptions,
  times: readonly number[],
): string {
  if (Object.hasOwn(options, "workflowPages"))
    return JSON.stringify(options.workflowPages);
  const index = Math.max(0, times.length - 1);
  const checks =
    options.snapshots[Math.min(index, options.snapshots.length - 1)] ?? [];
  const pending = checks.some(
    (check) => Reflect.get(Object(check), "status") !== "completed",
  );
  const runs =
    options.workflowSnapshots?.[
      Math.min(index, options.workflowSnapshots.length - 1)
    ] ??
    (checks.length === 0
      ? []
      : Object.keys(options.workflowFiles ?? {}).map((path) =>
          workflowRun({
            path,
            status: pending ? "in_progress" : "completed",
            conclusion: pending ? null : "success",
          }),
        ));
  return JSON.stringify([{ workflow_runs: runs }]);
}

export function workflowStatesReply(options: {
  readonly workflowFiles?: Readonly<Record<string, string>>;
  readonly workflowStatePages?: unknown;
}): string {
  if (Object.hasOwn(options, "workflowStatePages"))
    return JSON.stringify(options.workflowStatePages);
  return JSON.stringify([
    {
      workflows: Object.keys(options.workflowFiles ?? {}).map((path) => ({
        path,
        state: "active",
      })),
    },
  ]);
}

function actionsReply(
  options: CiScenarioOptions,
  request: {
    readonly parts: readonly string[];
    readonly times: readonly number[];
  },
): string | undefined {
  const has = (text: string): boolean =>
    request.parts.some((part) => part.includes(text));
  if (has("/actions/workflows?")) return workflowStatesReply(options);
  if (has("/actions/runs?")) return workflowRunsReply(options, request.times);
  if (has("/attempts/")) return attemptJobsReply(options);
  if (has("/actions/runs/"))
    return JSON.stringify(
      options.workflow?.() ?? { run_attempt: 2, status: "completed" },
    );
  return undefined;
}

function ciReply(
  options: CiScenarioOptions,
  observed: { readonly calls: (readonly string[])[]; readonly times: number[] },
): Operation["calls"]["gh"] {
  return async (parts) => {
    observed.calls.push(parts);
    const actions = actionsReply(options, { parts, times: observed.times });
    if (actions !== undefined) return actions;
    if (!parts.some((part) => part.includes("/check-runs")))
      return Promise.resolve(
        options.reply?.(parts) ??
          JSON.stringify({
            base: { ref: options.baseBranch ?? "main", sha: "b".repeat(40) },
          }),
      );
    return Promise.resolve(checkRunsReply(options, observed.times));
  };
}

function ciGitReply(
  options: CiScenarioOptions,
  gitCalls: (readonly string[])[],
): Operation["calls"]["git"] {
  return (_directory, parts) => {
    gitCalls.push(parts);
    const files = options.workflowFiles ?? {};
    if (parts[0] === "fetch") return Promise.resolve("");
    if (parts[0] === "ls-tree")
      return Promise.resolve(Object.keys(files).join("\0"));
    if (parts[0] === "diff")
      return Promise.resolve(
        (options.changedPaths ?? ["src/main.ts"]).join("\0"),
      );
    const path = (parts[1] ?? "").split(":").slice(1).join(":");
    if (parts[0] === "show" && Object.hasOwn(files, path))
      return Promise.resolve(files[path] ?? "");
    return Promise.reject(new Error("unexpected git call"));
  };
}

export async function ciScenario(options: CiScenarioOptions): Promise<{
  readonly result: Awaited<ReturnType<typeof waitForCi>>;
  readonly calls: readonly (readonly string[])[];
  readonly gitCalls: readonly (readonly string[])[];
  readonly times: readonly number[];
}> {
  const calls: (readonly string[])[] = [];
  const gitCalls: (readonly string[])[] = [];
  const times: number[] = [];
  const folder =
    options.folder ?? (await mkdtemp(join(tmpdir(), "cloving-ci-")));
  const operation: Operation = {
    target: "ticket/one",
    payload: { number: 1 },
    folder,
    signal: options.signal ?? new AbortController().signal,
    settings: {
      repository: folder,
      ...(options.requiredChecks === undefined
        ? {}
        : { requiredChecks: options.requiredChecks }),
      worktrees: "/worktrees",
      gh: ["gh"],
      environment: options.environment ?? {},
      timing: {
        pollMilliseconds: 5,
        triggerMilliseconds: 10,
        limitMilliseconds: 20,
        ...options.timing,
      },
    },
    calls: {
      gh: ciReply(options, { calls, times }),
      git: ciGitReply(options, gitCalls),
      run: () => Promise.reject(new Error("unexpected local check")),
    },
  };
  try {
    return {
      result: await waitForCi(operation, "a".repeat(40)),
      calls,
      gitCalls,
      times,
    };
  } finally {
    if (options.folder === undefined)
      await rm(folder, { recursive: true, force: true });
  }
}

export function runningRunReply(parts: readonly string[]): string {
  if (parts.includes("--json"))
    return JSON.stringify({
      jobs: [
        {
          databaseId: 101,
          steps: [{ name: "Quality", conclusion: "failure" }],
        },
      ],
    });
  if (parts[0] === "api") return "failed job assertion";
  throw Object.assign(new Error("github-call-failed"), {
    detail: "run 88 is still in progress",
  });
}

export async function movingCiScenario(
  scene: GithubScene,
  options: { readonly moves: number; readonly conclusion: string },
) {
  const commit = await opened(scene, scene.worker());
  const signal = new AbortController().signal;
  const settings = {
    repository: scene.repository,
    worktrees: scene.worktrees,
    gh: ["fake-gh"],
    check: ["fake-check"],
  };
  const checked: string[] = [];
  const ci: string[] = [];
  let base = "";
  const operation = {
    target: "ticket/one",
    payload: {},
    folder: `${scene.directory}/merge`,
    signal,
    settings,
    calls: {
      ...calls(settings, signal),
      gh: (parts: readonly string[]) => {
        const endpoint = parts.find((part) => part.includes("/check-runs"));
        if (endpoint === undefined) return Promise.resolve(scene.gh(parts));
        ci.push(endpoint);
        if (ci.length <= options.moves) {
          git(scene.repository, [
            "commit",
            "-qm",
            "Move during CI",
            "--allow-empty",
          ]);
          git(scene.repository, ["push", "--quiet", "origin", "main"]);
          base = git(scene.repository, ["rev-parse", "HEAD"]);
        }
        const check = checkRun({
          conclusion: ci.length === 1 ? "success" : options.conclusion,
          details_url: null,
        });
        return Promise.resolve(JSON.stringify([{ check_runs: [check] }]));
      },
      run: (_command: readonly string[], directory: string) => {
        checked.push(git(directory, ["rev-parse", "HEAD"]));
        return Promise.resolve("");
      },
    },
  };
  return {
    result: await merge(operation, { number: 1, commit }),
    commit,
    base,
    checked,
    ci,
  };
}
