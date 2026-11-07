import type { Fields } from "../protocol.ts";
import type { DailyNumbers, KnownSpend } from "../report-days.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { counted, type WatchModel } from "./watch-render.ts";
import { wordText, type WatchWords } from "./watch-theme-view.ts";

export function dollars(value: number | null): string {
  return value === null ? "unknown" : `$${value.toFixed(2)}`;
}

export function spentText(spend: KnownSpend): string {
  const known = dollars(spend.costUsd);
  return spend.unknownCostRuns === 0 ? known : `at least ${known}`;
}

export function unknownCostText(spend: KnownSpend): string | undefined {
  if (spend.unknownCostRuns === 0) return undefined;
  return `${counted(spend.unknownCostRuns, "run")} with no cost`;
}

export function TodayNumber(props: {
  readonly value: string;
  readonly label: string;
  readonly yesterday?: string;
  readonly note?: string | undefined;
}): Shown {
  const { value, label, yesterday, note } = props;
  return element("div", {
    class: "today-number",
    children: [
      element("strong", { children: value }),
      element("span", { class: "today-label", children: label }),
      yesterday === undefined
        ? null
        : element("span", { class: "today-yesterday", children: yesterday }),
      note === undefined
        ? null
        : element("span", { class: "today-unknown", children: note }),
    ],
  });
}

export function TodayNumbers(props: { readonly today: DailyNumbers }): Shown {
  const { today } = props;
  return element("div", {
    class: "today-numbers",
    children: [
      component(TodayNumber, {
        value: String(today.completed),
        label: "runs completed",
        yesterday: `${String(today.yesterday.completed)} yesterday`,
      }),
      component(TodayNumber, {
        value: spentText(today),
        label: "spent",
        yesterday: `${spentText(today.yesterday)} yesterday`,
        note: unknownCostText(today),
      }),
      component(TodayNumber, {
        value:
          today.completed === 0 ? "-" : dollars(today.costPerCompletedRunUsd),
        label: "per completed run",
      }),
      component(TodayNumber, {
        value: String(today.stopped),
        label: "stopped",
      }),
    ],
  });
}

export function DayChart(props: {
  readonly days: DailyNumbers["days"];
}): Shown {
  const highest = Math.max(1, ...props.days.map((day) => day.completed));
  const days = props.days.map((day, index) => ({
    ...day,
    left: index * 40,
    height: Math.round((day.completed / highest) * 88),
    name: new Date(`${day.date}T00:00:00`).toLocaleDateString("en-US", {
      weekday: "short",
    }),
  }));
  return element("svg", {
    class: "today-chart",
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 280 132",
    role: "img",
    "aria-label": `Completed runs: ${days.map((day) => `${day.name} ${String(day.completed)}`).join(", ")}`,
    children: days.map((day, index) =>
      element("g", {
        key: day.date,
        class: index === days.length - 1 ? "today-bar current" : "today-bar",
        children: [
          element("rect", {
            x: String(day.left + 4),
            y: String(104 - day.height),
            width: "32",
            height: String(day.height),
          }),
          element("text", {
            class: "today-count",
            x: String(day.left + 20),
            y: String(98 - day.height),
            children: String(day.completed),
          }),
          element("text", {
            class: "today-day",
            x: String(day.left + 20),
            y: "124",
            children: day.name,
          }),
        ],
      }),
    ),
  });
}

export function WorkflowTable(props: {
  readonly workflows: DailyNumbers["workflows"];
}): Shown {
  return element("table", {
    class: "today-table",
    children: [
      element("thead", {
        children: element("tr", {
          children: ["Line", "Done", "Spent"].map((name) =>
            element("th", { scope: "col", children: name }),
          ),
        }),
      }),
      element("tbody", {
        children: props.workflows.map((row) =>
          element("tr", {
            key: row.workflowId,
            children: [
              element("th", { scope: "row", children: row.workflowId }),
              element("td", { children: String(row.completed) }),
              element("td", { children: spentText(row) }),
            ],
          }),
        ),
      }),
    ],
  });
}

export function LaneLine(props: { readonly queue: Fields | undefined }): Shown {
  const { state, busy, lanes } = props.queue ?? {};
  if (typeof busy !== "number" || typeof lanes !== "number") return null;
  const named = typeof state === "string" ? ` ${state}` : "";
  return element("p", {
    class: "today-queue",
    children: [
      element("span", {
        children: `Queue${named}, ${String(busy)} of ${String(lanes)} lanes busy`,
      }),
      element("span", {
        class: "lanes",
        "aria-hidden": "true",
        children: Array.from({ length: lanes }, (_, index) =>
          element("span", { class: index < busy ? "lane busy" : "lane free" }),
        ),
      }),
    ],
  });
}

export function Today(props: {
  readonly model: WatchModel;
  readonly words?: WatchWords | undefined;
}): Shown {
  const { today, queue } = props.model;
  if (today === undefined) return null;
  return element("section", {
    class: "today",
    "aria-labelledby": "today-title",
    children: [
      element("div", {
        class: "today-head",
        children: [
          element("h2", {
            id: "today-title",
            children: wordText(props.words, {
              key: "today.title",
              text: "Today",
            }),
          }),
          element("span", { class: "today-since", children: "since midnight" }),
        ],
      }),
      component(TodayNumbers, { today }),
      element("div", {
        class: "today-part",
        children: [
          element("h3", { children: "Last 7 days" }),
          component(DayChart, { days: today.days }),
        ],
      }),
      element("div", {
        class: "today-part",
        children: [
          element("h3", { children: "By line" }),
          component(WorkflowTable, { workflows: today.workflows }),
        ],
      }),
      component(LaneLine, { queue }),
    ],
  });
}
