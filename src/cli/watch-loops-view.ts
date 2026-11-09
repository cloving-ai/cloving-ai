import { record } from "../protocol.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { WatchLoop, WatchLoopRun } from "./watch-loops.ts";
import { watchHash } from "./watch-navigation.ts";

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

export function loopAmount(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  if (minutes < 2880) return `${String(Math.round(minutes / 60))} h`;
  return `${String(Math.round(minutes / 1440))} d`;
}

export function relativeText(at: string, now: string): string {
  const minutes = Math.round((Date.parse(at) - Date.parse(now)) / 60000);
  const size = Math.abs(minutes);
  if (size < 1) return "now";
  return minutes > 0 ? `in ${loopAmount(size)}` : `${loopAmount(size)} ago`;
}

export function loopNextText(nextAt: string | null, now: string): string {
  if (nextAt === null) return "No next run";
  return `Next run ${loopTime(nextAt)} · ${relativeText(nextAt, now)}`;
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

export function LoopRow(props: {
  readonly loop: WatchLoop;
  readonly now: string;
  readonly controls?: LoopControls | undefined;
}): Shown {
  const { loop, now, controls } = props;
  const { lastRun } = loop;
  return [
    element("div", {
      class: "loop-head",
      children: [
        element("a", {
          class: "loop-workflow",
          href: watchHash({ workflowId: loop.workflowId, runId: null }),
          children: loop.workflowId,
        }),
        element("span", { class: "loop-state", children: loop.state }),
      ],
    }),
    element("p", { class: "loop-rule", children: loop.rule }),
    element("p", {
      class: "loop-next",
      children: loopNextText(loop.nextAt, now),
    }),
    element("p", {
      class: "loop-last",
      children:
        lastRun === null
          ? "No run yet"
          : [
              "Last run ",
              element("a", {
                href: watchHash({ workflowId: null, runId: lastRun.runId }),
                children: loopLastText(lastRun),
              }),
            ],
    }),
    element("p", {
      class: "loop-failures",
      children: `${String(loop.failuresInRow)} failures in a row`,
    }),
    controls === undefined ? null : component(LoopActions, { loop, controls }),
  ];
}

export function LoopsPanel(props: {
  readonly loops: readonly WatchLoop[];
  readonly now: string;
  readonly controls?: LoopControls | undefined;
}): Shown {
  const { loops, now, controls } = props;
  if (loops.length === 0) return null;
  return element("section", {
    class: "loops",
    "aria-labelledby": "loops-title",
    children: [
      element("h2", { id: "loops-title", children: "Loops" }),
      element("ul", {
        class: "loops-list",
        children: loops.map((loop) =>
          element("li", {
            key: loop.workflowId,
            class: `loop loop-${loop.state}`,
            children: component(LoopRow, { loop, now, controls }),
          }),
        ),
      }),
    ],
  });
}
