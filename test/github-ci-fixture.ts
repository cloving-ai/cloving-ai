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
