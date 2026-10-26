import type { CardControls } from "./watch-card-view.ts";
import type { PhoneControls } from "./watch-phone-view.ts";
import { Header, Queue, type StartControls } from "./watch-header-view.ts";
export { clove, Header } from "./watch-header-view.ts";
export type { StartControls } from "./watch-header-view.ts";
import { priceText, usageText, totalsSuffix } from "./usage-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import {
  completedDetail,
  counted,
  elapsed,
  phaseTime,
  runName,
  runTone,
  waitingDetail,
  type Copying,
  type WatchModel,
  type WatchPhase,
  type WatchRun,
} from "./watch-render.ts";
import {
  Board,
  HandoffLinks,
  WorkflowList,
  type ColumnControls,
} from "./watch-board-view.ts";
import { boardWorkflow, watchHash, watchLocation } from "./watch-navigation.ts";
import { Decision, Events, Turn, PullRequest } from "./watch-turn.ts";
import { Commands } from "./command-effects.ts";
export { PullRequest } from "./watch-turn.ts";
import { StartRun } from "./watch-start-view.ts";

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
    return `${run.code}: ${run.detail}`;
  const calls = turn.activity.filter((item) => item.kind === "tool").length;
  const quiet =
    turn.activeAt === null
      ? ""
      : ` · last output ${elapsed(turn.activeAt, now)} ago`;
  const last = turn.activity.at(-1)?.text ?? "The worker starts.";
  return [
    `Claude works for ${elapsed(turn.startedAt, now)} · ${counted(calls, "tool call")}${quiet}`,
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

export function Phases(props: {
  readonly phases: readonly WatchPhase[];
  readonly now: string;
}): Shown {
  const marks: Readonly<Record<string, string>> = {
    done: "✓",
    active: "●",
    failed: "✕",
  };
  const steps = props.phases.map((phase) =>
    element("li", {
      class: `phase ${phase.state}`,
      children: [
        element("span", { class: "mark", children: marks[phase.state] ?? "○" }),
        element("span", { class: "name", children: phase.name }),
        element("span", {
          class: "time",
          children: phaseTime(phase, props.now),
        }),
      ],
    }),
  );
  return element("ol", { class: "phases", children: steps });
}

export function Review(props: {
  readonly run: WatchRun;
  readonly round: number;
}): Shown {
  const { run, round } = props;
  const decisionId = `${run.runId}/review-${String(round)}`;
  const denied = run.feedback.find((item) => item.decisionId === decisionId);
  if (denied !== undefined)
    return element("section", {
      class: "review denied",
      children: [
        element("h3", { children: `Review ${String(round)} · denied` }),
        element("p", { children: denied.text }),
      ],
    });
  if (!run.decisions.some((item) => item.decisionId === decisionId))
    return null;
  return element("section", {
    class: "review pending",
    children: element("h3", {
      children: `Review ${String(round)} · waits for your decision`,
    }),
  });
}

export function Run(props: Timed & { readonly copying: Copying }): Shown {
  const { run, now, copying } = props;
  const turn = run.turns.at(-1);
  const budget =
    run.spent === null || run.limit === null
      ? ""
      : ` · ${String(run.spent)} of ${String(run.limit)} effect units`;
  const none = "No agent turn for this run.";
  const turns =
    run.turns.length === 0
      ? element("p", { class: "meta", children: none })
      : run.turns.map((item, index) => [
          component(Turn, { key: item.key, turn: item, now }),
          component(Review, {
            key: `review-${item.key}`,
            run,
            round: index + 1,
          }),
        ]);
  const foot = [
    `${run.workflowId} · ${run.runId}${budget}`,
    element("br", {}),
    `${run.code}: ${run.detail}`,
  ];
  return [
    component(Banner, { run, now }),
    component(HandoffLinks, { run }),
    element("section", {
      class: "run-usage",
      children: [
        element("h3", { children: `Run totals${totalsSuffix(run.state)}` }),
        element("p", { children: usageText(run.usage) }),
        element("p", {
          children: priceText(run.claudeCostUsd, run.estimatedCostUsd),
        }),
      ],
    }),
    component(Phases, { phases: run.phases, now }),
    component(PullRequest, { run }),
    (run.ciReruns ?? []).map((rerun) =>
      element("p", {
        class: "meta",
        children: `CI rerun after a failed check: workflow ${rerun.run}, commit ${rerun.commit.slice(0, 7)}`,
      }),
    ),
    run.decisions.map((decision) =>
      component(Decision, { decision, turn, copying }),
    ),
    turns,
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
  readonly start?: StartControls;
  readonly phone?: PhoneControls | undefined;
}

export function RefusedWorkflows(props: { readonly model: WatchModel }): Shown {
  const refusals = props.model.workflowRefusals ?? [];
  if (refusals.length === 0) return null;
  return element("section", {
    class: "workflow-refusals",
    children: [
      element("h2", { children: "Refused workflows" }),
      element("ul", {
        children: refusals.map((entry) =>
          element("li", {
            children: `${entry.scope} ${entry.label}: ${entry.codes.join(", ")}`,
          }),
        ),
      }),
    ],
  });
}

export function Page(props: PageProps): Shown {
  const { model, selected, now, stale, copying } = props;
  const head = component(Header, { model, stale });
  const text = (tone: string, children: Shown): Shown =>
    element("p", { class: tone, children });
  const waits = "The page waits for the first data of the watch tool.";
  if (model === null) return [head, text("meta", waits)];
  const lost =
    "The Cloving service does not answer. The page shows the last known records.";
  const down = model.service === "up" ? null : text("down", lost);
  const location = watchLocation(selected);
  const workflowId = boardWorkflow(model, location.workflowId);
  if (location.runId !== null) {
    const run = model.runs.find((item) => item.runId === location.runId);
    const back =
      run?.workflowId ?? location.workflowId ?? model.startWorkflowId;
    return [
      head,
      down,
      component(Queue, { model }),
      component(RefusedWorkflows, { model }),
      element("a", {
        class: "back",
        href: watchHash({ workflowId: back, runId: null }),
        children: `← Back to ${back ?? "workflows"}`,
      }),
      run === undefined
        ? text("meta", "This run is not available.")
        : component(Run, { key: run.runId, run, now, copying }),
    ];
  }
  return component(BoardPage, { ...props, model, workflowId, down });
}

export function BoardPage(
  props: PageProps & {
    readonly model: WatchModel;
    readonly workflowId: string | null;
    readonly down: Shown;
  },
): Shown {
  const { model, workflowId, down, now, stale, copying } = props;
  const workflow = model.workflows.find(
    (item) => item.workflowId === workflowId,
  );
  const start = props.start ?? { shown: false, onToggle: () => undefined };
  return element("div", {
    class: "board-page",
    children: [
      component(Header, { model, stale, start, phone: props.phone, now }),
      component(Queue, { model }),
      down,
      component(RefusedWorkflows, { model }),
      component(StartRun, {
        workflows: model.workflows,
        copying,
        shown: start.shown,
      }),
      component(WorkflowList, {
        workflows: model.workflows,
        selected: workflowId,
      }),
      element("div", {
        class: "workspace",
        children: [
          workflow === undefined
            ? element("p", {
                class: "meta",
                children: "No workflows registered.",
              })
            : component(Board, {
                workflow,
                now,
                observationNow: props.observationNow,
                controls: props.columns,
                cardForm: model.cardForms?.find(
                  (form) => form.workflowId === workflowId,
                ),
                cards: props.cards,
              }),
        ],
      }),
    ],
  });
}
