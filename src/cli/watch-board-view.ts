import { priceText, usageText } from "./usage-render.ts";
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

export function CardReview(props: {
  readonly card: WatchCard;
  readonly workflowId: string;
}): Shown {
  if (props.workflowId !== "develop-issue") return null;
  const review = cardReview(props.card);
  if (review === "") return null;
  return element("span", {
    class: "card-review",
    children: review
      .split(" · ")
      .map((part, index) => [
        index === 0 ? "" : " · ",
        element("span", { class: "review-pill", children: part }),
      ]),
  });
}

export function completionMark(card: WatchCard, workflowId: string): Shown {
  const mark = card.completionMark;
  if (mark === null) return null;
  let text = mark.text;
  const status = card.pullRequestObservation?.status;
  if (text === "Needs attention" && status === "merged")
    text = `PR merged #${String(card.pullRequestNumber)}`;
  if (text === "Needs attention" && status === "unavailable")
    text = "PR status unavailable";
  if (mark.laterRunId === null)
    return element("span", { class: "completion-mark", children: text });
  return element("a", {
    class: "completion-mark",
    href: watchHash({ workflowId, runId: mark.laterRunId }),
    children: mark.text,
  });
}

export function Card(props: {
  readonly card: WatchCard;
  readonly workflowId: string;
  readonly now: string;
}): Shown {
  const { card, workflowId, now } = props;
  return element("article", {
    class: "card",
    children: [
      element("a", {
        class: "card-run",
        href: watchHash({ workflowId, runId: card.runId }),
        children: [
          element("strong", { children: card.title ?? card.runId }),
          element("span", {
            class:
              card.endedAt === null && card.currentStep !== null
                ? "card-step active"
                : "card-step",
            children: cardStep(card, now),
          }),
          component(CardReview, { card, workflowId }),
          element("span", {
            class: "card-cost",
            children: `${card.currentStep === null ? "Totals" : "Totals so far"} · ${priceText(card.claudeCostUsd)}`,
          }),
          element("span", {
            class: "card-usage",
            children: usageText(card.usage),
          }),
          card.decisionWaiting
            ? element("span", {
                class: "decision-mark",
                children: "! Decision waiting",
              })
            : null,
          element("small", { children: card.runId }),
        ],
      }),
      completionMark(card, workflowId),
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
            class: column.name === "Stopped" ? "column stopped" : "column",
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
