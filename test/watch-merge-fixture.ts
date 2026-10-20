import { watchModel } from "../src/cli/watch-model.ts";
import type { GithubRecords, WatchInputs } from "../src/cli/watch-model.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const mergeRepository = {
  host: "github.example",
  owner: "fixture",
  repository: "demo",
};
export const mergePull = {
  number: 7,
  url: "https://github.example/fixture/demo/pull/7",
};

export function mergeJournal(
  runId: string,
  call: {
    readonly method: string;
    readonly report: unknown;
    readonly outcome?: string;
    readonly round?: number;
  },
): GithubRecords {
  return {
    started: {
      method: call.method,
      operationId: JSON.stringify([
        "cloving-operation",
        call.round ?? 1,
        runId,
        "pull-request",
        `github-${call.method}`,
        null,
        null,
      ]),
      runId,
    },
    result: {
      outcome: call.outcome ?? "completed",
      result: JSON.stringify(call.report),
    },
  };
}

export function mergedJournal(runId: string, round = 1): GithubRecords[] {
  return [
    mergeJournal(runId, { method: "open-pr", report: mergePull, round }),
    mergeJournal(runId, {
      method: "merge",
      report: { number: 7, merged: "fixture-commit" },
      round,
    }),
  ];
}

export function blockedMergeModel(
  githubRecords: readonly GithubRecords[],
  changes: Partial<WatchInputs> = {},
) {
  return watchModel({
    home: "/fixture/home",
    client: "cloving",
    updatedAt: "2026-10-14T12:00:00Z",
    service: "up",
    workflows: ["develop-issue"],
    turns: [],
    decisions: [],
    runs: [
      {
        status: {
          runId: "A",
          workflowId: "develop-issue",
          state: "completed",
          outcome: { kind: "blocked" },
          ticketId: "7",
          latestAt: "2026-10-14T12:00:00Z",
        },
        events: [{ type: "run.completed", recordedAt: "2026-10-14T10:00:00Z" }],
      },
    ],
    repository: mergeRepository,
    githubRecords,
    ...changes,
  });
}

export function mergeCard(model: ReturnType<typeof watchModel>) {
  return model.workflows
    .flatMap((workflow) => workflow.columns.flatMap((column) => column.cards))
    .find((card) => card.runId === "A");
}

export async function writeMergeRecords(
  runtime: string,
  records: readonly GithubRecords[],
): Promise<void> {
  for (const [index, record] of records.entries()) {
    const directory = join(
      dirname(runtime),
      "github",
      `merge-${String(index)}`,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "started.json"),
      JSON.stringify(record.started),
    );
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(record.result),
    );
  }
}
