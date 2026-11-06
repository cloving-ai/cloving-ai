import { record, type Fields } from "./protocol.ts";
import { checkSubmission, type SubmissionContract } from "./submission.ts";

export const weekdayNames = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdayNames)[number];

export interface IntervalTiming {
  readonly everySeconds: number;
}

export interface CalendarTiming {
  readonly at: string;
  readonly timeZone: string;
  readonly weekdays?: readonly Weekday[];
}

export type ScheduleTiming = IntervalTiming | CalendarTiming;

export type WorkflowSchedule = ScheduleTiming & { readonly input: Fields };

export type ScheduleCheck =
  | { readonly kind: "valid"; readonly schedule: WorkflowSchedule }
  | { readonly kind: "rejected"; readonly code: string };

type TimingCheck =
  | { readonly kind: "valid"; readonly timing: ScheduleTiming }
  | { readonly kind: "rejected"; readonly code: string };

const calendarKeys = ["at", "timeZone", "weekdays"];
const shapeRefusal = {
  kind: "rejected",
  code: "invalid-schedule-shape",
} as const;

interface ScheduleSource {
  readonly workflowId: string;
  readonly input: SubmissionContract;
  readonly schedule?: WorkflowSchedule;
}

export function parseSchedulesSetting(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    throw new Error("invalid-schedules");
  }
}

export function configuredSchedules(
  declarations: readonly ScheduleSource[],
  overrides: unknown,
): Readonly<Record<string, WorkflowSchedule>> {
  const settings = record(overrides);
  if (settings === undefined) throw new Error("invalid-schedules");
  if (
    Object.keys(settings).some(
      (id) => !declarations.some((entry) => entry.workflowId === id),
    )
  )
    throw new Error("unknown-schedule-workflow");
  const schedules: [string, WorkflowSchedule][] = [];
  for (const declaration of declarations) {
    const { workflowId } = declaration;
    const selected = Object.hasOwn(settings, workflowId)
      ? settings[workflowId]
      : declaration.schedule;
    if (selected === undefined && !Object.hasOwn(settings, workflowId))
      continue;
    const checked = checkWorkflowSchedule(declaration.input, selected);
    if (checked.kind === "rejected") throw new Error(checked.code);
    schedules.push([workflowId, checked.schedule]);
  }
  return Object.fromEntries(schedules);
}

function isWeekday(value: unknown): value is Weekday {
  return weekdayNames.some((name) => name === value);
}

function intervalTiming(seconds: unknown): TimingCheck {
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 60 ||
    seconds > 2592000
  )
    return { kind: "rejected", code: "invalid-schedule-interval" };
  return { kind: "valid", timing: { everySeconds: seconds } };
}

function localTime(value: unknown): value is string {
  return (
    typeof value === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)
  );
}

function weekdayList(value: unknown): value is readonly Weekday[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isWeekday) &&
    new Set(value).size === value.length
  );
}

function calendarTiming(fields: Fields): TimingCheck {
  const { at, timeZone, weekdays } = fields;
  if (
    Object.hasOwn(fields, "everySeconds") ||
    !localTime(at) ||
    typeof timeZone !== "string" ||
    timeZone === ""
  )
    return shapeRefusal;
  if (weekdays === undefined)
    return { kind: "valid", timing: { at, timeZone } };
  if (!weekdayList(weekdays)) return shapeRefusal;
  return {
    kind: "valid",
    timing: {
      at,
      timeZone,
      weekdays: weekdayNames.filter((name) => weekdays.includes(name)),
    },
  };
}

export function checkScheduleTiming(fields: Fields): TimingCheck {
  if (calendarKeys.some((key) => Object.hasOwn(fields, key)))
    return calendarTiming(fields);
  return intervalTiming(fields["everySeconds"]);
}

function unknownKey(fields: Fields, timing: ScheduleTiming): boolean {
  const known = "everySeconds" in timing ? ["everySeconds"] : calendarKeys;
  return Object.keys(fields).some(
    (key) => key !== "input" && !known.includes(key),
  );
}

export function checkWorkflowSchedule(
  contract: SubmissionContract,
  value: unknown,
): ScheduleCheck {
  const fields = record(value);
  if (fields === undefined)
    return { kind: "rejected", code: "invalid-schedule-interval" };
  const timing = checkScheduleTiming(fields);
  if (timing.kind === "rejected") return timing;
  if (unknownKey(fields, timing.timing))
    return "everySeconds" in timing.timing
      ? { kind: "rejected", code: "invalid-schedule-interval" }
      : shapeRefusal;
  const checked = checkSubmission(contract, {
    workflowId: "schedule",
    source: "declared",
    submission: fields["input"],
  });
  if (checked.kind === "rejected")
    return { kind: "rejected", code: "invalid-schedule-input" };
  return {
    kind: "valid",
    schedule: { ...timing.timing, input: checked.submission },
  };
}
