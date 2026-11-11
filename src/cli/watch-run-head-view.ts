import { component, element, type Shown } from "./watch-element.ts";
import {
  counted,
  elapsed,
  phaseTime,
  runTone,
  type WatchRun,
  type WatchTurn,
} from "./watch-render.ts";
import {
  DropButton,
  DropQuestion,
  PauseButton,
  RunCommandMessage,
  dropReply,
  type RunCommandControls,
} from "./watch-run-command-view.ts";
import {
  RenameButtons,
  RenameForm,
  type RenameControls,
} from "./watch-rename-view.ts";
import {
  SteerForm,
  steerable,
  type SteerControls,
} from "./watch-steer-view.ts";
import { priceText } from "./usage-render.ts";
import { MenuShell, menuPicked } from "./watch-token-menu-view.ts";
import { turnNow } from "./watch-turn.ts";

interface HeadControls {
  readonly steering?: SteerControls | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
}

export function RunIdentity(props: {
  readonly run: WatchRun;
  readonly renaming?: RenameControls | undefined;
}): Shown {
  const { run, renaming } = props;
  if (renaming?.open === run.runId)
    return component(RenameForm, { runId: run.runId, renaming });
  const label = run.label ?? null;
  return element("h2", {
    class: "run-identity",
    children: [
      label === null
        ? null
        : element("span", { class: "name-label", children: label }),
      element("span", {
        class: "name-title",
        children: run.title ?? run.runId,
      }),
      renaming === undefined
        ? null
        : element("button", {
            type: "button",
            class: "name-edit",
            title: "Rename",
            "aria-label": "Rename",
            ...(renaming.busy.includes(run.runId) ? { disabled: true } : {}),
            onClick: () => {
              renaming.onOpen({
                runId: run.runId,
                title: run.title ?? "",
                label: label ?? "",
              });
            },
            children: "✎",
          }),
    ],
  });
}

export function RunStatus(props: {
  readonly run: WatchRun;
  readonly now: string;
}): Shown {
  const { run, now } = props;
  const phase = run.phases.find((item) => item.state === "active");
  const time = phase === undefined ? "" : phaseTime(phase, now);
  const parts = [runTone(run).label, phase?.name ?? "", time].filter(
    (part) => part !== "",
  );
  return element("p", { class: "run-status", children: parts.join(" · ") });
}

export function RunMore(
  props: HeadControls & { readonly run: WatchRun },
): Shown {
  const { run, renaming, controlling } = props;
  const droppable = controlling !== undefined && steerable(run.state);
  return component(MenuShell, {
    id: `run-menu-${run.runId}`,
    label: "More run controls",
    picked: menuPicked,
    children: element("div", {
      class: "run-more-items",
      children: [
        renaming === undefined
          ? null
          : component(RenameButtons, { run, renaming }),
        droppable && renaming !== undefined
          ? element("hr", { class: "token-separator" })
          : null,
        droppable
          ? element("div", {
              class: "token-danger",
              children: component(DropButton, {
                runId: run.runId,
                place: "detail",
                paused: false,
                controlling,
              }),
            })
          : null,
      ],
    }),
  });
}

export function RunHeadActions(
  props: HeadControls & { readonly run: WatchRun },
): Shown {
  const { run, steering, controlling } = props;
  const live = steerable(run.state);
  const children = [
    live && steering !== undefined && steering.open !== run.runId
      ? element("button", {
          type: "button",
          class: "steer-open",
          onClick: () => {
            steering.onOpen(run.runId);
          },
          children: "Steer",
        })
      : null,
    live && controlling !== undefined
      ? component(PauseButton, {
          runId: run.runId,
          place: "detail",
          paused: run.state === "paused",
          controlling,
        })
      : null,
    props.renaming !== undefined || (live && controlling !== undefined)
      ? component(RunMore, props)
      : null,
  ];
  if (children.every((child) => child === null)) return null;
  return element("div", { class: "run-head-actions", children });
}

export function CommandNotice(props: {
  readonly run: WatchRun;
  readonly controlling: RunCommandControls | undefined;
}): Shown {
  const { run, controlling } = props;
  if (controlling === undefined) return null;
  if (!steerable(run.state))
    return component(RunCommandMessage, {
      text: dropReply(controlling, run.runId),
    });
  const text = controlling.messages[run.runId]?.text;
  const asking =
    controlling.asking?.runId === run.runId &&
    controlling.asking.place === "detail";
  if (!asking && text === undefined) return null;
  return element("div", {
    class: "run-command",
    "data-run": run.runId,
    "data-place": "detail",
    children: [
      asking
        ? component(DropQuestion, { runId: run.runId, controlling })
        : null,
      component(RunCommandMessage, { text }),
    ],
  });
}

export function SteerNotice(props: {
  readonly run: Pick<WatchRun, "runId" | "state">;
  readonly steering: SteerControls | undefined;
}): Shown {
  const { steering } = props;
  const { runId } = props.run;
  if (steering === undefined) return null;
  const message = steering.messages[runId];
  const open = steering.open === runId && steerable(props.run.state);
  if (!open && message === undefined) return null;
  return element("div", {
    class: "steer",
    children: [
      open ? component(SteerForm, { runId, steering }) : null,
      message === undefined
        ? null
        : element("p", {
            class: "steer-message",
            role: "status",
            children: message,
          }),
    ],
  });
}

export function RunNotices(
  props: HeadControls & { readonly run: WatchRun },
): Shown {
  const { run, renaming } = props;
  const renamed = renaming?.messages[run.runId];
  return [
    component(CommandNotice, { run, controlling: props.controlling }),
    component(SteerNotice, { run, steering: props.steering }),
    renamed === undefined
      ? null
      : element("p", {
          class: "rename-message",
          role: "status",
          children: renamed,
        }),
  ];
}

export function liveLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return line
    .trim()
    .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/u, "")
    .replaceAll("`", "")
    .replaceAll(/(\*{1,3}|(?<!\w)_{1,3})(?=\S)(.+?)(?<=\S)\1(?!\w)/gu, "$2");
}

export function workingDetail(turn: WatchTurn, now: string): Shown {
  const calls = turn.activity.filter((item) => item.kind === "tool").length;
  const quiet =
    turn.activeAt === null
      ? ""
      : ` · last output ${elapsed(turn.activeAt, now)} ago`;
  const last = turnNow(turn, now);
  const worker =
    turn.harness === undefined ? "The worker" : `The ${turn.harness} worker`;
  return [
    `${worker} works for ${elapsed(turn.startedAt, now)} · ${counted(calls, "tool call")}${quiet}`,
    element("span", { class: "now", title: last, children: liveLine(last) }),
  ];
}

export function factParts(run: WatchRun): readonly Shown[] {
  const review = run.reviews.at(-1);
  const price = priceText(run.claudeCostUsd, run.estimatedCostUsd);
  return [
    run.pullRequest === null
      ? null
      : element("a", {
          href: run.pullRequest.url,
          children: `PR #${String(run.pullRequest.number)}`,
        }),
    review === undefined ? null : `review ${String(review.score)}/5`,
    price === "Price not known" ? null : price,
    run.chain === undefined
      ? null
      : `run ${String(run.chain.position)} of ${String(run.chain.limit)}`,
  ].filter((part) => part !== null);
}

export function RunFacts(props: { readonly run: WatchRun }): Shown {
  const parts = factParts(props.run);
  if (parts.length === 0) return null;
  return element("p", {
    class: "run-facts",
    children: parts.flatMap((part, index) =>
      index === 0 ? [part] : [" · ", part],
    ),
  });
}

export const runHeadFunctions = [
  RunIdentity,
  RunStatus,
  RunMore,
  RunHeadActions,
  CommandNotice,
  SteerNotice,
  RunNotices,
  liveLine,
  workingDetail,
  factParts,
  RunFacts,
];
