import { priceText } from "./usage-render.ts";
import { element, type Shown } from "./watch-element.ts";
import {
  clockTime,
  counted,
  turnTime,
  type Copying,
  type WatchEvent,
  type WatchRun,
  type WatchTurn,
} from "./watch-render.ts";

export function turnHeading(
  turn: WatchTurn,
  shown: { readonly label: string; readonly now: string },
): string {
  const cost = priceText(turn.costUsd, turn.estimatedCostUsd);
  return [shown.label, turn.outcome, turnTime(turn, shown.now), cost]
    .filter((part) => part !== "")
    .join(" · ");
}

export function Work(props: { readonly turn: WatchTurn }): Shown {
  const { turn } = props;
  const loose = turn.uncommitted.length;
  const block = (lines: readonly string[]): Shown =>
    element("pre", { children: lines.join("\n") });
  const text = (tone: string, children: Shown): Shown =>
    element("p", { class: tone, children });
  const branch = [
    "Branch ",
    element("code", { children: turn.branch }),
    ` · ${counted(turn.commits.length, "commit")}`,
  ];
  const commits =
    turn.commits.length === 0
      ? text("bad", "The worker made no commit.")
      : [text("fact", branch), block(turn.commits), block(turn.files)];
  const left = `${counted(loose, "file")} ${loose === 1 ? "is" : "are"} not committed:`;
  const state =
    loose === 0
      ? text("good", "All the work is committed.")
      : [text("bad", left), block(turn.uncommitted)];
  const report = element("details", {
    open: true,
    children: [
      element("summary", { children: "Report of the worker" }),
      element("div", { class: "report", children: turn.summary }),
    ],
  });
  return [commits, state, report];
}

export function Command(props: {
  readonly label: string;
  readonly command: string;
  readonly copyLabel?: string;
  readonly copying: Copying;
}): Shown {
  const { label, command, copying } = props;
  const onClick = (): void => {
    copying.onCopy(command);
  };
  const shown =
    copying.command === command ? copying.label : (props.copyLabel ?? "Copy");
  return element("div", {
    class: "command code-window",
    children: [
      element("span", { class: "label code-head", children: label }),
      element("code", { children: command }),
      element("button", { type: "button", onClick, children: shown }),
    ],
  });
}

export function Events(props: {
  readonly events: readonly WatchEvent[];
}): Shown {
  const { events } = props;
  const rows = events.map((event) =>
    element("div", {
      class: "event",
      children: `${clockTime(event.recordedAt)} ${event.type}`,
    }),
  );
  if (events.length === 0)
    return element("p", { class: "meta", children: "No events for this run." });
  return element("section", { class: "events code-window", children: rows });
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
      children: `Round ${String(review.round)} · Review ${String(review.score)}/5 · commit ${review.commit.slice(0, 7)}`,
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

export const turnFunctions = [
  turnHeading,
  Work,
  Command,
  Events,
  PullRequest,
  Review,
];
