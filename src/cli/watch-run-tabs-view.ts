import { Commands } from "./command-effects.ts";
import { effectBudgetText } from "./command-waits.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { WatchRun, WatchTurn } from "./watch-render.ts";
import { RunTotals } from "./watch-run-parts.ts";
import {
  Transcript,
  type RunTab,
  type TranscriptControls,
} from "./watch-transcript-view.ts";
import { Events, PullRequest, Review, Turn } from "./watch-turn.ts";

export function RunTabs(props: {
  readonly tab: RunTab;
  readonly controls: TranscriptControls | undefined;
  readonly events: number;
}): Shown {
  const names: readonly (readonly [RunTab, string])[] = [
    ["transcript", "Transcript"],
    ["turn", "Agent turn"],
    ["pull", "Pull request"],
    ["events", `Events (${String(props.events)})`],
    ["details", "Details"],
  ];
  return element("div", {
    class: "run-tabs",
    role: "tablist",
    "aria-label": "Run views",
    children: names.map(([name, label]) =>
      element("button", {
        key: name,
        type: "button",
        role: "tab",
        id: `run-tab-${name}`,
        "aria-selected": String(name === props.tab),
        "aria-controls": `run-panel-${name}`,
        class: "run-tab",
        onClick: () => {
          props.controls?.onTab(name);
        },
        children: label,
      }),
    ),
  });
}

export function chainText(run: WatchRun): string {
  if (run.chain === undefined) return "";
  const place = `run ${String(run.chain.position)} of ${String(run.chain.limit)}`;
  return run.chainId === undefined ? place : `${place} · ${run.chainId}`;
}

export function RunDetails(props: { readonly run: WatchRun }): Shown {
  const { run } = props;
  const rows: readonly (readonly [string, string])[] = [
    ["Reason", `${run.code}: ${run.detail}`],
    ["Run", run.runId],
    ["Turn target", run.turns[0]?.target ?? ""],
    ["Workflow", run.workflowId],
    ["Effect units", effectBudgetText(run.spent, run.limit)],
    ["Chain", chainText(run)],
    ["Parent run", run.parentRunId ?? ""],
    ["Continued from", run.continuedFrom ?? ""],
    ["Continued by", run.continuedBy ?? ""],
    ["Title source", run.titleSource ?? ""],
    ["Label source", run.labelSource ?? ""],
  ];
  return [
    component(RunTotals, { run }),
    element("dl", {
      class: "run-details",
      children: rows
        .filter(([, value]) => value !== "")
        .flatMap(([name, value]) => [
          element("dt", { children: name }),
          element("dd", { children: value }),
        ]),
    }),
  ];
}

export function RunPull(props: { readonly run: WatchRun }): Shown {
  const { run } = props;
  return [
    run.pullRequest === null
      ? element("p", {
          class: "meta",
          children: "No pull request for this run.",
        })
      : component(PullRequest, { run }),
    (run.ciReruns ?? []).map((rerun) =>
      element("p", {
        class: "meta",
        children: `CI rerun after a failed check: workflow ${rerun.run}, commit ${rerun.commit.slice(0, 7)}`,
      }),
    ),
  ];
}

export function RunTurns(props: {
  readonly run: WatchRun;
  readonly now: string;
  readonly transcripts: TranscriptControls | undefined;
  readonly turnId: string | null;
}): Shown {
  const { run, now } = props;
  const tab = props.transcripts?.tab ?? "transcript";
  const panel = (name: RunTab, children: Shown) =>
    element("div", {
      role: "tabpanel",
      id: `run-panel-${name}`,
      "aria-labelledby": `run-tab-${name}`,
      hidden: name !== tab,
      children,
    });
  const turns = (part: (item: WatchTurn) => Shown): Shown =>
    run.turns.length === 0
      ? element("p", { class: "meta", children: "No agent turn for this run." })
      : run.turns.map((item, index) => [
          part(item),
          component(Review, {
            key: `review-${item.key}`,
            run,
            round: index + 1,
          }),
        ]);
  return [
    component(RunTabs, {
      tab,
      controls: props.transcripts,
      events: run.events.length,
    }),
    panel(
      "transcript",
      turns((item) =>
        component(Transcript, {
          key: `transcript-${item.key}`,
          run,
          turn: item,
          turnId: props.turnId,
          controls: props.transcripts,
          now,
        }),
      ),
    ),
    panel(
      "turn",
      turns((item) => component(Turn, { key: item.key, turn: item, now })),
    ),
    panel("pull", component(RunPull, { run })),
    panel("events", [
      component(Commands, { effects: run.commandEffects ?? [] }),
      component(Events, { events: run.events }),
    ]),
    panel("details", component(RunDetails, { run })),
  ];
}

export const runTabsFunctions = [
  RunTabs,
  chainText,
  RunDetails,
  RunPull,
  RunTurns,
];
