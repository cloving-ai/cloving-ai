import { element, type Shown } from "./watch-element.ts";
import type { CommandWaitView } from "../authority/command-wait-view.ts";
import { record } from "../protocol.ts";

function waitTime(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function shownCommandWaits(value: unknown): readonly CommandWaitView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const fields = record(entry);
    if (
      typeof fields?.["name"] !== "string" ||
      typeof fields["command"] !== "string" ||
      typeof fields["state"] !== "string" ||
      typeof fields["maximumWaitSeconds"] !== "number" ||
      typeof fields["remainingSeconds"] !== "number" ||
      typeof fields["checkCount"] !== "number"
    )
      return [];
    return [
      {
        name: fields["name"],
        command: fields["command"],
        state: fields["state"],
        maximumWaitSeconds: fields["maximumWaitSeconds"],
        remainingSeconds: fields["remainingSeconds"],
        checkCount: fields["checkCount"],
        startedAt: waitTime(fields["startedAt"]),
        deadline: waitTime(fields["deadline"]),
        nextCheckAt: waitTime(fields["nextCheckAt"]),
        reason: waitTime(fields["reason"]),
      },
    ];
  });
}

export function commandWaitText(wait: CommandWaitView): string {
  const reason = wait.reason === null ? "" : ` · ${wait.reason}`;
  return `Command wait ${wait.name} · ${wait.command} · ${wait.state} · ${String(wait.remainingSeconds)} s left · deadline ${wait.deadline ?? "none"} · next check ${wait.nextCheckAt ?? "none"} · checks ${String(wait.checkCount)}${reason}`;
}

export function CommandWaits(props: {
  readonly waits: readonly CommandWaitView[];
}): Shown {
  return props.waits.map((wait) =>
    element("p", {
      class: "meta command-wait",
      children: commandWaitText(wait),
    }),
  );
}

export function effectBudgetText(
  spent: number | null | undefined,
  limit: number | null | undefined,
): string {
  return spent == null || limit == null
    ? ""
    : `${String(spent)} of ${String(limit)} effect units`;
}

export function activeCommandWait(waits: readonly CommandWaitView[]): boolean {
  return waits.some((wait) => wait.state === "waiting");
}
