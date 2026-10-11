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
