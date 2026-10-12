import type { Authority, StoreReceipt } from "../src/broker/actor/authority.ts";
import { manifest, storedGate } from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import { versionThree } from "./effect-fixture.ts";

export interface TypedStep {
  readonly command: Readonly<Record<string, unknown>>;
  readonly documents?: readonly string[];
  readonly recordedAt?: string;
}

export const noon = "2026-10-10T12:00:00.000Z";
export const deadline = "2026-10-10T13:00:00.000Z";
export const promptText = "Which parser is correct for the input format?";
export const answerText = 'Use the table parser.\nKeep the "old" one: ünïcode.';

export const admission = storedGate[0] ?? {};
export const started = {
  kind: "mark-started",
  commandId: "c-2",
  runId: "run-1",
  expectedRevision: 1,
};
export const question = {
  kind: "open-gate",
  commandId: "c-3",
  runId: "run-1",
  gateId: "design-1",
  expectedRevision: 2,
  gateKind: "question",
  subject: digestOf(promptText),
  prompt: digestOf(promptText),
};
export const wait = {
  kind: "register-wait",
  commandId: "c-4",
  runId: "run-1",
  gateId: "design-1",
};
export const answer = {
  kind: "decide-gate",
  commandId: "c-5",
  runId: "run-1",
  gateId: "design-1",
  decision: "answered",
  expectedRevision: 1,
  generation: 1,
  subject: digestOf(promptText),
  answer: digestOf(answerText),
};

export const answeredQuestion: readonly TypedStep[] = [
  { command: admission },
  { command: started },
  { command: question, documents: [promptText] },
  { command: wait },
  { command: answer, documents: [answerText] },
];

const pinned = ["admit-run", "decide-gate", "resume-run"];

export function executeTyped(
  authority: Authority,
  step: TypedStep,
): Promise<StoreReceipt> {
  return authority.execute(step.command, {
    recordedAt: step.recordedAt ?? noon,
    ...(pinned.includes(String(step.command["kind"])) ? { manifest } : {}),
    ...(step.documents === undefined ? {} : { documents: step.documents }),
  });
}

export async function executeAll(
  authority: Authority,
  steps: readonly TypedStep[],
): Promise<readonly StoreReceipt[]> {
  const receipts: StoreReceipt[] = [];
  for (const step of steps) receipts.push(await executeTyped(authority, step));
  return receipts;
}

export const downgrade = `${versionThree}
DROP TABLE gates;
DROP TABLE run_details;
DROP TABLE documents;
DELETE FROM schema_migrations WHERE version = 3;
PRAGMA user_version = 2;
`;
