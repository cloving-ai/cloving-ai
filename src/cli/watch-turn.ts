import { priceText, usageText } from "./usage-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import {
  clockTime,
  counted,
  groupActivity,
  turnTime,
  type Copying,
  type WatchDecision,
  type WatchEvent,
  type WatchItem,
  type WatchTurn,
  type WatchRun,
} from "./watch-render.ts";

export function Item(props: { readonly item: WatchItem }): Shown {
  const { kind, text } = props.item;
  const title = kind === "tool" ? text : undefined;
  return element("div", { class: `item ${kind}`, title, children: text });
}

export function Group(props: {
  readonly items: readonly WatchItem[];
  readonly open: boolean;
}): Shown {
  const { items, open } = props;
  const lines = items.map((item) => component(Item, { item }));
  if (items.length < 2) return lines;
  const errors = items.filter((item) => item.kind === "error").length;
  const failed = element("span", {
    class: "bad",
    children: counted(errors, "error"),
  });
  const summary = [
    counted(items.length - errors, "tool call"),
    errors === 0 ? null : [" · ", failed],
    element("span", { class: "last", children: items.at(-1)?.text }),
  ];
  return element("details", {
    class: "tools",
    open,
    children: [element("summary", { children: summary }), lines],
  });
}

export function Turn(props: {
  readonly turn: WatchTurn;
  readonly now: string;
}): Shown {
  const { turn, now } = props;
  const groups = groupActivity(turn.activity);
  const working = turn.outcome === "in work";
  const cost = priceText(turn.costUsd, turn.estimatedCostUsd);
  const heading = ["Agent turn", turn.outcome, turnTime(turn, now), cost];
  const place = `Branch ${turn.branch} · work tree ${turn.worktree}`;
  const activity = groups.map((items, index) =>
    component(Group, { items, open: working && index === groups.length - 1 }),
  );
  return element("section", {
    class: "turn code-window",
    children: [
      element("h3", {
        class: "code-head",
        children: heading.filter((part) => part !== "").join(" · "),
      }),
      element("p", { class: "meta", children: place }),
      element("p", {
        class: "turn-usage",
        children: usageText(turn.usage),
      }),
      element("div", { class: "activity", children: activity }),
    ],
  });
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

export function Decision(props: {
  readonly decision: WatchDecision;
  readonly turn: WatchTurn | undefined;
  readonly copying: Copying;
}): Shown {
  const { decision, turn, copying } = props;
  const request = element("details", {
    open: turn === undefined,
    children: [
      element("summary", { children: "Full text of the request" }),
      element("pre", { children: decision.prompt }),
    ],
  });
  return element("section", {
    class: "decision",
    children: [
      element("h3", { children: `Your decision · ${decision.type}` }),
      turn === undefined ? null : component(Work, { turn }),
      request,
      component(Command, {
        label: "Approve",
        command: decision.approve,
        copying,
      }),
      component(Command, { label: "Deny", command: decision.deny, copying }),
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
  return element("details", {
    class: "events code-window",
    children: [
      element("summary", {
        class: "code-head",
        children: `All events (${String(events.length)})`,
      }),
      rows,
    ],
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
