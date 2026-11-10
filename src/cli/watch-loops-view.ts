import { record } from "../protocol.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { WatchLoop, WatchLoopRun } from "./watch-loops.ts";
import { watchHash } from "./watch-navigation.ts";
import { counted } from "./watch-render.ts";

export interface LoopControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly onSwitch: (workflowId: string, action: "pause" | "resume") => void;
  readonly onRun: (workflowId: string) => void;
}

export function loopTime(at: string | number): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function pastClock(at: string, now: string): string {
  const ended = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  const clock = ended.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (ended.toDateString() === today.toDateString()) return clock;
  if (ended.toDateString() === yesterday.toDateString())
    return `${clock} yesterday`;
  return loopTime(at);
}

export function lastRunText(run: WatchLoopRun, now: string): string {
  if (run.endedAt === null) return "last run in work";
  const mark = run.state === "completed" ? "✓" : `· ${run.state}`;
  return `last run ${pastClock(run.endedAt, now)} ${mark}`;
}

export function loopLastText(run: WatchLoopRun): string {
  return [
    run.state,
    run.outcome,
    run.endedAt === null ? null : `ended ${loopTime(run.endedAt)}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

export function loopMessage(reply: unknown): string {
  const fields = record(reply);
  const error = record(fields?.["error"]);
  if (error !== undefined)
    return `${String(error["code"])}: ${String(error["detail"])}`;
  if (fields?.["kind"] === "run-admitted")
    return `Run ${String(fields["runId"])} is admitted.`;
  const schedule = record(fields?.["schedule"]);
  if (schedule !== undefined)
    return `The loop is ${String(schedule["state"])}.`;
  return "The service gave no reply.";
}

export function LoopActions(props: {
  readonly loop: WatchLoop;
  readonly controls: LoopControls;
}): Shown {
  const { loop, controls } = props;
  const busy = controls.busy.includes(loop.workflowId);
  const active = loop.state === "active";
  const message = controls.messages[loop.workflowId];
  return [
    element("div", {
      class: "loop-actions",
      children: [
        element("label", {
          class: "loop-switch",
          children: [
            element("input", {
              type: "checkbox",
              role: "switch",
              checked: active,
              disabled: busy,
              "aria-label": `Loop ${loop.workflowId} on`,
              onChange: () => {
                controls.onSwitch(loop.workflowId, active ? "pause" : "resume");
              },
            }),
            active ? "On" : "Off",
          ],
        }),
        element("button", {
          type: "button",
          class: "loop-run",
          disabled: busy,
          onClick: () => {
            controls.onRun(loop.workflowId);
          },
          children: "Run now",
        }),
      ],
    }),
    message === undefined
      ? null
      : element("p", {
          class: "loop-message",
          role: "status",
          children: message,
        }),
  ];
}

export function LoopLast(props: {
  readonly run: WatchLoopRun | null;
  readonly now: string;
}): Shown {
  const { run, now } = props;
  if (run === null) return "no run yet";
  return element("a", {
    href: watchHash({ workflowId: null, runId: run.runId }),
    title: loopLastText(run),
    children: lastRunText(run, now),
  });
}

export function LoopCell(props: {
  readonly loop: WatchLoop;
  readonly next: string;
  readonly now: string;
  readonly controls?: LoopControls | undefined;
}): Shown {
  const { loop, next, now, controls } = props;
  return element("div", {
    class: `line-loop loop-${loop.state}`,
    children: [
      element("p", {
        class: "loop-rule",
        children: [
          element("span", { class: "loop-state", children: loop.state }),
          ` · ${loop.rule}`,
        ],
      }),
      next === "" ? null : element("p", { class: "loop-next", children: next }),
      element("p", {
        class: "loop-last",
        children: component(LoopLast, { run: loop.lastRun, now }),
      }),
      loop.failuresInRow === 0
        ? null
        : element("p", {
            class: "loop-failures",
            children: `${counted(loop.failuresInRow, "failure")} in a row`,
          }),
      controls === undefined
        ? null
        : component(LoopActions, { loop, controls }),
    ],
  });
}
