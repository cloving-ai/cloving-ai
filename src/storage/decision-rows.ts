import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "./domain-rows.ts";

export interface GateRow {
  readonly runId: string;
  readonly gateId: string;
  readonly kind: string;
  readonly label: number | null;
  readonly subject: string | null;
  readonly prompt: string | null;
  readonly expiresAt: string | null;
  readonly generation: number;
  readonly revision: number;
  readonly wait: string;
  readonly decision: string | null;
  readonly answer: string | null;
  readonly decidedSequence: number | null;
  readonly openedSequence: number;
  readonly continuation: string | null;
}

export interface DetailRow {
  readonly runId: string;
  readonly generation: number;
  readonly submission: string | null;
  readonly input: string | null;
  readonly resolver: string | null;
  readonly condition: string | null;
  readonly reason: string | null;
  readonly evidence: string | null;
  readonly retryAt: string | null;
  readonly attempt: number | null;
  readonly attemptLimit: number | null;
  readonly observedSequence: number | null;
  readonly observedAt: string | null;
  readonly observedOperation: string | null;
}

export interface DocumentRow {
  readonly digest: string;
  readonly body: string;
}

export interface DecisionRows {
  readonly gates: readonly GateRow[];
  readonly details: readonly DetailRow[];
}

export const gateColumns =
  "run_id, gate_id, kind, label, subject, prompt, expires_at, generation, revision, wait, decision, answer, decided_sequence, opened_sequence, continuation";

export const detailColumns =
  "run_id, generation, submission, input, resolver, condition, reason, evidence, retry_at, attempt, attempt_limit, observed_sequence, observed_at, observed_operation";

export function gateRow(row: unknown): GateRow {
  return {
    runId: text(row, "run_id"),
    gateId: text(row, "gate_id"),
    kind: text(row, "kind"),
    label: optionalInteger(row, "label"),
    subject: optionalText(row, "subject"),
    prompt: optionalText(row, "prompt"),
    expiresAt: optionalText(row, "expires_at"),
    generation: integer(row, "generation"),
    revision: integer(row, "revision"),
    wait: text(row, "wait"),
    decision: optionalText(row, "decision"),
    answer: optionalText(row, "answer"),
    decidedSequence: optionalInteger(row, "decided_sequence"),
    openedSequence: integer(row, "opened_sequence"),
    continuation: optionalText(row, "continuation"),
  };
}

export function detailRow(row: unknown): DetailRow {
  return {
    runId: text(row, "run_id"),
    generation: integer(row, "generation"),
    submission: optionalText(row, "submission"),
    input: optionalText(row, "input"),
    resolver: optionalText(row, "resolver"),
    condition: optionalText(row, "condition"),
    reason: optionalText(row, "reason"),
    evidence: optionalText(row, "evidence"),
    retryAt: optionalText(row, "retry_at"),
    attempt: optionalInteger(row, "attempt"),
    attemptLimit: optionalInteger(row, "attempt_limit"),
    observedSequence: optionalInteger(row, "observed_sequence"),
    observedAt: optionalText(row, "observed_at"),
    observedOperation: optionalText(row, "observed_operation"),
  };
}

export function documentRow(row: unknown): DocumentRow {
  return { digest: text(row, "digest"), body: text(row, "body") };
}

export async function loadDecisions(
  connection: SqlConnection,
): Promise<DecisionRows> {
  return {
    gates: (
      await connection.all(
        `SELECT ${gateColumns} FROM gates ORDER BY opened_sequence, gate_id`,
      )
    ).map(gateRow),
    details: (
      await connection.all(
        `SELECT ${detailColumns} FROM run_details ORDER BY run_id`,
      )
    ).map(detailRow),
  };
}

export async function loadDocuments(
  connection: SqlConnection,
): Promise<readonly DocumentRow[]> {
  return (
    await connection.all("SELECT digest, body FROM documents ORDER BY digest")
  ).map(documentRow);
}

export async function runDecisions(
  connection: SqlConnection,
  runId: string,
): Promise<DecisionRows & { readonly questions: number }> {
  return {
    gates: (
      await connection.all(
        `SELECT ${gateColumns} FROM gates WHERE run_id = ? ORDER BY opened_sequence, gate_id`,
        [runId],
      )
    ).map(gateRow),
    details: (
      await connection.all(
        `SELECT ${detailColumns} FROM run_details WHERE run_id = ?`,
        [runId],
      )
    ).map(detailRow),
    questions: integer(
      await connection.get(
        "SELECT coalesce(max(label), 0) AS questions FROM gates",
      ),
      "questions",
    ),
  };
}

export async function storedDigests(
  connection: SqlConnection,
  digests: readonly string[],
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const digest of digests) {
    const row = await connection.get(
      "SELECT digest FROM documents WHERE digest = ?",
      [digest],
    );
    if (row !== undefined) found.push(digest);
  }
  return found;
}

export async function documentBody(
  connection: SqlConnection,
  digest: string,
): Promise<string | undefined> {
  const row = await connection.get(
    "SELECT body FROM documents WHERE digest = ?",
    [digest],
  );
  return row === undefined ? undefined : text(row, "body");
}
