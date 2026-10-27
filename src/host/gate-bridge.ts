import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gateKey } from "../authority/gates.ts";
import { decisionToken } from "../decision-wait.ts";
import { record } from "../protocol.ts";
import type {
  DecisionResult,
  DecisionWait,
  GateRequest,
  GateResult,
} from "../step-bridge.ts";

export interface GateReceipt {
  readonly kind: string;
  readonly reason?: string;
}

export interface GateOpening {
  readonly waitMode?: "hook";
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly gateId: string;
  readonly kind: "question" | "approval";
  readonly prompt: string;
  readonly subject: string;
  readonly expiresAt?: string;
}

export interface WaitRegistration {
  readonly runId: string;
  readonly commandId: string;
  readonly gateId: string;
}

interface GatePorts {
  readonly stopped: AbortSignal;
  readonly timing?: {
    readonly pollMilliseconds: number;
    readonly retryMilliseconds: number;
  };
  readonly state: () => Promise<{
    readonly runs: Readonly<
      Record<string, { readonly revision: number } | undefined>
    >;
    readonly gates: Readonly<Record<string, unknown>>;
  }>;
  readonly openGate: (opening: GateOpening) => Promise<GateReceipt>;
  readonly registerWait: (wait: WaitRegistration) => Promise<GateReceipt>;
}

interface GateHold {
  readonly ports: GatePorts;
  readonly timing: {
    readonly pollMilliseconds: number;
    readonly retryMilliseconds: number;
  };
}

const committed = ["accepted", "duplicate"];

function promptDigest(request: GateRequest): string {
  return `sha256:${createHash("sha256").update(request.prompt).digest("hex")}`;
}

function sameHookSubject(value: unknown, request: GateRequest): boolean {
  const gate = record(value);
  return (
    gate?.["subject"] === promptDigest(request) &&
    gate["kind"] === request.kind &&
    gate["wait"] === "hook"
  );
}

async function paused(hold: GateHold, milliseconds: number): Promise<void> {
  await delay(milliseconds, undefined, { signal: hold.ports.stopped }).catch(
    () => undefined,
  );
  if (hold.ports.stopped.aborted) await new Promise<never>(() => undefined);
}

interface GateSubject {
  readonly waitMode?: "hook";
  readonly runId: string;
  readonly transport: string;
  readonly request: GateRequest;
}

function verdict(
  hold: GateHold,
  receipt: GateReceipt | undefined,
): GateResult | "committed" | number {
  if (receipt === undefined || receipt.kind === "failed")
    return hold.timing.retryMilliseconds;
  if (committed.includes(receipt.kind)) return "committed";
  if (receipt.reason === "service-busy") return hold.timing.retryMilliseconds;
  if (receipt.reason === "stale-revision") return hold.timing.pollMilliseconds;
  return { kind: "refused", reason: receipt.reason ?? receipt.kind };
}

async function gateCommand(
  hold: GateHold,
  send: () => Promise<GateReceipt>,
): Promise<GateResult | undefined> {
  for (;;) {
    await paused(hold, 0);
    const result = verdict(hold, await send().catch(() => undefined));
    if (result === "committed") return undefined;
    if (typeof result !== "number") return result;
    await paused(hold, result);
  }
}

async function opening(
  hold: GateHold,
  subject: GateSubject,
): Promise<GateReceipt> {
  const { runId, transport, request } = subject;
  const { gateId, kind, prompt } = request;
  const state = await hold.ports.state();
  const run = state.runs[runId];
  if (run === undefined) return { kind: "rejected", reason: "unknown-run" };
  const key = gateKey(runId, gateId);
  const exists = Object.hasOwn(state.gates, key);
  if (
    exists &&
    subject.waitMode === "hook" &&
    !sameHookSubject(state.gates[key], request)
  )
    return { kind: "rejected", reason: "gate-subject-changed" };
  if (exists) return { kind: "duplicate" };
  return await hold.ports.openGate({
    ...(subject.waitMode === undefined ? {} : { waitMode: subject.waitMode }),
    runId,
    commandId: `${transport}:open:${gateId}`,
    expectedRevision: run.revision,
    gateId,
    kind,
    prompt,
    subject: promptDigest(request),
    ...(request.expiresAt === undefined
      ? {}
      : { expiresAt: request.expiresAt }),
  });
}

export async function openBridgeGate(
  ports: GatePorts,
  subject: GateSubject,
): Promise<GateResult> {
  const hold = {
    ports,
    timing: ports.timing ?? { pollMilliseconds: 20, retryMilliseconds: 1000 },
  };
  const refusal = await gateCommand(hold, () => opening(hold, subject));
  if (refusal !== undefined) return refusal;
  if (subject.waitMode === "hook")
    return {
      kind: "opened",
      decisionId: decisionToken(subject.runId, subject.request.gateId),
    };
  const waited = await gateCommand(hold, () =>
    ports.registerWait({
      runId: subject.runId,
      commandId: `${subject.transport}:wait:${subject.request.gateId}`,
      gateId: subject.request.gateId,
    }),
  );
  return waited ?? { kind: "opened", decisionId: subject.request.gateId };
}

export async function waitForBridgeDecision(
  ports: GatePorts & {
    readonly document: (digest: string) => Promise<string | undefined>;
    readonly decisionReceived: (
      runId: string,
      gateId: string,
    ) => Promise<boolean>;
  },
  subject: GateSubject,
): Promise<DecisionWait> {
  const hold = {
    ports,
    timing: ports.timing ?? { pollMilliseconds: 20, retryMilliseconds: 1000 },
  };
  await paused(hold, 0);
  const state = await ports.state();
  const key = gateKey(subject.runId, subject.request.gateId);
  const gate = state.gates[key];
  if (
    Object.hasOwn(state.gates, key) &&
    !sameHookSubject(gate, subject.request)
  )
    throw new Error("gate-subject-changed");
  const outcome = record(record(gate)?.["outcome"]);
  if (
    outcome !== undefined &&
    (await ports.decisionReceived(subject.runId, subject.request.gateId))
  )
    return await storedDecision(ports, outcome);
  const opening = await openBridgeGate(ports, { ...subject, waitMode: "hook" });
  if (opening.kind !== "opened") throw new Error(opening.reason);
  return { token: opening.decisionId };
}

async function storedDecision(
  ports: { readonly document: (digest: string) => Promise<string | undefined> },
  outcome: Readonly<Record<string, unknown>>,
): Promise<DecisionResult> {
  const decision = (
    ["approved", "denied", "answered", "expired"] as const
  ).find((value) => value === outcome["decision"]);
  if (decision === undefined) throw new Error("invalid-decision-outcome");
  const digest = outcome["answer"];
  if (digest !== null && typeof digest !== "string")
    throw new Error("invalid-decision-answer");
  const answer = digest === null ? null : await ports.document(digest);
  if (answer === undefined) throw new Error("missing-decision-answer");
  return { decision, answer };
}
