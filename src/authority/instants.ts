const instant =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/;

function leap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysIn(year: number, month: number): number {
  if (month === 2) return leap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

type Bound = readonly [value: number, minimum: number, maximum: number];

function calendar(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const bounds: readonly Bound[] = [
    [month, 1, 12],
    [Number(match[3]), 1, daysIn(year, month)],
    [Number(match[4]), 0, 23],
    [Number(match[5]), 0, 59],
    [Number(match[6]), 0, 59],
  ];
  return bounds.every(
    ([value, minimum, maximum]) => value >= minimum && value <= maximum,
  );
}

export function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = instant.exec(value);
  return match !== null && calendar(match);
}

function milliseconds(value: string): string {
  return value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
}

export function notBefore(value: string, bound: string): boolean {
  return (
    isInstant(value) &&
    isInstant(bound) &&
    milliseconds(value) >= milliseconds(bound)
  );
}

export function isAfter(value: string, bound: string): boolean {
  return notBefore(value, bound) && !notBefore(bound, value);
}

function leapDaysBefore(year: number): number {
  const previous = year - 1;
  return (
    Math.floor(previous / 4) -
    Math.floor(previous / 100) +
    Math.floor(previous / 400)
  );
}

export function instantMilliseconds(value: string): number {
  if (!isInstant(value)) throw new Error("invalid-instant");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  let days = Number(value.slice(8, 10)) - 1;
  for (let preceding = 1; preceding < month; preceding += 1)
    days += daysIn(year, preceding);
  days += 365 * (year - 1970) + leapDaysBefore(year) - leapDaysBefore(1970);
  return (
    days * 86_400_000 +
    Number(value.slice(11, 13)) * 3_600_000 +
    Number(value.slice(14, 16)) * 60_000 +
    Number(value.slice(17, 19)) * 1000 +
    Number(value.slice(20, 23))
  );
}
