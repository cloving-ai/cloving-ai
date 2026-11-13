import { record, type Fields } from "../protocol.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { countText, type WatchWords } from "./watch-theme-view.ts";

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

export interface QueueControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly onCommand: (workflowId: string, command: "drain" | "resume") => void;
  readonly onLanes: (
    workflowId: string,
    change: { readonly lanes: number; readonly expectedLanes: number },
  ) => void;
}

export interface LineQueue {
  readonly queue?: Fields | undefined;
  readonly queuing?: QueueControls | undefined;
}

export function QueueLaneButtons(props: {
  readonly queue: Fields;
  readonly controls: QueueControls;
}): Shown {
  const { queue, controls } = props;
  const id = String(queue["workflowId"]);
  const lanes = Number(queue["lanes"]);
  return [-1, 1].map((change) =>
    element("button", {
      type: "button",
      disabled:
        controls.busy.includes(id) || lanes + change < 1 || lanes + change > 16,
      "aria-label": `${change < 0 ? "Fewer" : "More"} lanes for ${id}`,
      onClick: () => {
        controls.onLanes(id, { lanes: lanes + change, expectedLanes: lanes });
      },
      children: change < 0 ? "-" : "+",
    }),
  );
}

export function QueueSwitch(props: {
  readonly queue: Fields;
  readonly controls: QueueControls;
}): Shown {
  const { queue, controls } = props;
  const id = String(queue["workflowId"]);
  const active = queue["state"] === "running";
  const message = controls.messages[id];
  return [
    element("label", {
      class: "loop-switch",
      children: [
        element("input", {
          type: "checkbox",
          role: "switch",
          checked: active,
          disabled: controls.busy.includes(id),
          "aria-label": `Queue ${id} on`,
          onChange: () => {
            controls.onCommand(id, active ? "drain" : "resume");
          },
        }),
        active ? "On" : "Off",
      ],
    }),
    message === undefined
      ? null
      : element("p", {
          class: "queue-message",
          role: "status",
          children: message,
        }),
  ];
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

export function QueueLanes(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
}): Shown {
  const { busy, lanes } = props.queue;
  return element("div", {
    class: "queue-capacity",
    children: [
      props.controls === undefined
        ? null
        : component(QueueLaneButtons, {
            queue: props.queue,
            controls: props.controls,
          }),
      element("p", {
        children: `${String(busy)} of ${String(lanes)} lanes busy`,
      }),
      element("span", {
        class: "lanes",
        "aria-hidden": "true",
        children: Array.from({ length: Number(lanes) }, (_, index) =>
          element("span", {
            class: index < Number(busy) ? "lane busy" : "lane free",
          }),
        ),
      }),
    ],
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

export function QueueCard(props: {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { queue } = props;
  const interval = record(record(queue["settings"])?.["everySeconds"]);
  const rule =
    interval === undefined
      ? ""
      : ` · ${queueIntervalText(Number(interval["value"]))}`;
  const next = queue["nextCheckAt"];
  const state = queueCardState(queue);
  const reason = queueCardReason(queue);
  const controls = state === "off" ? undefined : props.controls;
  return element("div", {
    class: `line-queue queue-${state}`,
    children: [
      element("p", {
        class: "queue-rule",
        children: `${state === "off" ? "Queue off" : state}${rule}`,
      }),
      reason === null
        ? null
        : element("p", { class: "queue-reason", children: reason }),
      component(QueueLanes, { queue, controls }),
      typeof next !== "string"
        ? null
        : element("p", {
            class: "queue-next",
            children: `next check ${new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          }),
      component(QueueSources, { queue }),
      component(QueueSkipped, { queue, words: props.words }),
      controls === undefined
        ? null
        : component(QueueSwitch, { queue, controls }),
    ],
  });
}

export const queueCardFunctions = [
  queueIntervalText,
  skippedText,
  QueueLaneButtons,
  QueueSwitch,
  QueueSkipped,
  QueueSources,
  QueueLanes,
  queueCardState,
  queueCardReason,
  QueueCard,
];
