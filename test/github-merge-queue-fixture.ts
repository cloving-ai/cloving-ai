import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservationReport } from "../src/service/worker-port.ts";
import { git } from "./claude-worker-fixture.ts";
import { committed, type GithubScene } from "./github-worker-fixture.ts";

export function queueCalls(
  scene: GithubScene,
  mutation: string,
): readonly (readonly string[])[] {
  return scene
    .state()
    .calls.filter(
      (call) =>
        call[1] === "graphql" &&
        call.some((part) => part.includes(`${mutation}(`)),
    );
}

export function settleQueue(
  scene: GithubScene,
  result: "merged" | "removed",
): void {
  writeFileSync(join(scene.directory, "gh-state.json.queue"), result);
}

export function queued(scene: GithubScene): boolean {
  return Boolean(scene.state().prs[0]?.["queue"]);
}

export function conflictingBase(scene: GithubScene): void {
  committed(scene.repository, { name: "one.ts", text: "2;\n" });
  git(scene.repository, ["push", "--quiet", "origin", "main"]);
}

export function queueWorker(
  scene: GithubScene,
  overrides: Parameters<GithubScene["worker"]>[0] = {},
): ReturnType<GithubScene["worker"]> {
  return scene.worker({
    mergeMode: "queue",
    check: [process.execPath, "-e", ""],
    ...overrides,
  });
}

export function observer(): {
  readonly reports: ObservationReport[];
  readonly observe: (
    report: ObservationReport,
  ) => Promise<{ readonly kind: string }>;
} {
  const reports: ObservationReport[] = [];
  return {
    reports,
    observe: (report) => {
      reports.push(report);
      return Promise.resolve({ kind: "accepted" });
    },
  };
}

interface GroupRun {
  readonly id: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly event: string;
  readonly created_at: string;
}

interface CheckRunReply {
  readonly id: number;
  readonly name: string;
  readonly app: { readonly slug: string };
  readonly status: string;
  readonly conclusion: string;
  readonly details_url: string;
}

export const earlierAttempt = "2026-01-01T00:00:00Z";

export function groupRuns(
  runs: readonly {
    readonly id: number;
    readonly branch: string;
    readonly created?: string;
  }[],
): { readonly workflow_runs: readonly GroupRun[] } {
  const thisAttempt = new Date(Date.now() + 86_400_000).toISOString();
  return {
    workflow_runs: runs.map((run) => ({
      id: run.id,
      head_branch: run.branch,
      head_sha: String(run.id).repeat(20).slice(0, 40),
      event: "merge_group",
      created_at: run.created ?? thisAttempt,
    })),
  };
}

export function checkRuns(
  conclusion: string,
): readonly { readonly check_runs: readonly CheckRunReply[] }[] {
  return [
    {
      check_runs: [
        {
          id: 101,
          name: "quality_linux",
          app: { slug: "github-actions" },
          status: "completed",
          conclusion,
          details_url: "https://github.com/acme/demo/actions/runs/77/job/101",
        },
      ],
    },
  ];
}
