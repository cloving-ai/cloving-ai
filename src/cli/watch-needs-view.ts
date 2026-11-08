import { component, element, type Shown } from "./watch-element.ts";
import { cardKey, type CardKeyEvent } from "./watch-card-view.ts";
import { stepAge } from "./watch-floor-view.ts";
import { watchHash } from "./watch-navigation.ts";
import type { WatchDecision, WatchRun } from "./watch-render.ts";
import { wordText, type WatchWords } from "./watch-theme-view.ts";

export interface WatchNeed {
  readonly repository?: string;
  readonly kind: "decision" | "stopped";
  readonly key: string;
  readonly runId: string;
  readonly title: string;
  readonly text: string;
  readonly workflowId: string;
  readonly since: string | null;
  readonly continuable?: true;
}

export interface ContinueControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly open: string | null;
  readonly note: string;
  readonly onOpen: (runId: string) => void;
  readonly onClose: () => void;
  readonly onNote: (text: string) => void;
  readonly onContinue: (runId: string) => void;
  readonly onDismiss: (runId: string) => void;
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

export function continuableRun(run: WatchRun): boolean {
  if (run.continuedBy !== undefined || run.finished !== undefined) return false;
  if (run.state === "failed") return true;
  return run.state === "completed" && run.outcome === "blocked";
}

export function continuableNeed(run: WatchRun): WatchNeed {
  return {
    kind: "stopped",
    key: `continue:${run.runId}`,
    runId: run.runId,
    title: run.title ?? run.runId,
    text: [run.detail, "Examine the run, then continue it or take it over."]
      .filter((part) => part !== "")
      .join(" "),
    workflowId: run.workflowId,
    since: run.latestAt,
    continuable: true,
  };
}

export function needRepository(run: WatchRun): {
  readonly repository?: string;
} {
  return run.repository === undefined ? {} : { repository: run.repository };
}

export function needsOf(runs: readonly WatchRun[]): WatchNeed[] {
  const waited = (need: WatchNeed): number => {
    const time = Date.parse(need.since ?? "");
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  const floor = runs.filter((run) => run.linked !== true);
  return [
    ...floor.flatMap((run) =>
      run.decisions.map((decision) => ({
        ...decisionNeed(run, decision),
        ...needRepository(run),
      })),
    ),
    ...floor
      .filter((run) => run.state === "paused")
      .map((run) => ({ ...stoppedNeed(run), ...needRepository(run) })),
    ...floor
      .filter(continuableRun)
      .map((run) => ({ ...continuableNeed(run), ...needRepository(run) })),
  ].toSorted((first, second) => waited(first) - waited(second));
}

export function needMeta(need: WatchNeed, now: string): string {
  const age = stepAge(need.since, now);
  const line =
    need.repository === undefined
      ? need.workflowId
      : `${need.repository}: ${need.workflowId}`;
  return age === "" ? line : `${line}, waiting ${age}`;
}

export function ContinueAction(props: {
  readonly need: WatchNeed;
  readonly continuing: ContinueControls | undefined;
}): Shown {
  const { need, continuing } = props;
  if (need.continuable !== true || continuing === undefined) return null;
  if (continuing.open === need.runId)
    return component(ContinueForm, { need, continuing });
  return element("button", {
    type: "button",
    class: "need-action need-continue",
    ...(continuing.busy.includes(need.runId) ? { disabled: true } : {}),
    onClick: () => {
      continuing.onOpen(need.runId);
    },
    children: "Continue",
  });
}

export function ContinueForm(props: {
  readonly need: WatchNeed;
  readonly continuing: ContinueControls;
}): Shown {
  const { need, continuing } = props;
  return element("form", {
    class: "need-note",
    onKeyDown: (event: CardKeyEvent) => {
      cardKey(event, { onCancel: continuing.onClose });
    },
    onSubmit: (event: Event) => {
      event.preventDefault();
      continuing.onContinue(need.runId);
    },
    children: [
      element("label", {
        children: [
          "Note for the next turn (optional)",
          element("input", {
            type: "text",
            name: "note",
            value: continuing.note,
            onInput: (event: { currentTarget: { value: string } }) => {
              continuing.onNote(event.currentTarget.value);
            },
          }),
        ],
      }),
      element("button", {
        type: "submit",
        class: "need-action need-continue",
        children: "Continue",
      }),
      element("button", {
        type: "button",
        class: "need-action",
        onClick: continuing.onClose,
        children: "Cancel",
      }),
    ],
  });
}

export function DismissAction(props: {
  readonly need: WatchNeed;
  readonly continuing: ContinueControls | undefined;
}): Shown {
  const { need, continuing } = props;
  if (need.continuable !== true || continuing === undefined) return null;
  return element("button", {
    type: "button",
    class: "need-action need-dismiss",
    ...(continuing.busy.includes(need.runId) ? { disabled: true } : {}),
    onClick: () => {
      continuing.onDismiss(need.runId);
    },
    children: "Dismiss",
  });
}

export function NeedMessage(props: {
  readonly need: WatchNeed;
  readonly continuing: ContinueControls | undefined;
}): Shown {
  const message = props.continuing?.messages[props.need.runId];
  if (message === undefined) return null;
  return element("p", { class: "need-message", children: message });
}

export function Need(props: {
  readonly need: WatchNeed;
  readonly now: string;
  readonly continuing?: ContinueControls | undefined;
}): Shown {
  const { need, now, continuing } = props;
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
          component(NeedMessage, { need, continuing }),
        ],
      }),
      component(ContinueAction, { need, continuing }),
      component(DismissAction, { need, continuing }),
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
  readonly words?: WatchWords | undefined;
  readonly continuing?: ContinueControls | undefined;
}): Shown {
  const { now, continuing } = props;
  const needs = needsOf(props.runs);
  return element("section", {
    class: "needs",
    "aria-labelledby": "needs-title",
    children: [
      element("div", {
        class: "needs-head",
        children: [
          element("h2", {
            id: "needs-title",
            children: wordText(props.words, {
              key: "needs.title",
              text: "Needs you",
            }),
          }),
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
              component(Need, { key: need.key, need, now, continuing }),
            ),
          }),
    ],
  });
}
