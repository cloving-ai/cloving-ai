import type { ShownSchedule } from "./schedule-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import {
  countText,
  labelWord,
  wordText,
  type WatchWords,
} from "./watch-theme-view.ts";
import {
  type WatchLamp,
  type WatchModel,
  type WatchReady,
  type WatchStation,
  type WatchToken,
  type WatchWorkflow,
} from "./watch-render.ts";

export function lampLabel(lamp: WatchLamp | null): string {
  const labels: Readonly<Record<WatchLamp, string>> = {
    stopped: "Stopped",
    "needs-you": "Needs you",
    waiting: "Waiting",
    running: "Running",
  };
  return lamp === null ? "No run" : labels[lamp];
}

export function stepAge(startedAt: string | null, now: string): string {
  const minutes = Math.floor(
    (Date.parse(now) - Date.parse(startedAt ?? "")) / 60000,
  );
  if (Number.isNaN(minutes)) return "";
  const shown = Math.max(0, minutes);
  if (shown < 60) return `${String(shown)}m`;
  return `${String(Math.floor(shown / 60))}h ${String(shown % 60)}m`;
}

export function Token(props: {
  readonly token: WatchToken;
  readonly now: string;
}): Shown {
  const { token, now } = props;
  return element("a", {
    class: `token ${token.lamp}`,
    href: watchHash({ workflowId: null, runId: token.runId }),
    title: token.title ?? token.runId,
    children: [
      element("span", { class: "token-worker", children: token.worker }),
      element("span", { class: "token-ticket", children: token.ticket }),
      element("span", {
        class: "token-time",
        children: stepAge(token.startedAt, now),
      }),
    ],
  });
}

export function Station(props: {
  readonly station: WatchStation;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { station, now } = props;
  const lamp = station.lamp ?? "empty";
  return element("li", {
    class: `station ${lamp}`,
    children: [
      element("span", {
        class: `lamp ${lamp}`,
        title: lampLabel(station.lamp),
      }),
      element("span", {
        class: "station-name",
        children: labelWord(props.words, station.name),
      }),
      station.tokens.length === 0
        ? null
        : element("ul", {
            class: "tokens",
            children: station.tokens.map((token) =>
              element("li", {
                key: token.runId,
                children: component(Token, { token, now }),
              }),
            ),
          }),
    ],
  });
}

export function nextRunText(
  schedule: ShownSchedule | undefined,
  now: string,
): string {
  if (schedule === undefined) return "";
  if (schedule.state !== "active") return `schedule ${schedule.state}`;
  if (schedule.nextAt === null) return "";
  const next = new Date(schedule.nextAt);
  const today = new Date(now);
  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
  );
  const clock = next.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (next.toDateString() === today.toDateString()) return `next run ${clock}`;
  if (next.toDateString() === tomorrow.toDateString())
    return `next run ${clock} tomorrow`;
  return `next run ${next.toLocaleString()}`;
}

export function ReadyCount(props: {
  readonly ready: WatchReady;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { ready, now, words } = props;
  if ("failure" in ready)
    return element("span", {
      class: "line-ready",
      title: ready.failure,
      children: "Ready list failed",
    });
  return [
    element("span", {
      class: "line-ready",
      children:
        words?.["ready.count"] === undefined
          ? `${String(ready.count)} ready`
          : countText(words, {
              key: "ready.count",
              count: ready.count,
              noun: "ready",
            }),
    }),
    ready.oldestAt === null
      ? null
      : element("span", {
          class: "line-wait",
          children: `oldest ${stepAge(ready.oldestAt, now)}`,
        }),
  ];
}

export function LineEnd(props: {
  readonly workflow: WatchWorkflow;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { ready, schedule } = props.workflow;
  const next = nextRunText(schedule, props.now);
  return element("div", {
    class: "line-end",
    children: [
      ready === undefined
        ? null
        : component(ReadyCount, { ready, now: props.now, words: props.words }),
      next === ""
        ? null
        : element("span", { class: "line-next", children: next }),
    ],
  });
}

export function Legend(): Shown {
  const lamps: readonly WatchLamp[] = [
    "running",
    "waiting",
    "needs-you",
    "stopped",
  ];
  return element("ul", {
    class: "legend",
    "aria-label": "Lamp colors",
    children: lamps.map((lamp) =>
      element("li", {
        key: lamp,
        children: [
          element("span", { class: `lamp ${lamp}`, "aria-hidden": "true" }),
          lampLabel(lamp),
        ],
      }),
    ),
  });
}

export function Line(props: {
  readonly workflow: WatchWorkflow;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { workflow, now, words } = props;
  return element("li", {
    class: "line",
    children: [
      element("div", {
        class: "line-name",
        children: [
          element("a", {
            href: watchHash({ workflowId: workflow.workflowId, runId: null }),
            children: workflow.workflowId,
          }),
          element("span", {
            class: "line-active",
            children: `${String(workflow.activeCount)} active`,
          }),
        ],
      }),
      element("div", {
        class: "line-track",
        children: element("ol", {
          class: "stations",
          children: workflow.stations.map((station) =>
            component(Station, { key: station.name, station, now, words }),
          ),
        }),
      }),
      component(LineEnd, { workflow, now, words }),
    ],
  });
}

export function Floor(props: {
  readonly model: WatchModel;
  readonly now: string;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { model, now, words } = props;
  return element("section", {
    class: "floor",
    "aria-labelledby": "floor-title",
    children: [
      element("div", {
        class: "floor-head",
        children: [
          element("h2", {
            id: "floor-title",
            children: wordText(words, {
              key: "workflows.title",
              text: "Floor",
            }),
          }),
          component(Legend, {}),
        ],
      }),
      model.workflows.length === 0
        ? element("p", { class: "meta", children: "No workflows registered." })
        : element("ol", {
            class: "lines",
            children: model.workflows.map((workflow) =>
              component(Line, {
                key: workflow.workflowId,
                workflow,
                now,
                words,
              }),
            ),
          }),
    ],
  });
}
