import { createHash } from "node:crypto";
import type { Observation, RunDetails } from "../authority/details.ts";
import { delivers, gateKey, type GateState } from "../authority/gates.ts";
import type { AuthorityState } from "../authority/reducer.ts";
import { gateDelivery } from "../authority/reduction.ts";
import type {
  DecisionRows,
  DetailRow,
  DocumentRow,
  GateRow,
} from "../storage/decision-rows.ts";

export type DecisionState = Pick<
  AuthorityState,
  "gates" | "details" | "questions"
>;

const kinds = ["question", "approval", "untyped"] as const;
const waits = ["registered", "pending", "hook"] as const;

export function documentDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function gateRecord(gate: GateState): GateRow {
  return {
    runId: gate.runId,
    gateId: gate.gateId,
    kind: gate.kind,
    label: gate.label,
    subject: gate.subject,
    prompt: gate.prompt,
    expiresAt: gate.expiresAt,
    generation: gate.generation,
    revision: gate.revision,
    wait: gate.wait,
    decision: gate.outcome?.decision ?? null,
    answer: gate.outcome?.answer ?? null,
    decidedSequence: gate.outcome?.sequence ?? null,
    openedSequence: gate.openedSequence,
    continuation: delivers(gate) ? gateDelivery(gate).operationId : null,
  };
}

type ObservationColumns = Pick<
  DetailRow,
  | "condition"
  | "reason"
  | "evidence"
  | "retryAt"
  | "attempt"
  | "attemptLimit"
  | "observedSequence"
  | "observedAt"
  | "observedOperation"
>;

const unobserved: ObservationColumns = {
  condition: null,
  reason: null,
  evidence: null,
  retryAt: null,
  attempt: null,
  attemptLimit: null,
  observedSequence: null,
  observedAt: null,
  observedOperation: null,
};

function observationColumns(
  observation: Observation | null,
): ObservationColumns {
  if (observation === null) return unobserved;
  return {
    condition: observation.condition,
    reason: observation.reason,
    evidence: observation.evidence,
    retryAt: observation.retryAt,
    attempt: observation.attempt,
    attemptLimit: observation.limit,
    observedSequence: observation.sequence,
    observedAt: observation.recordedAt,
    observedOperation: observation.operationId,
  };
}

export function detailRecord(details: RunDetails): DetailRow {
  return {
    runId: details.runId,
    generation: details.generation,
    submission: details.submission,
    input: details.input,
    resolver: details.resolver,
    ...observationColumns(details.observation),
  };
}

export function storedGate(row: GateRow): GateState {
  const kind = kinds.find((candidate) => candidate === row.kind);
  const wait = waits.find((candidate) => candidate === row.wait);
  if (!kind || !wait) throw new Error("invalid-gate-row");
  const { decidedSequence } = row;
  return {
    runId: row.runId,
    gateId: row.gateId,
    kind,
    label: row.label,
    subject: row.subject,
    prompt: row.prompt,
    expiresAt: row.expiresAt,
    generation: row.generation,
    revision: row.revision,
    wait,
    outcome:
      decidedSequence === null
        ? null
        : {
            decision: row.decision,
            answer: row.answer,
            sequence: decidedSequence,
          },
    openedSequence: row.openedSequence,
  };
}

function storedObservation(row: DetailRow): Observation | null {
  const { condition, reason, observedSequence, observedAt } = row;
  if (
    condition === null ||
    reason === null ||
    observedSequence === null ||
    observedAt === null
  )
    return null;
  return {
    condition,
    reason,
    evidence: row.evidence,
    retryAt: row.retryAt,
    operationId: row.observedOperation,
    attempt: row.attempt,
    limit: row.attemptLimit,
    sequence: observedSequence,
    recordedAt: observedAt,
  };
}

export function storedDetails(row: DetailRow): RunDetails {
  return {
    runId: row.runId,
    generation: row.generation,
    submission: row.submission,
    input: row.input,
    resolver: row.resolver,
    observation: storedObservation(row),
  };
}

export function decisionState(
  rows: DecisionRows & { readonly questions?: number },
): DecisionState {
  const highest = rows.gates.reduce(
    (label, row) => Math.max(label, row.label ?? 0),
    0,
  );
  return {
    gates: Object.fromEntries(
      rows.gates.map((row) => [
        gateKey(row.runId, row.gateId),
        storedGate(row),
      ]),
    ),
    details: Object.fromEntries(
      rows.details.map((row) => [row.runId, storedDetails(row)]),
    ),
    questions: rows.questions ?? highest,
  };
}

export function decisionRows(state: DecisionState): DecisionRows {
  return {
    gates: Object.values(state.gates)
      .map(gateRecord)
      .sort(
        (left, right) =>
          left.openedSequence - right.openedSequence ||
          (left.gateId < right.gateId ? -1 : 1),
      ),
    details: Object.values(state.details)
      .map(detailRecord)
      .sort((left, right) => (left.runId < right.runId ? -1 : 1)),
  };
}

export function referencedDigests(state: DecisionState): readonly string[] {
  return [
    ...Object.values(state.gates).flatMap((gate) => [
      gate.prompt,
      gate.outcome?.answer ?? null,
    ]),
    ...Object.values(state.details).flatMap((details) => [
      details.submission,
      details.input,
    ]),
  ].filter((digest) => digest !== null);
}

export function documentsIntact(
  documents: readonly DocumentRow[],
  referenced: readonly string[],
): boolean {
  const stored = new Set(documents.map((row) => row.digest));
  return (
    documents.every((row) => documentDigest(row.body) === row.digest) &&
    referenced.every((digest) => stored.has(digest))
  );
}
