import { operationScope } from "../operation-identity.ts";

export interface RunOrigin {
  readonly parentRunId: string | null;
  readonly chainId: string;
  readonly continuedFrom?: string;
}

export type RunOrigins = Readonly<Record<string, RunOrigin>>;

export interface RunLinks extends RunOrigin {
  readonly childRunIds: readonly string[];
  readonly continuedBy?: string;
}

function continuationLinks(
  run: Partial<RunLinks>,
): Pick<RunLinks, "continuedFrom" | "continuedBy"> {
  return {
    ...(run.continuedFrom === undefined
      ? {}
      : { continuedFrom: run.continuedFrom }),
    ...(run.continuedBy === undefined ? {} : { continuedBy: run.continuedBy }),
  };
}

export function linksOf(
  run: { readonly runId: string } & Partial<RunLinks>,
): RunLinks {
  return {
    parentRunId: run.parentRunId ?? null,
    chainId: run.chainId ?? run.runId,
    childRunIds: run.childRunIds ?? [],
    ...continuationLinks(run),
  };
}

export function runLinks(
  origins: RunOrigins,
): Readonly<Record<string, RunLinks>> {
  const children = childRuns(origins);
  const continuations: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(origins).flatMap(([runId, origin]) =>
      origin.continuedFrom === undefined ? [] : [[origin.continuedFrom, runId]],
    ),
  );
  return Object.fromEntries(
    Object.entries(origins).map(([runId, origin]) => [
      runId,
      {
        ...origin,
        childRunIds: children[runId] ?? [],
        ...(continuations[runId] === undefined
          ? {}
          : { continuedBy: continuations[runId] }),
      },
    ]),
  );
}

export function childRuns(
  origins: RunOrigins,
): Readonly<Record<string, readonly string[]>> {
  const children: Record<string, string[]> = {};
  for (const [runId, origin] of Object.entries(origins)) {
    if (origin.parentRunId === null) continue;
    const siblings = children[origin.parentRunId] ?? [];
    siblings.push(runId);
    children[origin.parentRunId] = siblings;
  }
  return children;
}

export type HandoffChain =
  | { readonly kind: "root" }
  | {
      readonly kind: "handoff";
      readonly parentRunId: string;
      readonly chainId: string;
    }
  | { readonly kind: "refused"; readonly reason: string };

export function handoffChain(
  commandId: string,
  origins: RunOrigins,
): HandoffChain {
  if (!commandId.startsWith("handoff:")) return { kind: "root" };
  const parentRunId = operationScope(commandId.slice(8))?.run;
  const parent = parentRunId === undefined ? undefined : origins[parentRunId];
  if (parent === undefined || parentRunId === undefined)
    return { kind: "refused", reason: "unknown-handoff-parent" };
  let current: RunOrigin | undefined = parent;
  for (let length = 1; current !== undefined; length += 1) {
    if (length >= 5) return { kind: "refused", reason: "chain-limit" };
    if (current.parentRunId === null)
      return { kind: "handoff", parentRunId, chainId: parent.chainId };
    current = origins[current.parentRunId];
  }
  return { kind: "refused", reason: "unknown-handoff-parent" };
}

export function chainRefusal(
  commandId: string,
  target: { readonly runId: string; readonly origins: RunOrigins },
): string | undefined {
  if (!commandId.startsWith("continue:")) return undefined;
  const requester = operationScope(commandId.slice(9))?.run;
  const chainId =
    requester === undefined ? undefined : target.origins[requester]?.chainId;
  return chainId !== undefined &&
    target.origins[target.runId]?.chainId === chainId
    ? undefined
    : "continuation-outside-chain";
}
