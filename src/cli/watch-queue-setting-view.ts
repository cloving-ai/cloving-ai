import { record, type Fields } from "../protocol.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { QueueSettingRequest } from "../queue-setting-operation.ts";

export interface QueueControls {
  readonly acknowledgements?: Readonly<Record<string, string>>;
  readonly onSetting?: (change: Omit<QueueSettingRequest, "commandId">) => void;
  readonly retry?: readonly string[];
  readonly onRetry?: (key: string) => void;
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly onCommand: (workflowId: string, command: "drain" | "resume") => void;
  readonly onLanes: (
    workflowId: string,
    change: { readonly lanes: number; readonly expectedLanes: number },
  ) => void;
}

export interface QueueScopeProps {
  readonly queue: Fields;
  readonly controls?: QueueControls | undefined;
}

export function queueScopeKey(queue: Fields): string {
  return typeof queue["workflowId"] === "string"
    ? queue["workflowId"]
    : "@global";
}

export function queueScopeValue(
  queue: Fields,
  field: "lanes" | "workingLanes",
): number {
  if (field === "lanes") return Number(queue["lanes"]);
  return Number(
    queue["workingLanes"] ??
      record(record(queue["settings"])?.[field])?.["value"] ??
      queue["lanes"],
  );
}

export function queueScopeChange(
  queue: Fields,
  field: "lanes" | "workingLanes",
) {
  const workflowId = queue["workflowId"];
  return {
    field,
    expectedValue: queueScopeValue(queue, field),
    ...(typeof workflowId === "string"
      ? { scope: "workflow" as const, workflowId }
      : { scope: "global" as const }),
  };
}

export function QueueStepper(
  props: QueueScopeProps & { readonly field: "lanes" | "workingLanes" },
): Shown {
  const { queue, controls, field } = props;
  const value = queueScopeValue(queue, field);
  const name = field === "lanes" ? "Lanes" : "Active work cap";
  const scope =
    typeof queue["workflowId"] === "string"
      ? queue["workflowId"]
      : "Global queue";
  const button = (change: number): Shown =>
    element("button", {
      type: "button",
      class: "queue-lane-button",
      disabled:
        controls?.busy.includes(queueScopeKey(queue)) === true ||
        value + change < 1 ||
        value + change > (field === "lanes" ? 16 : Number(queue["lanes"])),
      "aria-label": `${change < 0 ? "Fewer" : "More"} ${field === "lanes" ? "lanes" : "active-work lanes"} for ${scope}`,
      onClick: () => {
        if (controls?.onSetting !== undefined)
          controls.onSetting({
            ...queueScopeChange(queue, field),
            action: "set",
            value: value + change,
          });
        else if (typeof queue["workflowId"] === "string" && field === "lanes")
          controls?.onLanes(queue["workflowId"], {
            lanes: value + change,
            expectedLanes: value,
          });
      },
      children: change < 0 ? "−" : "+",
    });
  return element("div", {
    class: "queue-stepper",
    role: "group",
    "aria-label": `${name} for ${scope}`,
    children: [
      element("span", { children: name }),
      controls === undefined ? null : button(-1),
      element("output", {
        "aria-label": `${name} limit`,
        children: String(value),
      }),
      controls === undefined ? null : button(1),
    ],
  });
}

export function QueueMeter(props: { readonly queue: Fields }): Shown {
  const busy = Number(props.queue["busy"]);
  const lanes = Number(props.queue["lanes"]);
  return element("span", {
    class: "lanes queue-meter",
    role: "img",
    "aria-label": `${String(busy)} of ${String(lanes)} lanes busy`,
    children: Array.from({ length: Math.max(lanes, busy) }, (_, index) =>
      element("span", { class: index < busy ? "lane busy" : "lane free" }),
    ),
  });
}

export function QueueSettingFeedback(
  props: QueueScopeProps & { readonly eligible?: boolean },
): Shown {
  const key = queueScopeKey(props.queue);
  const controls = props.controls;
  const message = controls?.messages[key];
  if (!message) return null;
  const pending = controls.busy.includes(key);
  return element("div", {
    class: "queue-message",
    role: pending ? "status" : "alert",
    children: [
      message,
      props.eligible !== false && controls.retry?.includes(key) === true
        ? element("button", {
            type: "button",
            disabled: pending,
            onClick: () => controls.onRetry?.(key),
            children: "Retry same request",
          })
        : null,
    ],
  });
}

export function QueueOverLimit(props: { readonly queue: Fields }): Shown {
  const excess = Number(props.queue["busy"]) - Number(props.queue["lanes"]);
  if (
    excess <= 0 &&
    Number(props.queue["working"]) >= Number(props.queue["workingLanes"]) &&
    Number(props.queue["workingLanes"]) < Number(props.queue["lanes"])
  )
    return element("p", {
      class: "queue-warning",
      children: "Active-work cap reached · new starts wait",
    });
  return excess <= 0
    ? null
    : element("p", {
        class: "queue-warning",
        children: `${String(excess)} over limit · new starts wait`,
      });
}

export function QueueReset(
  props: QueueScopeProps & { readonly field: "lanes" | "workingLanes" },
): Shown {
  const { queue, controls, field } = props;
  if (controls?.onSetting === undefined) return null;
  return element("button", {
    type: "button",
    disabled: controls.busy.includes(queueScopeKey(queue)),
    onClick: () =>
      controls.onSetting?.({
        ...queueScopeChange(queue, field),
        action: "inherit",
      }),
    children:
      field === "lanes"
        ? "Use inherited lanes"
        : "Use inherited active-work cap",
  });
}

export function QueueInheritance(
  props: QueueScopeProps & { readonly field: "lanes" | "workingLanes" },
): Shown {
  const { queue, field, controls } = props;
  const global = typeof queue["workflowId"] !== "string";
  const given = global
    ? record(queue["sources"])?.[field]
    : record(record(queue["settings"])?.[field])?.["source"];
  const source = typeof given === "string" ? given : "default";
  const own = source.includes("private file");
  return element("p", {
    class: "queue-source",
    children: [
      `${field === "lanes" ? "Lanes" : "Active work"}: ${source} · ${own ? "private override" : "inherited"}. `,
      own ? component(QueueReset, { queue, controls, field }) : null,
    ],
  });
}

export function QueueScopeAdvanced(props: QueueScopeProps): Shown {
  return [
    element("h4", { children: "Advanced" }),
    element("p", {
      children:
        "Lanes set the maximum concurrent runs. Waiting for CI or a person still occupies a lane. The active-work cap limits runs actively running commands or agents.",
    }),
    component(QueueStepper, { ...props, field: "workingLanes" }),
    typeof props.queue["working"] === "number"
      ? element("p", {
          children: `${String(props.queue["working"])} of ${String(props.queue["workingLanes"])} active-work lanes busy`,
        })
      : null,
    component(QueueInheritance, { ...props, field: "lanes" }),
    component(QueueInheritance, { ...props, field: "workingLanes" }),
  ];
}

export function GlobalQueue(props: QueueScopeProps): Shown {
  const { queue } = props;
  const controls = queue["eligible"] === true ? props.controls : undefined;
  return element("section", {
    class: "global-queue",
    "aria-label": "Global queue",
    children: [
      element("h3", { children: "Global queue" }),
      element("p", {
        children: `Global queue ${String(queue["state"])}, ${String(queue["busy"])} of ${String(queue["lanes"])} global lanes busy`,
      }),
      component(QueueMeter, { queue }),
      component(QueueStepper, { queue, controls, field: "lanes" }),
      controls?.acknowledgements?.["@global"] === undefined
        ? null
        : element("span", {
            role: "status",
            children: controls.acknowledgements["@global"],
          }),
      queue["configuredLanes"] === null
        ? element("p", {
            class: "queue-source",
            children:
              "Global cap not set. The existing 16-run repository guard applies.",
          })
        : null,
      component(QueueOverLimit, { queue }),
      component(QueueSettingFeedback, {
        queue,
        controls: props.controls,
        eligible: queue["eligible"] === true,
      }),
      element("details", {
        class: "queue-more",
        children: [
          element("summary", { children: "More" }),
          component(QueueScopeAdvanced, { queue, controls }),
        ],
      }),
    ],
  });
}

export const queueSettingFunctions = [
  queueScopeKey,
  queueScopeValue,
  queueScopeChange,
  QueueStepper,
  QueueMeter,
  QueueSettingFeedback,
  QueueOverLimit,
  QueueInheritance,
  QueueReset,
  QueueScopeAdvanced,
  GlobalQueue,
];
