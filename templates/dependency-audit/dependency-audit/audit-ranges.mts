interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

interface Bound {
  readonly version: string;
  readonly inclusive: boolean;
}

interface Interval {
  readonly lower: Bound | null;
  readonly upper: Bound | null;
}

const versionPattern =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsed(version: string): Version | undefined {
  const match = versionPattern.exec(version);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function identifierOrder(left: string, right: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right))
    return Math.sign(Number(left) - Number(right));
  if (numeric.test(left) !== numeric.test(right))
    return numeric.test(left) ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function prereleaseOrder(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0)
    return Math.sign(right.length - left.length);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left.at(index);
    const other = right.at(index);
    if (one === undefined || other === undefined)
      return one === undefined ? -1 : 1;
    const order = identifierOrder(one, other);
    if (order !== 0) return order;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number {
  const one = parsed(left);
  const other = parsed(right);
  if (one === undefined || other === undefined)
    throw new Error(`Not a version: ${one === undefined ? left : right}`);
  return (
    Math.sign(one.major - other.major) ||
    Math.sign(one.minor - other.minor) ||
    Math.sign(one.patch - other.patch) ||
    prereleaseOrder(one.prerelease, other.prerelease)
  );
}

function tighter(
  current: Bound | null,
  next: { readonly bound: Bound; readonly direction: 1 | -1 },
): Bound {
  if (current === null) return next.bound;
  const order =
    compareVersions(next.bound.version, current.version) * next.direction;
  if (order !== 0) return order > 0 ? next.bound : current;
  return next.bound.inclusive ? current : next.bound;
}

function comparators(text: string): readonly string[] {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen !== null)
    return [`>=${String(hyphen[1])}`, `<=${String(hyphen[2])}`];
  const collapsed = text.replace(/([<>]=?|=)\s+/g, "$1").trim();
  return collapsed === "" || collapsed === "*" ? [] : collapsed.split(/\s+/);
}

function comparatorSet(text: string): Interval | undefined {
  let lower: Bound | null = null;
  let upper: Bound | null = null;
  for (const comparator of comparators(text)) {
    const version = comparator.replace(/^[<>]?=?/, "");
    const operator =
      comparator.slice(0, comparator.length - version.length) || "=";
    if (parsed(version) === undefined) return undefined;
    const inclusive = operator !== "<" && operator !== ">";
    if (operator !== "<" && operator !== "<=")
      lower = tighter(lower, { bound: { version, inclusive }, direction: 1 });
    if (operator !== ">" && operator !== ">=")
      upper = tighter(upper, { bound: { version, inclusive }, direction: -1 });
  }
  return { lower, upper };
}

function intervals(range: string): readonly Interval[] | undefined {
  const sets: Interval[] = [];
  for (const text of range.split("||")) {
    const set = comparatorSet(text.trim());
    if (set === undefined) return undefined;
    if (opened({ from: set.lower, until: set.upper })) sets.push(set);
  }
  return sets;
}

function opened(gap: {
  readonly from: Bound | null;
  readonly until: Bound | null;
}): boolean {
  if (gap.from === null || gap.until === null) return true;
  const order = compareVersions(gap.from.version, gap.until.version);
  if (order !== 0) return order < 0;
  return gap.from.inclusive && gap.until.inclusive;
}

function flipped(bound: Bound): Bound {
  return { version: bound.version, inclusive: !bound.inclusive };
}

function lowerOrder(left: Interval, right: Interval): number {
  if (left.lower === null || right.lower === null)
    return Number(left.lower !== null) - Number(right.lower !== null);
  return (
    compareVersions(left.lower.version, right.lower.version) ||
    Number(!left.lower.inclusive) - Number(!right.lower.inclusive)
  );
}

function gapText(gap: {
  readonly from: Bound | null;
  readonly until: Bound | null;
}): string {
  const parts = [
    gap.from === null
      ? ""
      : `${gap.from.inclusive ? ">=" : ">"}${gap.from.version}`,
    gap.until === null
      ? ""
      : `${gap.until.inclusive ? "<=" : "<"}${gap.until.version}`,
  ].filter((part) => part !== "");
  return parts.length === 0 ? "*" : parts.join(" ");
}

export function patchedRange(range: string): string | null {
  const vulnerable = intervals(range);
  if (vulnerable === undefined) return null;
  const gaps: string[] = [];
  let from: Bound | null = null;
  for (const interval of vulnerable.toSorted(lowerOrder)) {
    const until = interval.lower === null ? null : flipped(interval.lower);
    if (until !== null && opened({ from, until }))
      gaps.push(gapText({ from, until }));
    if (interval.upper === null)
      return gaps.length === 0 ? null : gaps.join(" || ");
    from = tighter(from, { bound: flipped(interval.upper), direction: 1 });
  }
  gaps.push(gapText({ from, until: null }));
  return gaps.join(" || ");
}

export function inRange(version: string, range: string): boolean | undefined {
  const vulnerable = intervals(range);
  if (vulnerable === undefined || parsed(version) === undefined)
    return undefined;
  const point = { version, inclusive: true };
  return vulnerable.some(
    (interval) =>
      opened({ from: interval.lower, until: point }) &&
      opened({ from: point, until: interval.upper }),
  );
}
