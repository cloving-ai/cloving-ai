import { Commands } from "./command-effects.ts";
import { effectBudgetText } from "./command-waits.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { turnTime, type WatchRun, type WatchTurn } from "./watch-render.ts";
import { RunTotals } from "./watch-run-parts.ts";
import {
  Transcript,
  type RunTab,
  type TranscriptControls,
} from "./watch-transcript-view.ts";
import { Events, PullRequest, Review } from "./watch-turn.ts";
import { attemptText, priceText } from "./usage-render.ts";
import type { WorkerUsage } from "../worker-usage.ts";

export function runTabNames(
  events: number,
): readonly (readonly [RunTab, string])[] {
  return [
    ["transcript", "Transcript"],
    ["pull", "Pull request"],
    ["events", `Events (${String(events)})`],
    ["details", "Details"],
  ];
}

export function RunTabs(props: {
  readonly tab: RunTab;
  readonly controls: TranscriptControls | undefined;
  readonly names: readonly (readonly [RunTab, string])[];
}): Shown {
  return element("div", {
    class: "run-tabs",
    role: "tablist",
    "aria-label": "Run views",
    children: props.names.map(([name, label]) =>
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

export function DetailList(props: {
  readonly rows: readonly (readonly [string, string])[];
}): Shown {
  return element("dl", {
    class: "run-details",
    children: props.rows
      .filter(([, value]) => value !== "")
      .flatMap(([name, value]) => [
        element("dt", { children: name }),
        element("dd", { children: value }),
      ]),
  });
}

export function knownTokens(usage: WorkerUsage): string {
  const counts: readonly (readonly [string, number | null | undefined])[] = [
    ["input", usage.input_tokens],
    ["cache read", usage.cache_read_input_tokens],
    ["cache write", usage.cache_creation_input_tokens],
    ["output", usage.output_tokens],
  ];
  return counts
    .flatMap(([name, count]) =>
      typeof count === "number" ? [`${String(count)} ${name}`] : [],
    )
    .join(" · ");
}

export function TurnFacts(props: {
  readonly turn: WatchTurn;
  readonly position: number;
  readonly now: string;
}): Shown {
  const { turn, now } = props;
  const cost = priceText(turn.costUsd, turn.estimatedCostUsd);
  const head = [
    `Turn ${String(props.position)}`,
    turn.outcome,
    turnTime(turn, now),
    cost === "Price not known" ? "" : cost,
  ].filter((part) => part !== "");
  return element("section", {
    class: "turn-facts",
    children: [
      element("h4", { children: head.join(" · ") }),
      component(DetailList, {
        rows: [
          ["Branch", turn.branch],
          ["Work tree", turn.worktree],
          ["Harness", turn.harness ?? ""],
          ["Tokens", knownTokens(turn.usage)],
        ],
      }),
      (turn.attempts ?? []).map((attempt) =>
        element("p", { class: "turn-attempt", children: attemptText(attempt) }),
      ),
    ],
  });
}

export function RunDetails(props: {
  readonly run: WatchRun;
  readonly now: string;
}): Shown {
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
    component(DetailList, { rows }),
    run.turns.map((turn, index) =>
      component(TurnFacts, {
        key: turn.key,
        turn,
        position: index + 1,
        now: props.now,
      }),
    ),
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
  const names = runTabNames(run.events.length);
  const chosen = props.transcripts?.tab ?? "transcript";
  const tab = names.find(([name]) => name === chosen)?.[0] ?? "transcript";
  const panel = (name: RunTab, children: Shown) =>
    element("div", {
      role: "tabpanel",
      id: `run-panel-${name}`,
      "aria-labelledby": `run-tab-${name}`,
      hidden: name !== tab,
      children,
    });
  return [
    component(RunTabs, { tab, controls: props.transcripts, names }),
    panel(
      "transcript",
      run.turns.length === 0
        ? element("p", {
            class: "meta",
            children: "No agent turn for this run.",
          })
        : run.turns.map((item, index) => [
            component(Transcript, {
              key: `transcript-${item.key}`,
              run,
              turn: item,
              turnId: props.turnId,
              controls: props.transcripts,
              now,
            }),
            component(Review, {
              key: `review-${item.key}`,
              run,
              round: index + 1,
            }),
          ]),
    ),
    panel("pull", component(RunPull, { run })),
    panel("events", [
      component(Commands, { effects: run.commandEffects ?? [] }),
      component(Events, { events: run.events }),
    ]),
    panel("details", component(RunDetails, { run, now })),
  ];
}

export const runTabsFunctions = [
  runTabNames,
  RunTabs,
  DetailList,
  knownTokens,
  TurnFacts,
  chainText,
  RunDetails,
  RunPull,
  RunTurns,
];
