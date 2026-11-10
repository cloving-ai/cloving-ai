import type { ShownSchedule } from "./schedule-render.ts";
import { component, element, type Shown } from "./watch-element.ts";
import type { WatchLoop } from "./watch-loops.ts";
import { LoopCell, type LoopControls } from "./watch-loops-view.ts";
import type { WatchWorkflow } from "./watch-render.ts";

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

export interface LineLoop {
  readonly loop?: WatchLoop | undefined;
  readonly looping?: LoopControls | undefined;
}

export function LineNext(
  props: LineLoop & { readonly workflow: WatchWorkflow; readonly now: string },
): Shown {
  const { workflow, now, loop } = props;
  const next = nextRunText(workflow.schedule, now);
  if (loop !== undefined)
    return component(LoopCell, {
      loop,
      next: loop.state === "active" ? next : "",
      now,
      controls: props.looping,
    });
  return next === ""
    ? null
    : element("span", { class: "line-next", children: next });
}
