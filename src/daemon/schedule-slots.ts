import {
  weekdayNames,
  type CalendarTiming,
  type ScheduleTiming,
} from "../workflow-schedule.ts";

const dayMilliseconds = 86400000;

function wallClock(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
}

function offset(timeZone: string, instant: number): number {
  return wallClock(timeZone, instant) - Math.floor(instant / 1000) * 1000;
}

function gapEnd(
  timeZone: string,
  range: { readonly wall: number; readonly low: number; readonly high: number },
): number {
  let { low, high } = range;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (wallClock(timeZone, middle) > range.wall) high = middle;
    else low = middle;
  }
  return high;
}

function localInstant(timeZone: string, wall: number): number {
  const before = offset(timeZone, wall - dayMilliseconds);
  const later = offset(timeZone, wall + dayMilliseconds);
  const matches = [wall - before, wall - later].filter(
    (instant) => wallClock(timeZone, instant) === wall,
  );
  if (matches.length > 0) return Math.min(...matches);
  return gapEnd(timeZone, { wall, low: wall - later, high: wall - before });
}

export function nextCalendarSlot(
  timing: CalendarTiming,
  after: number,
): number {
  const [hours = 0, minutes = 0] = timing.at.split(":").map(Number);
  const today = wallClock(timing.timeZone, after);
  const midnight = today - (today % dayMilliseconds);
  for (let index = 0; index <= 7; index += 1) {
    const day = midnight + index * dayMilliseconds;
    const position = (new Date(day).getUTCDay() + 6) % 7;
    if (
      timing.weekdays?.some(
        (name) => weekdayNames.indexOf(name) === position,
      ) === false
    )
      continue;
    const wall = day + (hours * 60 + minutes) * 60000;
    const instant = localInstant(timing.timeZone, wall);
    if (instant > after) return instant;
  }
  throw new Error("calendar-slot-not-found");
}

function zoneFormat(timeZone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return undefined;
  }
}

export function knownTimeZone(name: string): boolean {
  return /^[A-Za-z]/.test(name) && zoneFormat(name) !== undefined;
}

export function localStamp(timeZone: string, instant: number): string {
  const wall = wallClock(timeZone, instant);
  const minutes = Math.round((wall - instant) / 60000);
  const size = Math.abs(minutes);
  const hours = String(Math.floor(size / 60)).padStart(2, "0");
  const rest = String(size % 60).padStart(2, "0");
  const sign = minutes < 0 ? "-" : "+";
  return `${new Date(wall).toISOString().slice(0, 19)}${sign}${hours}:${rest}`;
}

export function firstSlot(timing: ScheduleTiming, now: number): number {
  return "everySeconds" in timing
    ? now + timing.everySeconds * 1000
    : nextCalendarSlot(timing, now);
}

export function dueSlot(
  timing: ScheduleTiming,
  slot: {
    readonly lastSlot: number;
    readonly nextAt: number;
    readonly now: number;
  },
): { readonly lastSlot: number; readonly nextAt: number } {
  if (!("everySeconds" in timing))
    return {
      lastSlot: slot.lastSlot + 1,
      nextAt: nextCalendarSlot(timing, slot.now),
    };
  const interval = timing.everySeconds * 1000;
  const elapsed = Math.floor((slot.now - slot.nextAt) / interval) + 1;
  return {
    lastSlot: slot.lastSlot + elapsed,
    nextAt: slot.nextAt + elapsed * interval,
  };
}
