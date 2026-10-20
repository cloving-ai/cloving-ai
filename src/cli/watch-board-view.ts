import { AddCard, type CardControls } from "./watch-card-view.ts";
import type { CardForm } from "./watch-run-input.ts";
import { priceText } from "./usage-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import type { WatchCard, WatchWorkflow } from "./watch-render.ts";

export const boardSizing = {
  minimumColumnWidth: 200,
  collapsedColumnWidth: 44,
  gap: 12,
};

export function boardLayout(input: {
  readonly contentWidth: number;
  readonly openColumns: number;
  readonly collapsedColumns: number;
}): { readonly columnWidth: number; readonly totalWidth: number } {
  const { contentWidth, openColumns, collapsedColumns } = input;
  const fixedWidth =
    collapsedColumns * boardSizing.collapsedColumnWidth +
    Math.max(0, openColumns + collapsedColumns - 1) * boardSizing.gap;
  const columnWidth = Math.max(
    boardSizing.minimumColumnWidth,
    (contentWidth - fixedWidth) / Math.max(1, openColumns),
  );
  return {
    columnWidth:
      openColumns === 0 ? boardSizing.minimumColumnWidth : columnWidth,
    totalWidth: openColumns * columnWidth + fixedWidth,
  };
}

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

export function staleObservation(card: WatchCard, now: string): Shown {
  const observation = card.pullRequestObservation;
  const lastSuccess = observation?.lastSuccess;
  if (
    observation?.status === "merged" ||
    lastSuccess?.status !== "unmerged" ||
    !(Date.parse(now) - lastSuccess.readAt > 120000)
  )
    return null;
  return [
    " ",
    element("span", { class: "completion-stale", children: "Stale" }),
  ];
}

export function observationText(card: WatchCard, fallback: string): string {
  if (fallback !== "Needs attention") return fallback;
  const status = card.pullRequestObservation?.status;
  if (status === "merged")
    return `PR merged · #${String(card.pullRequestNumber)}`;
  if (status === "pending") return "Checking PR";
  if (status === "unavailable") return "PR status unavailable";
  return fallback;
}

export function completionMark(
  card: WatchCard,
  context: { readonly workflowId: string; readonly now: string },
): Shown {
  const mark = card.completionMark;
  if (mark === null) return null;
  const text = observationText(card, mark.text);
  if (mark.laterRunId === null)
    return [
      element("span", { class: "completion-mark", children: text }),
      mark.text === "Needs attention"
        ? staleObservation(card, context.now)
        : null,
    ];
  return element("a", {
    class: "completion-mark",
    href: watchHash({ workflowId: context.workflowId, runId: mark.laterRunId }),
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
        title: card.runId,
        children: [
          element("strong", {
            children: card.title ?? card.runId.slice(0, 12),
          }),
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
            children: `${card.currentStep === null ? "Totals" : "Totals so far"} · ${priceText(card.claudeCostUsd, card.estimatedCostUsd)}`,
          }),
          card.decisionWaiting
            ? element("span", {
                class: "decision-mark",
                children: "! Decision waiting",
              })
            : null,
          element("small", { children: card.runId.slice(0, 12) }),
        ],
      }),
      completionMark(card, { workflowId, now }),
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

export interface ColumnControls {
  readonly choices: Readonly<Record<string, boolean>> | null;
  readonly onToggle: (name: string) => void;
  readonly onHover?: (name: string | null) => void;
  readonly onFocus?: (name: string | null) => void;
}

export function columnCollapsed(
  choices: Readonly<Record<string, boolean>> | null,
  name: string,
): boolean {
  const value =
    choices !== null && Object.hasOwn(choices, name)
      ? choices[name]
      : undefined;
  return value ?? ["Done", "Stopped"].includes(name);
}

export function Column(props: {
  readonly column: WatchWorkflow["columns"][number];
  readonly addCard?: Shown;
  readonly workflowId: string;
  readonly now: string;
  readonly controls?: ColumnControls | undefined;
}): Shown {
  const { column, workflowId, now, controls } = props;
  const collapsed = columnCollapsed(controls?.choices ?? null, column.name);
  const tone = column.name === "Stopped" ? "column stopped" : "column";
  return element("section", {
    class: `${tone}${collapsed ? " collapsed" : ""}`,
    onMouseEnter: () => controls?.onHover?.(column.name),
    onMouseLeave: () => controls?.onHover?.(null),
    onFocusIn: () => controls?.onFocus?.(column.name),
    onFocusOut: () => controls?.onFocus?.(null),
    children: [
      element("h3", {
        class: "column-name",
        children: [
          element("span", { children: column.name }),
          " ",
          element("span", {
            class: "column-count",
            children: String(column.cards.length),
          }),
          element("button", {
            type: "button",
            "aria-label": `${collapsed ? "Expand" : "Collapse"} ${column.name}`,
            "aria-expanded": String(!collapsed),
            onClick: () => controls?.onToggle(column.name),
            children: collapsed ? "+" : "−",
          }),
        ],
      }),
      collapsed
        ? null
        : element("div", {
            class: "column-cards",
            children: [
              column.cards.map((card) =>
                component(Card, { key: card.runId, card, workflowId, now }),
              ),
              props.addCard,
            ],
          }),
    ],
  });
}

export function Board(props: {
  readonly workflow: WatchWorkflow;
  readonly cardForm?: CardForm | undefined;
  readonly cards?: CardControls | undefined;
  readonly now: string;
  readonly controls?: ColumnControls | undefined;
}): Shown {
  const { workflow, now } = props;
  return element("main", {
    class: "board",
    children: [
      element("h2", { children: workflow.workflowId }),
      element("div", {
        class: "columns",
        children: workflow.columns.map((column, index) =>
          component(Column, {
            key: column.name,
            column,
            workflowId: workflow.workflowId,
            now,
            controls: props.controls,
            addCard:
              index === 0
                ? component(AddCard, {
                    form: props.cardForm,
                    controls: props.cards,
                  })
                : null,
          }),
        ),
      }),
    ],
  });
}
