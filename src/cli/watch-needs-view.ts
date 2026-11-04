import { component, element, type Shown } from "./watch-element.ts";
import { stepAge } from "./watch-floor-view.ts";
import { watchHash } from "./watch-navigation.ts";
import type { WatchDecision, WatchRun } from "./watch-render.ts";

export interface WatchNeed {
  readonly kind: "decision" | "stopped";
  readonly key: string;
  readonly runId: string;
  readonly title: string;
  readonly text: string;
  readonly workflowId: string;
  readonly since: string | null;
}

export function decisionText(type: string): string {
  const texts: Readonly<Record<string, string>> = {
    approval: "Examine the work, then approve or deny it.",
    question: "Read the question, then answer it.",
  };
  return texts[type] ?? "Examine the request, then give your decision.";
}

export function decisionNeed(
  run: WatchRun,
  decision: WatchDecision,
): WatchNeed {
  return {
    kind: "decision",
    key: `decision:${decision.decisionId}`,
    runId: run.runId,
    title: run.title ?? run.runId,
    text: decisionText(decision.type),
    workflowId: run.workflowId,
    since: decision.openedAt,
  };
}

export function stoppedNeed(run: WatchRun): WatchNeed {
  const paused = run.events.findLast((event) => event.type === "run.paused");
  return {
    kind: "stopped",
    key: `stopped:${run.runId}`,
    runId: run.runId,
    title: run.title ?? run.runId,
    text: [run.detail, "Examine the run, then resume or drop it."]
      .filter((part) => part !== "")
      .join(" "),
    workflowId: run.workflowId,
    since: paused?.recordedAt ?? run.latestAt,
  };
}

export function needsOf(runs: readonly WatchRun[]): WatchNeed[] {
  const waited = (need: WatchNeed): number => {
    const time = Date.parse(need.since ?? "");
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  return [
    ...runs.flatMap((run) =>
      run.decisions.map((decision) => decisionNeed(run, decision)),
    ),
    ...runs.filter((run) => run.state === "paused").map(stoppedNeed),
  ].toSorted((first, second) => waited(first) - waited(second));
}

export function needMeta(need: WatchNeed, now: string): string {
  const age = stepAge(need.since, now);
  return age === "" ? need.workflowId : `${need.workflowId}, waiting ${age}`;
}

export function Need(props: {
  readonly need: WatchNeed;
  readonly now: string;
}): Shown {
  const { need, now } = props;
  const decision = need.kind === "decision";
  return element("li", {
    class: `need need-${need.kind}`,
    children: [
      element("span", {
        class: "need-mark",
        title: decision ? "Decision" : "Stopped run",
      }),
      element("div", {
        class: "need-body",
        children: [
          element("h3", { class: "need-title", children: need.title }),
          element("p", { class: "need-text", children: need.text }),
          element("p", { class: "need-meta", children: needMeta(need, now) }),
        ],
      }),
      element("a", {
        class: "need-action",
        href: watchHash({ workflowId: null, runId: need.runId }),
        children: decision ? "Answer" : "Open run",
      }),
    ],
  });
}

export function NeedsYou(props: {
  readonly runs: readonly WatchRun[];
  readonly now: string;
}): Shown {
  const { now } = props;
  const needs = needsOf(props.runs);
  return element("section", {
    class: "needs",
    "aria-labelledby": "needs-title",
    children: [
      element("div", {
        class: "needs-head",
        children: [
          element("h2", { id: "needs-title", children: "Needs you" }),
          element("span", {
            class: "needs-count",
            children: `${String(needs.length)} waiting for a person`,
          }),
        ],
      }),
      needs.length === 0
        ? element("p", { class: "needs-empty", children: "Nothing needs you." })
        : element("ol", {
            class: "needs-list",
            children: needs.map((need) =>
              component(Need, { key: need.key, need, now }),
            ),
          }),
    ],
  });
}
