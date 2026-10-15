import { gateKey } from "../src/authority/gates.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityEvent,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import { pin } from "./authority-store-fixture.ts";
import { operationOf, type Fields } from "./effect-pure-fixture.ts";

const body = documentDigest("generated");
const effect = {
  capability: "fake-harness",
  method: "run-turn",
  target: "workspace/main",
  payload: body,
};
const inputDigest = effectInputDigest(effect);

interface Subject {
  readonly runId: string;
  readonly gateId: string;
  readonly operationId: string;
  readonly choice: number;
}

function gates(state: AuthorityState, subject: Subject): readonly Fields[] {
  const { runId, gateId, choice } = subject;
  const gate = state.gates[gateKey(runId, gateId)];
  const revision = state.runs[runId]?.revision ?? 1;
  const typed = gate !== undefined && gate.kind !== "untyped";
  const question = gate?.kind === "question";
  return [
    { kind: "open-gate", gateId, expectedRevision: revision },
    {
      kind: "open-gate",
      gateId,
      expectedRevision: revision,
      gateKind: choice % 2 === 0 ? "question" : "approval",
      subject: body,
      prompt: body,
      expiresAt: "2026-10-10T12:05:00.000Z",
    },
    {
      kind: "decide-gate",
      gateId,
      expectedRevision: typed ? gate.revision : revision,
      decision: question ? "answered" : "approved",
      ...(typed ? { generation: gate.generation, subject: body } : {}),
      ...(question ? { answer: body } : {}),
    },
    { kind: "register-wait", gateId },
    { kind: "expire-gate", gateId },
  ];
}

function effects(state: AuthorityState, subject: Subject): readonly Fields[] {
  const { operationId, runId, choice } = subject;
  const operation = state.effects.operations[operationId];
  const lease = state.effects.leases[operation?.leaseKey ?? "shared"];
  const generation = lease?.generation ?? 1;
  const pending = state.intents.filter((intent) => intent.runId === runId);
  return [
    {
      kind: "request-effect",
      operationId,
      ...effect,
      inputDigest,
      units: choice % 4,
      recoveryLimit: 3,
      resource: "shared",
    },
    {
      kind: "grant-lease",
      operationId,
      leaseGeneration: (lease?.generation ?? 0) + 1,
      expiresAt: "2026-10-10T12:10:00.000Z",
      capacity: 4,
    },
    { kind: "expire-lease", operationId, leaseGeneration: generation },
    {
      kind: "record-outcome",
      operationId,
      leaseGeneration: generation,
      outcome: ["accepted", "not-started", "unknown"][choice % 3],
      receipt: "generated",
      worker: "worker-1",
    },
    {
      kind: "report-effect",
      operationId,
      leaseGeneration: generation,
      inputDigest,
      worker: "worker-1",
      outcome: "completed",
      result: body,
    },
    {
      kind: "record-dispatch",
      receipt: "generated",
      operationId:
        pending[choice % Math.max(pending.length, 1)]?.operationId ??
        operationId,
    },
  ];
}

function choices(state: AuthorityState, subject: Subject): readonly Fields[] {
  const revision = state.runs[subject.runId]?.revision ?? 1;
  return [
    {
      kind: "admit-run",
      workflow: pin,
      effectLimit: 5,
      capabilities: '["fake-harness"]',
    },
    { kind: "mark-started", expectedRevision: revision },
    { kind: "pause-run", expectedRevision: revision },
    { kind: "resume-run", expectedRevision: revision },
    { kind: "report-observation", condition: "working", reason: "generated" },
    ...gates(state, subject),
    ...effects(state, subject),
    { kind: "complete-run", expectedRevision: revision },
    { kind: "cancel-run", expectedRevision: revision },
    { kind: "fail-run", expectedRevision: revision },
  ];
}

export function generatedHistory(seed: number): readonly AuthorityEvent[] {
  let state = emptyAuthority;
  const events: AuthorityEvent[] = [];
  let random = seed;
  const next = (bound: number): number => {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((random / 2 ** 32) * bound);
  };
  for (let index = 0; index < 600; index += 1) {
    const runId = `run-${String(index < 16 ? Math.floor(index / 2) : next(8))}`;
    const proposed = choices(state, {
      runId,
      gateId: `gate-${String(next(3))}`,
      operationId: operationOf(next(4), runId),
      choice: next(12),
    });
    const selection =
      index < 16 ? index % 2 : next(proposed.length - (index < 450 ? 3 : 0));
    const command = {
      ...proposed[selection],
      runId,
      commandId: `command-${String(index)}`,
    };
    const result = execute(state, {
      command,
      recordedAt:
        next(2) === 0 ? "2026-10-10T12:00:00.000Z" : "2026-10-10T12:10:00.000Z",
    });
    if (result.kind !== "accepted") continue;
    state = result.state;
    events.push(...result.events);
  }
  return events;
}
