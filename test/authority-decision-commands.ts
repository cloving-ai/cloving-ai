import {
  emptyAuthority,
  execute,
  type AuthorityState,
  type CommandResult,
} from "../src/authority/reducer.ts";

export type Command = Readonly<Record<string, unknown>>;

export interface Step {
  readonly command: Command;
  readonly at?: string;
}

export interface Outcome {
  readonly results: readonly CommandResult[];
  readonly state: AuthorityState;
}

export const noon = "2026-10-10T12:00:00.000Z";
export const deadline = "2026-10-10T13:00:00.000Z";
export const subject = `sha256:${"1".repeat(64)}`;
export const prompt = `sha256:${"2".repeat(64)}`;
export const answerText = `sha256:${"3".repeat(64)}`;

export function runAt(steps: readonly Step[]): Outcome {
  let state = emptyAuthority;
  const results: CommandResult[] = [];
  for (const step of steps) {
    const result = execute(state, {
      command: step.command,
      recordedAt: step.at ?? noon,
    });
    results.push(result);
    if (result.kind === "accepted") state = result.state;
  }
  return { results, state };
}

export function commands(list: readonly Command[]): Outcome {
  return runAt(list.map((command) => ({ command })));
}

export function reasons(outcome: Outcome): readonly string[] {
  return outcome.results.map((result) =>
    result.kind === "rejected" ? result.reason : result.kind,
  );
}

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
  subject,
  prompt,
};
export const approval = { ...question, gateKind: "approval" };
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
  subject,
  answer: answerText,
};
export const approve = {
  kind: "decide-gate",
  commandId: "c-5",
  runId: "run-1",
  gateId: "design-1",
  decision: "approved",
  expectedRevision: 1,
  generation: 1,
  subject,
};
export const expire = {
  kind: "expire-gate",
  commandId: "c-6",
  runId: "run-1",
  gateId: "design-1",
};
export const continuation = {
  kind: "continue-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",5,"run-1","gate","continue-run",null,"design-1"]',
};
