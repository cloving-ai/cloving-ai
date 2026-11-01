import { readReportGithub } from "../src/cli/report-github.ts";
import { loopReport } from "../src/report.ts";
import { githubReportFixture, output, since } from "./report-github-fixture.ts";

export const ciCommit = "a".repeat(40);
export const ciAt = "2026-10-24T10:00:00Z";
export function ciRun(id = 246, extra: Readonly<Record<string, unknown>> = {}) {
  return {
    id,
    name: "CI",
    head_branch: "feature",
    head_sha: ciCommit,
    run_attempt: 1,
    path: ".github/workflows/ci.yml",
    created_at: ciAt,
    updated_at: "2026-10-24T12:00:00Z",
    ...extra,
  };
}
export function ciJob(
  id: number,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    id,
    run_id: 246,
    head_sha: ciCommit,
    name: "quality",
    conclusion: "success",
    labels: ["self-hosted", "macOS"],
    created_at: ciAt,
    started_at: "2026-10-24T10:04:00Z",
    completed_at: "2026-10-24T10:54:00Z",
    ...extra,
  };
}
export function workflowResponse(text: string) {
  return output({
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  });
}
export function ciUsageScene(
  options: {
    readonly jobs?: readonly unknown[];
    readonly run?: Readonly<Record<string, unknown>>;
    readonly workflow?: string;
    readonly response?: unknown;
  } = {},
) {
  return githubReportFixture({
    actions: {
      "runs?per_page=100&page=1": { workflow_runs: [ciRun(246, options.run)] },
      "runs/246/attempts/1/jobs?per_page=100&page=1": {
        jobs:
          options.jobs ??
          Array.from({ length: 6 }, (_, index) => ciJob(2460 + index)),
      },
    },
    responses: {
      [`repos/fixture/demo/contents/.github/workflows/ci.yml?ref=${ciCommit}`]:
        options.response === undefined
          ? workflowResponse(
              options.workflow ??
                JSON.stringify({
                  jobs: { quality: { "timeout-minutes": 75 } },
                }),
            )
          : output(options.response),
    },
  });
}
export async function ciUsageReport(
  scene: ReturnType<typeof githubReportFixture>,
) {
  const github = await readReportGithub({
    since,
    settings: scene.settings,
    retryMilliseconds: 1,
  });
  return loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
  });
}
