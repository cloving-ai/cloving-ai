import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import type { WatchCard, WatchWorkflow } from "./watch-render.ts";

export function cardStep(card: WatchCard, now: string): string {
  if (card.endedAt !== null) return new Date(card.endedAt).toLocaleString();
  const step = card.currentStep;
  if (step === null) return "";
  if (step.startedAt === null) return step.name;
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(step.startedAt)) / 60000),
  );
  return `${step.name} · ${String(minutes)} min`;
}

export function cardReview(card: WatchCard): string {
  return [
    card.round === null ? null : `round ${String(card.round)}`,
    card.greptileScore === null ? null : `${String(card.greptileScore)}/5`,
    card.pullRequestNumber === null
      ? null
      : `#${String(card.pullRequestNumber)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function Card(props: {
  readonly card: WatchCard;
  readonly workflowId: string;
  readonly now: string;
}): Shown {
  const { card, workflowId, now } = props;
  const review = workflowId === "develop-issue" ? cardReview(card) : "";
  return element("a", {
    class: "card",
    href: watchHash({ workflowId, runId: card.runId }),
    children: [
      element("strong", { children: card.title ?? card.runId }),
      element("span", { class: "card-step", children: cardStep(card, now) }),
      review === ""
        ? null
        : element("span", { class: "card-review", children: review }),
      element("span", {
        class: "card-cost",
        children: `${card.claudeCostUsd.toFixed(2)} USD`,
      }),
      card.decisionWaiting
        ? element("span", {
            class: "decision-mark",
            children: "! Decision waiting",
          })
        : null,
      element("small", { children: card.runId }),
    ],
  });
}

export function WorkflowList(props: {
  readonly workflows: readonly WatchWorkflow[];
  readonly selected: string | null;
}): Shown {
  return element("nav", {
    class: "workflows",
    "aria-label": "Workflows",
    children: props.workflows.map((workflow) =>
      element("a", {
        key: workflow.workflowId,
        href: watchHash({ workflowId: workflow.workflowId, runId: null }),
        "aria-current":
          workflow.workflowId === props.selected ? "page" : undefined,
        children: [
          element("strong", { children: workflow.workflowId }),
          element("span", {
            children: `${String(workflow.activeCount)} active · ${String(workflow.waitingCount)} waiting`,
          }),
        ],
      }),
    ),
  });
}

export function Board(props: {
  readonly workflow: WatchWorkflow;
  readonly now: string;
}): Shown {
  const { workflow, now } = props;
  return element("main", {
    class: "board",
    children: [
      element("h2", { children: workflow.workflowId }),
      element("div", {
        class: "columns",
        children: workflow.columns.map((column) =>
          element("section", {
            key: column.name,
            class: "column",
            children: [
              element("h3", { class: "column-name", children: column.name }),
              column.cards.map((card) =>
                component(Card, {
                  key: card.runId,
                  card,
                  workflowId: workflow.workflowId,
                  now,
                }),
              ),
            ],
          }),
        ),
      }),
    ],
  });
}
