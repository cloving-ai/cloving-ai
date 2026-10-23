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

export async function ciScenario(options: {
  readonly snapshots: readonly (readonly unknown[])[];
  readonly pages?: unknown;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timing?: Partial<GithubTiming>;
  readonly signal?: AbortSignal;
  readonly reply?: (parts: readonly string[]) => string;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof waitForCi>>;
  readonly calls: readonly (readonly string[])[];
  readonly times: readonly number[];
}> {
  const calls: (readonly string[])[] = [];
  const times: number[] = [];
  const operation: Operation = {
    target: "ticket/one",
    payload: {},
    folder: "/journal",
    signal: options.signal ?? new AbortController().signal,
    settings: {
      repository: "/repository",
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
      gh: async (parts) => {
        calls.push(parts);
        if (
          parts[0] !== "api" ||
          !parts.some((part) => part.includes("/check-runs"))
        )
          return Promise.resolve(options.reply?.(parts) ?? "{}");
        const checks =
          options.snapshots[
            Math.min(times.length, options.snapshots.length - 1)
          ] ?? [];
        times.push(Date.now());
        return Promise.resolve(
          JSON.stringify(
            Object.hasOwn(options, "pages")
              ? options.pages
              : [{ check_runs: checks }],
          ),
        );
      },
      git: () => Promise.reject(new Error("unexpected git call")),
      run: () => Promise.reject(new Error("unexpected local check")),
    },
  };
  return { result: await waitForCi(operation, "a".repeat(40)), calls, times };
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
