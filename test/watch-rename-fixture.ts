import { record } from "../src/protocol.ts";
import type { RenameControls } from "../src/cli/watch-rename-view.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { mergeJournal, mergeRepository } from "./watch-merge-fixture.ts";

function named(
  runId: string,
  options: Parameters<typeof floorRun>[1] & {
    readonly name: Readonly<Record<string, unknown>>;
  },
): Record<string, unknown> {
  const run = floorRun(runId, options);
  return { ...run, status: { ...record(run["status"]), ...options.name } };
}

export const promptTitle =
  "Fix the flaky retention test in record-retention-loop";
export const pullTitle = "SID-4820: Filter and page Notion database files";

export const renameModel = floorModel(
  [
    named("prompt-run", {
      operation: "claude-turn",
      minutes: 5,
      harness: "claude",
      name: {
        title: promptTitle,
        titleSource: "prompt",
        label: null,
        labelSource: null,
      },
    }),
    named("pr-run", {
      operation: "claude-turn",
      minutes: 4,
      ticketId: "583",
      name: {
        title: pullTitle,
        titleSource: "pull-request",
        label: "SID-4820",
        labelSource: "title",
      },
    }),
    named("manual-run", {
      operation: "claude-turn",
      minutes: 3,
      state: "failed",
      name: {
        title: "Own name",
        titleSource: "manual",
        label: "OWN-1",
        labelSource: "manual",
      },
    }),
  ],
  {
    repository: mergeRepository,
    githubRecords: [
      mergeJournal("pr-run", {
        method: "open-pr",
        report: {
          number: 686,
          url: "https://github.example/fixture/demo/pull/686",
        },
      }),
    ],
  },
);

export interface RenameCalls {
  readonly opened: unknown[];
  readonly saved: string[];
  readonly cleared: string[];
  readonly closed: number[];
}

export function renameControls(
  calls: RenameCalls,
  changes: Partial<RenameControls> = {},
): RenameControls {
  return {
    open: null,
    title: "",
    label: "",
    busy: [],
    messages: {},
    onOpen: (run) => {
      calls.opened.push(run);
    },
    onClose: () => {
      calls.closed.push(1);
    },
    onTitle: () => undefined,
    onLabel: () => undefined,
    onSave: (runId) => {
      calls.saved.push(runId);
    },
    onClear: (runId) => {
      calls.cleared.push(runId);
    },
    ...changes,
  };
}
