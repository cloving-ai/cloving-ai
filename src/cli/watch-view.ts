import type { SteerControls } from "./watch-steer-view.ts";
import {
  RunActions,
  type RunCommandControls,
} from "./watch-run-command-view.ts";
import { RunNotes } from "./watch-notes-view.ts";
import { loopText } from "./schedule-render.ts";
import { CommandWaits, effectBudgetText } from "./command-waits.ts";
import type { CardControls } from "./watch-card-view.ts";
import type { PhoneControls } from "./watch-phone-view.ts";
import {
  BackLink,
  Header,
  Queue,
  RefusedWorkflows,
  type QueueControls,
} from "./watch-header-view.ts";
export { clove, Header, type QueueControls } from "./watch-header-view.ts";
import { Phases, RunTotals } from "./watch-run-parts.ts";
export { Phases, RunTotals } from "./watch-run-parts.ts";
import { component, element, type Shown } from "./watch-element.ts";
import {
  completedDetail,
  counted,
  elapsed,
  runName,
  runTone,
  waitingDetail,
  type Copying,
  type WatchModel,
  type WatchRun,
  type WatchWorkflow,
} from "./watch-render.ts";
import {
  Board,
  HandoffLinks,
  type ColumnControls,
} from "./watch-board-view.ts";
import { watchLocation } from "./watch-navigation.ts";
import { Floor } from "./watch-floor-view.ts";
import { Shelf } from "./watch-shelf-view.ts";
import {
  NeedsYou,
  reasonText,
  type ContinueControls,
} from "./watch-needs-view.ts";
export type { ContinueControls } from "./watch-needs-view.ts";
import { Today } from "./watch-today-view.ts";
import { LoopsPanel, type LoopControls } from "./watch-loops-view.ts";
import type { ThemeControls } from "./watch-theme-view.ts";
import { Events, Turn, PullRequest, Review } from "./watch-turn.ts";
import { RunDecisions, type DecisionControls } from "./watch-decision-view.ts";
import { Commands } from "./command-effects.ts";
import {
  Transcript,
  type TranscriptControls,
} from "./watch-transcript-view.ts";
export { PullRequest, Review } from "./watch-turn.ts";
import { RunHeading, type RenameControls } from "./watch-rename-view.ts";

interface Timed {
  readonly run: WatchRun;
  readonly now: string;
}

export function BannerDetail(props: Timed): Shown {
  const { run, now } = props;
  const turn = run.turns.at(-1);
  if (run.state === "waiting_gate") return waitingDetail(run, now);
  if (run.state === "completed") return completedDetail(run);
  if (run.state !== "running" || turn?.outcome !== "in work")
    return reasonText(run);
  const calls = turn.activity.filter((item) => item.kind === "tool").length;
  const quiet =
    turn.activeAt === null
      ? ""
      : ` · last output ${elapsed(turn.activeAt, now)} ago`;
  const last = turn.activity.at(-1)?.text ?? "The worker starts.";
  const worker =
    turn.harness === undefined ? "The worker" : `The ${turn.harness} worker`;
  return [
    `${worker} works for ${elapsed(turn.startedAt, now)} · ${counted(calls, "tool call")}${quiet}`,
    element("span", { class: "now", children: last }),
  ];
}

export function Banner(props: Timed): Shown {
  const { run, now } = props;
  const { tone, icon, label } = runTone(run);
  const name = element("span", { class: "name", children: runName(run) });
  const words = [
    element("h2", { children: [label, " ", name] }),
    element("p", { children: component(BannerDetail, { run, now }) }),
  ];
  return element("section", {
    class: `banner ${tone}`,
    children: [
      element("span", { class: "icon", children: icon }),
      element("div", { children: words }),
    ],
  });
}

export function RunTurns(
  props: Timed & {
    readonly transcripts: TranscriptControls | undefined;
    readonly turnId: string | null;
  },
): Shown {
  const { run, now } = props;
  if (run.turns.length === 0)
    return element("p", {
      class: "meta",
      children: "No agent turn for this run.",
    });
  return run.turns.map((item, index) => [
    component(Turn, { key: item.key, turn: item, now }),
    component(Transcript, {
      key: `transcript-${item.key}`,
      run,
      turn: item,
      turnId: props.turnId,
      controls: props.transcripts,
    }),
    component(Review, { key: `review-${item.key}`, run, round: index + 1 }),
  ]);
}

export function Run(
  props: Timed & {
    readonly copying: Copying;
    readonly deciding?: DecisionControls | undefined;
    readonly steering?: SteerControls | undefined;
    readonly controlling?: RunCommandControls | undefined;
    readonly renaming?: RenameControls | undefined;
    readonly transcripts?: TranscriptControls | undefined;
    readonly turnId?: string | null | undefined;
  },
): Shown {
  const { run, now, copying } = props;
  const budget = effectBudgetText(run.spent, run.limit);
  const place =
    run.chain === undefined
      ? ""
      : ` · run ${String(run.chain.position)} of ${String(run.chain.limit)} in its chain`;
  const foot = [
    `${run.workflowId} · ${run.runId}${budget === "" ? "" : ` · ${budget}`}${place}`,
    element("br", {}),
    `${run.code}: ${run.detail}`,
  ];
  return [
    component(Banner, { run, now }),
    component(RunHeading, { run, renaming: props.renaming }),
    component(RunDecisions, { run, copying, now, deciding: props.deciding }),
    loopText(run) === ""
      ? null
      : element("p", { class: "meta", children: loopText(run) }),
    component(HandoffLinks, { run }),
    component(RunNotes, { notes: run.notes }),
    component(RunActions, {
      run,
      steering: props.steering,
      controlling: props.controlling,
    }),
    component(CommandWaits, { waits: run.commandWaits ?? [] }),
    component(RunTotals, { run }),
    component(Phases, { phases: run.phases, now }),
    component(PullRequest, { run }),
    (run.ciReruns ?? []).map((rerun) =>
      element("p", {
        class: "meta",
        children: `CI rerun after a failed check: workflow ${rerun.run}, commit ${rerun.commit.slice(0, 7)}`,
      }),
    ),
    component(RunTurns, {
      run,
      now,
      transcripts: props.transcripts,
      turnId: props.turnId ?? null,
    }),
    component(Commands, { effects: run.commandEffects ?? [] }),
    component(Events, { events: run.events }),
    element("p", { class: "meta foot", children: foot }),
  ];
}

export interface PageProps {
  readonly cards?: CardControls;
  readonly model: WatchModel | null;
  readonly observationNow?: string | undefined;
  readonly selected: string;
  readonly now: string;
  readonly stale: boolean;
  readonly copying: Copying;
  readonly columns?: ColumnControls;
  readonly phone?: PhoneControls | undefined;
  readonly queue?: QueueControls | undefined;
  readonly continuing?: ContinueControls | undefined;
  readonly deciding?: DecisionControls | undefined;
  readonly loops?: LoopControls | undefined;
  readonly steering?: SteerControls | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
  readonly theme?: ThemeControls | undefined;
  readonly transcripts?: TranscriptControls | undefined;
}

export function Page(props: PageProps): Shown {
  const { model, selected, now, stale, copying, theme } = props;
  const words = theme?.shown.theme?.words;
  const head = component(Header, { model, stale, theme });
  const text = (tone: string, children: Shown): Shown =>
    element("p", { class: tone, children });
  const waits = "The page waits for the first data of the watch tool.";
  if (model === null) return [head, text("meta", waits)];
  const lost =
    "The Cloving service does not answer. The page shows the last known records.";
  const down = model.service === "up" ? null : text("down", lost);
  const location = watchLocation(selected);
  if (location.runId !== null) {
    const run = model.runs.find((item) => item.runId === location.runId);
    return [
      component(Header, { model, stale, queue: props.queue, theme }),
      down,
      component(Queue, { model, words }),
      component(RefusedWorkflows, { model }),
      component(BackLink, {
        workflowId: location.workflowId,
        repository: location.repository,
      }),
      run === undefined
        ? text("meta", "This run is not available.")
        : component(Run, {
            key: run.runId,
            run,
            now,
            copying,
            deciding: props.deciding,
            steering: props.steering,
            controlling: props.controlling,
            renaming: props.renaming,
            transcripts: props.transcripts,
            turnId: location.turnId,
          }),
    ];
  }
  const workflow = model.workflows.find(
    (item) =>
      item.workflowId === location.workflowId &&
      (location.repository === undefined ||
        item.repository === location.repository),
  );
  if (workflow === undefined)
    return component(FloorPage, { ...props, model, down });
  return component(BoardPage, { ...props, model, workflow, down });
}

export function FloorPage(
  props: PageProps & { readonly model: WatchModel; readonly down: Shown },
): Shown {
  const { model, down, now, stale, theme, controlling } = props;
  const words = theme?.shown.theme?.words;
  return element("div", {
    class: "floor-page",
    children: [
      component(Header, {
        model,
        stale,
        phone: props.phone,
        queue: props.queue,
        theme,
        now,
      }),
      down,
      model.schedules !== undefined && "status" in model.schedules
        ? element("p", { class: "meta", children: "Schedules: unavailable" })
        : null,
      element("div", {
        class: "floor-layout",
        children: [
          element("div", {
            class: "floor-main",
            children: [
              component(Floor, { model, now, words, controlling }),
              component(NeedsYou, {
                runs: model.runs,
                now,
                words,
                continuing: props.continuing,
                deciding: props.deciding,
                controlling,
              }),
            ],
          }),
          element("aside", {
            class: "side-panels",
            children: [
              component(Today, { model, words }),
              component(LoopsPanel, {
                loops: model.loops ?? [],
                now,
                controls: props.loops,
              }),
              component(Queue, { model, words }),
              component(RefusedWorkflows, { model }),
            ],
          }),
        ],
      }),
      component(Shelf, { model, words }),
    ],
  });
}

export function BoardPage(
  props: PageProps & {
    readonly model: WatchModel;
    readonly workflow: WatchWorkflow;
    readonly down: Shown;
  },
): Shown {
  const { model, workflow, down, now, stale, theme } = props;
  const words = theme?.shown.theme?.words;
  return element("div", {
    class: "board-page",
    children: [
      component(Header, {
        model,
        stale,
        phone: props.phone,
        queue: props.queue,
        theme,
        now,
      }),
      component(Queue, { model, words }),
      down,
      model.schedules !== undefined && "status" in model.schedules
        ? element("p", { class: "meta", children: "Schedules: unavailable" })
        : null,
      component(RefusedWorkflows, { model }),
      component(BackLink, { workflowId: null }),
      element("div", {
        class: "workspace",
        children: component(Board, {
          workflow,
          now,
          observationNow: props.observationNow,
          controls: props.columns,
          steering: props.steering,
          controlling: props.controlling,
          renaming: props.renaming,
          cardForm: model.cardForms?.find(
            (form) => form.workflowId === workflow.workflowId,
          ),
          cards: props.cards,
          words,
        }),
      }),
    ],
  });
}
