import { record, type Fields } from "../protocol.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { countText, type WatchWords } from "./watch-theme-view.ts";
import {
  QueueStepper,
  QueueMeter,
  QueueSettingFeedback,
  QueueOverLimit,
  QueueScopeAdvanced,
  type QueueControls,
} from "./watch-queue-setting-view.ts";
export type { QueueControls } from "./watch-queue-setting-view.ts";

export function skippedText(value: unknown): string {
  const ticket = record(value) ?? {};
  const name = `#${String(ticket["ticketId"])}`;
  const dependencies = ticket["dependencies"];
  if (
    ticket["reason"] === "ticket-dependency-open" &&
    Array.isArray(dependencies)
  )
    return `${name} waits for ${dependencies.map((item) => `#${String(item)}`).join(", ")}`;
  if (ticket["reason"] === "ticket-active") return `${name} is in work`;
  return `${name}: ${String(ticket["reason"])}`;
}

export interface LineQueue {
  readonly queue?: Fields | undefined;
  readonly queuing?: QueueControls | undefined;
}

export function queueIntervalText(seconds: number): string {
  if (seconds % 3600 === 0) return `every ${String(seconds / 3600)} h`;
  if (seconds % 60 === 0) return `every ${String(seconds / 60)} min`;
  return `every ${String(seconds)} s`;
}

export function QueueSkipped(props: {
  readonly queue: Fields;
  readonly words?: WatchWords | undefined;
}): Shown {
  const skipped = props.queue["skipped"];
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  return element("details", {
    class: "queue-waiting",
    children: [
      element("summary", {
        children: `${countText(props.words, { key: "ticket.unit", count: skipped.length, noun: "ticket" })} skipped`,
      }),
      element("ul", {
        children: skipped.map((value) =>
          element("li", { children: skippedText(value) }),
        ),
      }),
    ],
  });
}

export function QueueFeed(props: { readonly queue: Fields }): Shown {
  const feed = record(props.queue["feed"]);
  if (feed === undefined) return null;
  const skipped = feed["skipped"];
  const time = new Date(String(feed["at"])).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return element("p", {
    class: "queue-feed",
    children: `last feed ${time}: ${String(feed["picks"])} picks, ${String(Array.isArray(skipped) ? skipped.length : 0)} skipped`,
  });
}

export function QueueSources(props: { readonly queue: Fields }): Shown {
  const settings = record(props.queue["settings"]);
  return [
    ["everySeconds", "interval"],
    ["lanes", "lanes"],
    ["workingLanes", "working lanes"],
  ].map(([key, label]) => {
    const value = record(settings?.[key ?? ""]);
    return value === undefined
      ? null
      : element("p", {
          class: "queue-source",
          children: `${label ?? ""}: ${String(value["source"])}`,
        });
  });
}

export function queueCardState(queue: Fields): string {
  if (queue["state"] === "running" && record(queue["hold"]) !== undefined)
    return "held";
  return String(queue["state"]);
}

export function queueCardReason(queue: Fields): string | null {
  const state = queueCardState(queue);
  if (state === "held")
    return `held: ${String(record(queue["hold"])?.["text"]).replace(/^Held:\s*/i, "")}`;
  if (state === "off") {
    const reason = record(queue["off"])?.["reason"];
    return typeof reason === "string"
      ? reason
      : "state off in the queues setting";
  }
  if (state === "stopped")
    return `the queue stopped: ${String(record(queue["stop"])?.["reason"])}`;
  return null;
}

export function QueueDetails(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
  readonly words?: WatchWords | undefined;
  readonly now?: string | undefined;
}): Shown {
  const { queue } = props;
  const interval = record(record(queue["settings"])?.["everySeconds"]);
  const rule =
    interval === undefined
      ? ""
      : ` · ${queueIntervalText(Number(interval["value"]))}`;
  const next = queue["nextCheckAt"];
  return element("details", {
    class: "queue-more",
    children: [
      element("summary", { children: "More" }),
      element("div", {
        class: "queue-details",
        children: [
          element("p", { children: `Queue ${queueCardState(queue)}${rule}` }),
          typeof next === "string"
            ? element("p", {
                children: `next check ${new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
              })
            : null,
          component(QueueScopeAdvanced, props),
          component(QueueSources, { queue }),
          component(QueueFeed, { queue }),
          component(QueueOldest, props),
          component(QueueSkipped, { queue, words: props.words }),
        ],
      }),
    ],
  });
}

export function QueueActions(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
  readonly words?: WatchWords | undefined;
  readonly now?: string | undefined;
}): Shown {
  const { queue, controls } = props;
  const command =
    queueCardState(queue) === "held" || queue["state"] === "running"
      ? "drain"
      : "resume";
  return element("div", {
    class: "queue-row",
    children: [
      component(QueueStepper, { ...props, field: "lanes" }),
      controls === undefined
        ? null
        : element("button", {
            type: "button",
            class: "queue-drain",
            disabled: controls.busy.includes(String(queue["workflowId"])),
            onClick: () => {
              controls.onCommand(String(queue["workflowId"]), command);
            },
            children: command === "drain" ? "Drain" : "Resume",
          }),
      component(QueueDetails, props),
    ],
  });
}

export function queueReadyText(queue: Fields, words?: WatchWords): string {
  const count = record(queue["ready"])?.["count"];
  if (typeof count !== "number") return "unknown ready";
  return words?.["ready.count"] === undefined
    ? `${String(count)} ready`
    : countText(words, { key: "ready.count", count, noun: "ready" });
}

export function QueueOldest(props: {
  readonly queue: Fields;
  readonly now?: string | undefined;
}): Shown {
  const oldest = record(props.queue["ready"])?.["oldestAt"];
  if (typeof oldest !== "string" || props.now === undefined) return null;
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(props.now) - Date.parse(oldest)) / 60_000),
  );
  const age =
    minutes < 60
      ? `${String(minutes)}m`
      : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  return element("span", { class: "line-wait", children: `oldest ${age}` });
}

export function QueueCounts(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
  readonly words?: WatchWords | undefined;
}): Shown {
  const failure = record(props.queue["ready"])?.["failure"];
  return element("span", {
    class: "queue-counts",
    role: "status",
    children: props.controls?.acknowledgements?.[
      String(props.queue["workflowId"])
    ] ?? [
      `${String(props.queue["busy"])} in progress · `,
      element("span", {
        class: "line-ready",
        ...(typeof failure === "string" ? { title: failure } : {}),
        children:
          typeof failure === "string"
            ? "Ready list failed"
            : queueReadyText(props.queue, props.words),
      }),
    ],
  });
}

export function QueueCard(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
  readonly words?: WatchWords | undefined;
  readonly now?: string | undefined;
}): Shown {
  const { queue } = props;
  const state = queueCardState(queue);
  const reason = queueCardReason(queue);
  const controls = state === "off" ? undefined : props.controls;
  return element("div", {
    class: `line-queue queue-${state}`,
    children: [
      element("div", {
        class: "queue-row",
        children: [
          element("strong", { children: "Queue" }),
          component(QueueCounts, props),
        ],
      }),
      component(QueueMeter, { queue }),
      component(QueueActions, {
        queue,
        controls,
        words: props.words,
        now: props.now,
      }),
      reason === null
        ? null
        : element("p", { class: "queue-reason", children: reason }),
      component(QueueOverLimit, { queue }),
      component(QueueSettingFeedback, {
        queue,
        controls: props.controls,
        eligible: state !== "off",
      }),
    ],
  });
}

export const queueCardFunctions = [
  queueIntervalText,
  skippedText,
  QueueSkipped,
  QueueSources,
  QueueFeed,
  queueCardState,
  queueCardReason,
  queueReadyText,
  QueueOldest,
  QueueCounts,
  QueueDetails,
  QueueActions,
  QueueCard,
];
