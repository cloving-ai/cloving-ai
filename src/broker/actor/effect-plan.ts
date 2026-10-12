import { isInstant } from "../../authority/instants.ts";
import { promotions } from "../../authority/leases.ts";
import type { Operation } from "../../authority/operations.ts";
import { execute, type AuthorityState } from "../../authority/reducer.ts";
import { documentDigest } from "../decision-restore.ts";
import { operationDigest } from "../operation-digest.ts";
import type { EffectSettings } from "./authority-settings.ts";
import { protectedIntent, type DeliveryIntent } from "./delivery-intents.ts";
import type { Accepted } from "./turn-draft.ts";

export interface Step {
  readonly result: Accepted;
  readonly before: AuthorityState;
}

export interface Promotion {
  readonly recordedAt: string;
  readonly effects: EffectSettings;
}

type Fields = Readonly<Record<string, unknown>>;

function leaseGrant(
  state: AuthorityState,
  grant: Promotion & { readonly operation: Operation },
): Fields {
  const { operation, recordedAt, effects } = grant;
  const generation =
    (state.effects.leases[operation.leaseKey]?.generation ?? 0) + 1;
  return {
    kind: "grant-lease",
    commandId: `lease:${operationDigest(operation.operationId)}:${String(generation)}`,
    runId: operation.runId,
    operationId: operation.operationId,
    leaseGeneration: generation,
    expiresAt: new Date(
      Date.parse(recordedAt) + effects.leaseMilliseconds,
    ).toISOString(),
    capacity: effects.capacity,
  };
}

function recordedStep(
  before: AuthorityState,
  proposed: { readonly command: Fields; readonly recordedAt: string },
): readonly Step[] {
  return [execute(before, proposed)]
    .filter((result) => result.kind === "accepted")
    .map((result) => ({ result, before }));
}

function granted(
  before: AuthorityState,
  grant: Promotion & { readonly operation: Operation },
): readonly Step[] {
  return recordedStep(before, {
    command: leaseGrant(before, grant),
    recordedAt: grant.recordedAt,
  });
}

export function promoted(
  state: AuthorityState,
  promotion: Promotion,
): readonly Step[] {
  if (!isInstant(promotion.recordedAt)) return [];
  const steps: Step[] = [];
  for (const operation of promotions(state, promotion.effects.capacity))
    steps.push(
      ...granted(steps.at(-1)?.result.state ?? state, {
        ...promotion,
        operation,
      }),
    );
  return steps;
}

const terminal = ["completed", "failed", "cancelled"];

function closure(
  state: AuthorityState,
  operation: Operation,
): readonly string[] {
  if (terminal.includes(state.runs[operation.runId]?.status ?? ""))
    return ["run-ended"];
  const exhausted =
    (state.effects.budgets[operation.runId]?.exhaustedSequence ?? null) !==
    null;
  return exhausted ? ["budget-exhausted"] : [];
}

export interface FollowUp extends Promotion {
  readonly blocked: ReadonlyMap<string, string>;
}

function unblocked(state: AuthorityState, followUp: FollowUp): readonly Step[] {
  const steps: Step[] = [];
  for (const [operationId, effectId] of followUp.blocked) {
    const before = steps.at(-1)?.result.state ?? state;
    const pending = Object.values(before.effects.operations).filter(
      (operation) =>
        operation.operationId === operationId &&
        operation.status === "dispatch-pending" &&
        operation.receipt === null,
    );
    for (const operation of pending)
      for (const reason of closure(before, operation))
        steps.push(
          ...recordedStep(before, {
            command: {
              kind: "record-outcome",
              commandId: `outcome:${effectId}`,
              runId: operation.runId,
              operationId,
              leaseGeneration:
                before.effects.leases[operation.leaseKey]?.generation ?? 0,
              outcome: "not-started",
              reason,
            },
            recordedAt: followUp.recordedAt,
          }),
        );
  }
  return steps;
}

export function followUps(
  state: AuthorityState,
  followUp: FollowUp,
): readonly Step[] {
  const settled = unblocked(state, followUp);
  return [
    ...settled,
    ...promoted(settled.at(-1)?.result.state ?? state, followUp),
  ];
}

export interface ClosedAttempt {
  readonly effectId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly leaseGeneration: number | null;
  readonly purpose: string;
  readonly outcome: string;
  readonly receipt: string | null;
  readonly worker: string | null;
  readonly result: string | null;
  readonly reason: string | null;
  readonly storedReceipt: string | null;
}

function stated(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  );
}

type Outcome = (attempt: ClosedAttempt) => Fields | undefined;

function identified(attempt: ClosedAttempt): Fields {
  return { receipt: attempt.receipt, worker: attempt.worker };
}

function unknown(reason: string): Fields {
  return { outcome: "unknown", reason };
}

const outcomes: Readonly<Record<string, Outcome>> = {
  accepted: (attempt) => ({
    outcome: "accepted",
    receipt: attempt.receipt,
    worker: attempt.worker,
  }),
  completed: (attempt) =>
    stated({
      outcome: "completed",
      result: attempt.result === null ? null : documentDigest(attempt.result),
      reason: attempt.reason,
      ...identified(attempt),
    }),
  failed: (attempt) =>
    stated({
      outcome: "failed",
      reason: attempt.reason,
      ...identified(attempt),
    }),
  stopped: (attempt) => stated({ outcome: "stopped", ...identified(attempt) }),
  unknown: (attempt) => unknown(attempt.reason ?? "adapter-unknown"),
  thrown: () => unknown("handler-failure"),
  "stale-epoch": () => unknown("stale-epoch"),
  absent: (attempt) =>
    attempt.storedReceipt === null
      ? { outcome: "not-started", reason: "absent" }
      : unknown("absent-with-receipt"),
  withheld: (attempt) =>
    attempt.purpose === "dispatch"
      ? { outcome: "not-started", reason: "withheld" }
      : undefined,
  refused: () => ({ outcome: "not-started", reason: "budget-exhausted" }),
};

export function outcomeCommand(attempt: ClosedAttempt): Fields | undefined {
  const fields = outcomes[attempt.outcome]?.(attempt);
  if (fields === undefined) return undefined;
  return {
    kind: "record-outcome",
    commandId: `outcome:${attempt.effectId}`,
    runId: attempt.runId,
    operationId: attempt.operationId,
    leaseGeneration: attempt.leaseGeneration,
    ...fields,
  };
}

export function resultDocuments(
  attempt: Pick<ClosedAttempt, "outcome" | "result">,
): readonly Fields[] {
  if (attempt.outcome !== "completed" || attempt.result === null) return [];
  return [{ digest: documentDigest(attempt.result), body: attempt.result }];
}

export interface Reconciling {
  readonly results: readonly Accepted[];
  readonly closed: readonly string[];
  readonly open: ReadonlySet<string>;
}

function named(reconciling: Reconciling): readonly string[] {
  const operations = reconciling.results.flatMap((result) =>
    result.events.flatMap((event) => event.payload["operationId"] ?? []),
  );
  return [...new Set([...operations, ...reconciling.closed])];
}

export function rejectedReports(
  results: readonly Accepted[],
): ReadonlySet<string> {
  return new Set(
    results
      .filter(
        (result) =>
          result.events.some((event) => event.type === "effect.reported") &&
          result.disposition?.disposition === "rejected",
      )
      .flatMap((result) => result.disposition?.operationId ?? []),
  );
}

function acceptedNow(reconciling: Reconciling): ReadonlySet<string> {
  return new Set(
    reconciling.results.flatMap((result) =>
      result.events
        .filter(
          (event) =>
            event.type === "operation.reconciled" &&
            event.payload["outcome"] === "accepted",
        )
        .flatMap((event) => event.payload["operationId"] ?? []),
    ),
  );
}

export function reconciliations(
  state: AuthorityState,
  reconciling: Reconciling,
): readonly DeliveryIntent[] {
  const accepted = acceptedNow(reconciling);
  const rejected = rejectedReports(reconciling.results);
  const due = (operation: Operation): boolean =>
    state.runs[operation.runId]?.status !== "cancelled" && live(operation);
  const live = (operation: Operation): boolean =>
    (operation.status === "recovering" &&
      !accepted.has(operation.operationId)) ||
    (operation.status === "blocked" && rejected.has(operation.operationId));
  return named(reconciling)
    .filter((operationId) => !reconciling.open.has(operationId))
    .flatMap((operationId) =>
      Object.values(state.effects.operations).filter(
        (operation) => operation.operationId === operationId && due(operation),
      ),
    )
    .flatMap((operation) =>
      protectedIntent(state, {
        intent: {
          kind: "protected-effect",
          runId: operation.runId,
          operationId: operation.operationId,
        },
        purpose: "reconcile",
      }),
    );
}
