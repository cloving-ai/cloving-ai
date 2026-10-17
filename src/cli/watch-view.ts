import { priceText, usageText, totalsSuffix } from "./usage-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import {
  clockTime,
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
import { Board, WorkflowList } from "./watch-board-view.ts";
import { boardWorkflow, watchHash, watchLocation } from "./watch-navigation.ts";
import { Decision, Events, Turn } from "./watch-turn.ts";

interface Timed {
  readonly run: WatchRun;
  readonly now: string;
}

export const clove = {
  viewBox:
    "0.6625858545303345 0.6630800366401672 46.674827575683594 46.673831939697266",
  paths: [
    "M41.47315,11.48535c-1.20117-0.12305-2.16211-1.08398-2.28418-2.28516c-0.17676-1.7334-1.01758-3.29492-2.36865-4.39648s-3.05078-1.61719-4.7832-1.43359c-3.34277,0.34082-5.86377,3.13086-5.86377,6.49121v14.13867c0,0.27637,0.22363,0.5,0.5,0.5H40.8125c3.59766,0,6.52441-2.92676,6.52441-6.52441C47.33692,14.61523,44.81592,11.82422,41.47315,11.48535z M35.56543,15.81543l-5.85791,5.85742c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648c-0.19531-0.19531-0.19531-0.51172,0-0.70703l5.85791-5.85742c0.19531-0.19531,0.51172-0.19531,0.70703,0C35.76073,15.30372,35.76074,15.62011,35.56543,15.81543z",
    "M15.30225,0.66308c-3.36035,0-6.15088,2.52051-6.49121,5.86328C8.68897,7.72852,7.72852,8.68945,6.52686,8.81152c-1.7334,0.17578-3.29492,1.01758-4.396,2.36816s-1.61035,3.0498-1.43408,4.7832c0.34033,3.34277,3.13086,5.86328,6.49121,5.86328h14.13867c0.27637,0,0.5-0.22363,0.5-0.5V7.18751C21.82666,3.58984,18.8999,0.66308,15.30225,0.66308z M18.99951,19.00001c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648l-5.85742-5.8584c-0.19531-0.19531-0.19531-0.51172,0-0.70703c0.19531-0.19531,0.51172-0.19531,0.70703,0l5.85742,5.8584C19.19482,18.48829,19.19482,18.80469,18.99951,19.00001z",
    "M24,26.17383H9.86133c-3.59766,0-6.52441,2.92676-6.52441,6.52441c0,3.35938,2.52051,6.14941,5.86377,6.49023c1.20117,0.12207,2.16211,1.08301,2.28418,2.28418c0.17676,1.7334,1.01758,3.29492,2.36865,4.39648c1.17529,0.95801,2.61377,1.46777,4.11035,1.46777c0.22314,0,0.44775-0.01074,0.67285-0.03418C21.97949,46.96189,24.5,44.17186,24.5,40.81248V26.67383C24.5,26.39746,24.27637,26.17383,24,26.17383z M21.67334,29.70704l-5.85791,5.8584c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648c-0.19531-0.19531-0.19531-0.51172,0-0.70703L20.9663,29c0.19531-0.19531,0.51172-0.19531,0.70703,0S21.86865,29.51172,21.67334,29.70704z",
    "M47.30322,32.03711c-0.34033-3.34277-3.13086-5.86328-6.49072-5.86328H26.67334c-0.27637,0-0.5,0.22363-0.5,0.5V40.8125c0,3.59766,2.92676,6.52441,6.52442,6.52441c3.36035,0,6.15088-2.52148,6.49121-5.86426c0.12207-1.20117,1.08301-2.16211,2.28418-2.28418c1.7334-0.17578,3.29492-1.01758,4.396-2.36816S47.47949,33.7705,47.30322,32.03711z M35.56543,35.56543c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648l-5.85791-5.8584c-0.19531-0.19531-0.19531-0.51172,0-0.70703s0.51172-0.19531,0.70703,0l5.85791,5.8584C35.76074,35.05371,35.76074,35.37011,35.56543,35.56543z",
  ],
};

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

export function PullRequest(props: { readonly run: WatchRun }): Shown {
  const { pullRequest, reviews, mergeCommit } = props.run;
  if (pullRequest === null) return null;
  const link = element("a", {
    href: pullRequest.url,
    children: `#${String(pullRequest.number)}`,
  });
  const scores = reviews.map((review) =>
    element("li", {
      children: `Round ${String(review.round)} · Greptile ${String(review.score)}/5 · commit ${review.commit.slice(0, 7)}`,
    }),
  );
  const merge =
    mergeCommit === null
      ? null
      : element("p", {
          class: "meta",
          children: [
            "Merge commit ",
            element("code", { children: mergeCommit }),
          ],
        });
  return element("section", {
    class: "pull",
    children: [
      element("h3", { children: ["Pull request ", link] }),
      element("ul", { class: "reviews", children: scores }),
      merge,
    ],
  });
}

export function Run(props: Timed & { readonly copying: Copying }): Shown {
  const { run, now, copying } = props;
  const turn = run.turns.at(-1);
  const budget =
    run.spent === null || run.limit === null
      ? ""
      : ` · ${String(run.spent)} of ${String(run.limit)} effect units`;
  const none = "No Claude turn for this run.";
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
    element("section", {
      class: "run-usage",
      children: [
        element("h3", { children: `Run totals${totalsSuffix(run.state)}` }),
        element("p", { children: usageText(run.usage) }),
        element("p", { children: priceText(run.claudeCostUsd) }),
      ],
    }),
    component(Phases, { phases: run.phases, now }),
    component(PullRequest, { run }),
    run.decisions.map((decision) =>
      component(Decision, { decision, turn, copying }),
    ),
    turns,
    component(Events, { events: run.events }),
    element("p", { class: "meta foot", children: foot }),
  ];
}

export function Header(props: {
  readonly model: WatchModel | null;
  readonly stale: boolean;
}): Shown {
  const { model, stale } = props;
  const updated = model === null ? "" : `updated ${clockTime(model.updatedAt)}`;
  const stamp = stale
    ? element("span", {
        class: "bad",
        children: "The watch tool does not answer.",
      })
    : element("span", { children: updated });
  return element("header", {
    children: [
      element("strong", {
        class: "brand",
        children: [
          element("svg", {
            xmlns: "http://www.w3.org/2000/svg",
            "aria-hidden": "true",
            focusable: "false",
            viewBox: clove.viewBox,
            children: clove.paths.map((d) =>
              element("path", { fill: "currentColor", d }),
            ),
          }),
          "cloving",
        ],
      }),
      stamp,
    ],
  });
}

export interface PageProps {
  readonly model: WatchModel | null;
  readonly selected: string;
  readonly now: string;
  readonly stale: boolean;
  readonly copying: Copying;
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
  const workflow = model.workflows.find(
    (item) => item.workflowId === workflowId,
  );
  return [
    head,
    down,
    element("div", {
      class: "workspace",
      children: [
        component(WorkflowList, {
          workflows: model.workflows,
          selected: workflowId,
        }),
        workflow === undefined
          ? text("meta", "No workflows registered.")
          : component(Board, { workflow, now }),
      ],
    }),
  ];
}
