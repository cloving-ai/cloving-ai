export const threadPoolStallExitCode = 70;

export interface ThreadPoolCheck {
  readonly result: "ok" | "stalled";
  readonly checkedAt: string;
  readonly milliseconds: number;
  readonly resources?: Readonly<Record<string, number>>;
}

export interface StalledCheck extends ThreadPoolCheck {
  readonly result: "stalled";
  readonly resources: Readonly<Record<string, number>>;
}

export function stalledLine(check: StalledCheck): string {
  const resources = Object.entries(check.resources)
    .toSorted(([first], [second]) => (first < second ? -1 : 1))
    .map(([name, count]) => `${name}:${String(count)}`)
    .join(",");
  return `threadpool-stalled ms=${String(check.milliseconds)} resources=${resources}\n`;
}
