import { component, element, type Shown } from "./watch-element.ts";
import { phaseTime, runTone, type WatchRun } from "./watch-render.ts";
import {
  DropQuestion,
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
import { reasonText } from "./watch-needs-view.ts";

interface HeadControls {
  readonly steering?: SteerControls | undefined;
  readonly controlling?: RunCommandControls | undefined;
  readonly renaming?: RenameControls | undefined;
}

interface MenuEvent {
  readonly currentTarget: unknown;
}

interface MenuPick extends MenuEvent {
  readonly target: unknown;
}

interface KeyEvent extends MenuPick {
  readonly key: string;
}

interface Marked {
  readonly setAttribute: (name: string, value: string) => void;
  readonly removeAttribute: (name: string) => void;
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

export function PauseButton(props: {
  readonly run: WatchRun;
  readonly controlling: RunCommandControls;
}): Shown {
  const { run, controlling } = props;
  const command = run.state === "paused" ? "resume" : "pause";
  return element("button", {
    type: "button",
    class: `run-command-${command}`,
    ...(controlling.busy.includes(run.runId) ? { disabled: true } : {}),
    onClick: () => {
      controlling.onCommand(run.runId, command);
    },
    children: command === "resume" ? "Resume" : "Pause",
  });
}

export function blurrable(value: unknown): value is { blur: () => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "blur" in value &&
    typeof value.blur === "function"
  );
}

export function marked(value: unknown): value is Marked {
  return (
    typeof value === "object" &&
    value !== null &&
    "setAttribute" in value &&
    typeof value.setAttribute === "function" &&
    "removeAttribute" in value &&
    typeof value.removeAttribute === "function"
  );
}

export function holdMenu(event: MenuEvent): void {
  if (marked(event.currentTarget))
    event.currentTarget.setAttribute("data-hold", "");
}

export function releaseMenu(event: MenuEvent): void {
  if (marked(event.currentTarget))
    event.currentTarget.removeAttribute("data-hold");
}

export function closable(
  value: unknown,
): value is { readonly closest: (selector: string) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "closest" in value &&
    typeof value.closest === "function"
  );
}

export function pickMenu(event: KeyEvent | MenuPick): void {
  const { target } = event;
  if (closable(target) && target.closest(".run-more-open") !== null)
    releaseMenu(event);
  else holdMenu(event);
}

export function closeMenu(event: KeyEvent): void {
  if (event.key !== "Escape") return;
  holdMenu(event);
  if (blurrable(event.target)) event.target.blur();
}

export function RunMore(
  props: HeadControls & { readonly run: WatchRun },
): Shown {
  const { run, renaming, controlling } = props;
  const droppable = controlling !== undefined && steerable(run.state);
  const drop = droppable
    ? [
        renaming === undefined
          ? null
          : element("hr", { class: "run-more-split" }),
        element("button", {
          type: "button",
          class: "run-command-drop",
          ...(controlling.busy.includes(run.runId) ? { disabled: true } : {}),
          onClick: () => {
            controlling.onAsk(run.runId, "detail");
          },
          children: "Drop",
        }),
      ]
    : null;
  return element("div", {
    class: "run-more",
    onKeyDown: closeMenu,
    onClick: pickMenu,
    onMouseEnter: releaseMenu,
    onMouseLeave: releaseMenu,
    onFocusIn: releaseMenu,
    children: [
      element("button", {
        type: "button",
        class: "run-more-open",
        title: "More run controls",
        "aria-haspopup": "true",
        children: [
          element("span", { "aria-hidden": "true", children: "⋯" }),
          element("span", {
            class: "visually-hidden",
            children: "More run controls",
          }),
        ],
      }),
      element("div", {
        class: "run-more-menu",
        "aria-label": "More run controls",
        children: [
          renaming === undefined
            ? null
            : component(RenameButtons, { run, renaming }),
          drop,
        ],
      }),
    ],
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
      ? component(PauseButton, { run, controlling })
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

export function plainReason(run: WatchRun): string {
  return run.state === "paused" ? reasonText(run) : run.detail;
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
  PauseButton,
  blurrable,
  marked,
  holdMenu,
  releaseMenu,
  closable,
  pickMenu,
  closeMenu,
  RunMore,
  RunHeadActions,
  CommandNotice,
  SteerNotice,
  RunNotices,
  plainReason,
  factParts,
  RunFacts,
];
