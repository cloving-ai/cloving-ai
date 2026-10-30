import { queueSpendLines } from "./usage-render.ts";
import { record } from "../protocol.ts";
import { PhonePanel, type PhoneControls } from "./watch-phone-view.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { clockTime, counted, type WatchModel } from "./watch-render.ts";

export interface StartControls {
  readonly shown: boolean;
  readonly onToggle: () => void;
}

export interface HeaderProps {
  readonly model: WatchModel | null;
  readonly stale: boolean;
  readonly start?: StartControls;
  readonly phone?: PhoneControls | undefined;
  readonly now?: string;
}

export const clove = {
  viewBox:
    "0.6625858545303345 0.6630800366401672 46.674827575683594 46.673831939697266",
  paths: [
    "M41.47315,11.48535c-1.20117-0.12305-2.16211-1.08398-2.28418-2.28516c-0.17676-1.7334-1.01758-3.29492-2.36865-4.39648s-3.05078-1.61719-4.7832-1.43359c-3.34277,0.34082-5.86377,3.13086-5.86377,6.49121v14.13867c0,0.27637,0.22363,0.5,0.5,0.5H40.8125c3.59766,0,6.52441-2.92676,6.52441-6.52441C47.33692,14.61523,44.81592,11.82422,41.47315,11.48535z M35.56543,15.81543l-5.85791,5.85742c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648c-0.19531-0.19531-0.19531-0.51172,0-0.70703l5.85791-5.85742c0.19531-0.19531,0.51172-0.19531,0.70703,0C35.76073,15.30372,35.76074,15.62011,35.56543,15.81543z",
    "M15.30225,0.66308c-3.36035,0-6.15088,2.52051-6.49121,5.86328C8.68897,7.72852,7.72852,8.68945,6.52686,8.81152c-1.7334,0.17578-3.29492,1.01758-4.396,2.36816s-1.61035,3.0498-1.43408,4.7832c0.34033,3.34277,3.13086,5.86328,6.49121,5.86328h14.13867c0.27637,0,0.5-0.22363,0.5-0.5V7.18751C21.82666,3.58984,18.8999,0.66308,15.30225,0.66308z M18.99951,19.00001c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648l-5.85742-5.8584c-0.19531-0.19531-0.19531-0.51172,0-0.70703c0.19531-0.19531,0.51172-0.19531,0.70703,0l5.85742,5.8584C19.19482,18.48829,19.19482,18.80469,18.99951,19.00001z",
    "M24,26.17383H9.86133c-3.59766,0-6.52441,2.92676-6.52441,6.52441c0,3.35938,2.52051,6.14941,5.86377,6.49023c1.20117,0.12207,2.16211,1.08301,2.28418,2.28418c0.17676,1.7334,1.01758,3.29492,2.36865,4.39648c1.17529,0.95801,2.61377,1.46777,4.11035,1.46777c0.22314,0,0.44775-0.01074,0.67285-0.03418C21.97949,46.96189,24.5,44.17186,24.5,40.81248V26.67383C24.5,26.39746,24.27637,26.17383,24,26.17383z M21.67334,29.70704l-5.85791,5.8584c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648c-0.19531-0.19531-0.19531-0.51172,0-0.70703L20.9663,29c0.19531-0.19531,0.51172-0.19531,0.70703,0S21.86865,29.51172,21.67334,29.70704z",
    "M47.30322,32.03711c-0.34033-3.34277-3.13086-5.86328-6.49072-5.86328H26.67334c-0.27637,0-0.5,0.22363-0.5,0.5V40.8125c0,3.59766,2.92676,6.52441,6.52442,6.52441c3.36035,0,6.15088-2.52148,6.49121-5.86426c0.12207-1.20117,1.08301-2.16211,2.28418-2.28418c1.7334-0.17578,3.29492-1.01758,4.396-2.36816S47.47949,33.7705,47.30322,32.03711z M35.56543,35.56543c-0.09766,0.09766-0.22559,0.14648-0.35352,0.14648s-0.25586-0.04883-0.35352-0.14648l-5.85791-5.8584c-0.19531-0.19531-0.19531-0.51172,0-0.70703s0.51172-0.19531,0.70703,0l5.85791,5.8584C35.76074,35.05371,35.76074,35.37011,35.56543,35.56543z",
  ],
};

export function queueLanes(model: WatchModel): string | null {
  const queue = model.queue;
  if (queue === undefined) return null;
  return `Queue: ${String(queue["busy"])} of ${String(queue["lanes"])} lanes busy`;
}

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

export function Queue(props: { readonly model: WatchModel }): Shown {
  const skipped = props.model.queue?.["skipped"];
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  return element("details", {
    class: "queue-waiting",
    children: [
      element("summary", {
        children: `${counted(skipped.length, "ticket")} skipped`,
      }),
      element("ul", {
        children: skipped.map((value) =>
          element("li", { children: skippedText(value) }),
        ),
      }),
    ],
  });
}

export function Brand(): Shown {
  return element("strong", {
    class: "brand",
    children: [
      element("svg", {
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
        focusable: "false",
        viewBox: clove.viewBox,
        children: clove.paths.map((d) =>
          element("path", { fill: "currentColor", d }),
        ),
      }),
      "cloving",
    ],
  });
}

export function HeaderStatus(props: HeaderProps): Shown {
  const { model, stale } = props;
  const updated = model === null ? "" : `updated ${clockTime(model.updatedAt)}`;
  const stamp = stale
    ? element("span", {
        class: "bad",
        children: "The watch tool does not answer.",
      })
    : element("span", { children: updated });
  const lanes = model === null ? null : queueLanes(model);
  return element("div", {
    class: "header-status",
    children: [
      stamp,
      ...queueSpendLines(model?.queue?.["spend"]).map((line) =>
        element("span", { class: "queue-spend", children: line }),
      ),
      lanes === null
        ? null
        : element("span", { class: "queue-lanes", children: lanes }),
    ],
  });
}

export function HeaderActions(props: HeaderProps): Shown {
  const { start, phone } = props;
  if (start === undefined && phone === undefined) return null;
  return element("div", {
    class: "header-actions",
    children: [
      start === undefined
        ? null
        : element("button", {
            type: "button",
            class: "start-toggle",
            "aria-controls": "start-run",
            "aria-expanded": String(start.shown),
            onClick: start.onToggle,
            children: "Start a run",
          }),
      phone === undefined
        ? null
        : component(PhonePanel, {
            phone,
            now: props.now ?? props.model?.updatedAt ?? "",
          }),
    ],
  });
}

export function Header(props: HeaderProps): Shown {
  return element("header", {
    children: [
      component(Brand, {}),
      component(HeaderStatus, props),
      component(HeaderActions, props),
    ],
  });
}
