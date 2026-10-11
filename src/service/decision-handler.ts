import { continues, gateKey, type GateState } from "../authority/gates.ts";
import type { AuthorityState, RunState } from "../authority/reducer.ts";
import { gateContinuation } from "../authority/reduction.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  wholeNumber,
  type ServiceContext,
} from "./replies.ts";

const decisions: Readonly<Record<string, string>> = {
  answer: "answered",
  approve: "approved",
  deny: "denied",
};

const commands: Readonly<Record<string, readonly string[]>> = {
  question: ["answer"],
  approval: ["approve", "deny"],
};

function decisionId(gate: GateState): string {
  return `${gate.runId}/${gate.gateId}`;
}

function label(gate: GateState): string | null {
  return gate.label === null ? null : `Q${String(gate.label)}`;
}

function typed(state: AuthorityState): readonly GateState[] {
  return Object.values(state.gates)
    .filter((gate) => gate.kind !== "untyped")
    .sort((left, right) => left.openedSequence - right.openedSequence);
}

function pending(state: AuthorityState): readonly GateState[] {
  return typed(state).filter(
    (gate) =>
      gate.outcome === null &&
      ["waiting_gate", "paused"].includes(state.runs[gate.runId]?.status ?? ""),
  );
}

async function described(
  context: ServiceContext,
  gate: GateState,
): Promise<Fields> {
  const { queries } = context.authority;
  const opened = await queries.eventsAfter({
    after: gate.openedSequence - 1,
    limit: 1,
  });
  return {
    decisionId: decisionId(gate),
    label: label(gate),
    type: gate.kind,
    runId: gate.runId,
    gateId: gate.gateId,
    prompt: (await queries.document(gate.prompt ?? "")) ?? "",
    allowed: commands[gate.kind] ?? [],
    revision: gate.revision,
    generation: gate.generation,
    subjectDigest: gate.subject,
    openedAt: opened.events[0]?.recordedAt ?? "",
    expiresAt: gate.expiresAt,
    context: [],
  };
}

export async function questions(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { runId } = parameters;
  const state = await context.authority.state();
  const listed = pending(state).filter(
    (gate) => runId === undefined || gate.runId === runId,
  );
  const views: Fields[] = [];
  for (const gate of listed) views.push(await described(context, gate));
  return result("decision-list", { decisions: views });
}

function referenced(
  gates: readonly GateState[],
  reference: string,
): readonly GateState[] {
  const matches = [
    (gate: GateState): boolean => decisionId(gate) === reference,
    (gate: GateState): boolean => label(gate) === reference,
    (gate: GateState): boolean => gate.runId === reference,
  ].map((matcher) => gates.filter(matcher));
  return matches.find((found) => found.length > 0) ?? [];
}

type Target =
  | { readonly kind: "gate"; readonly gate: GateState }
  | { readonly kind: "refused"; readonly reply: Reply };

function refusedTarget(code: string, extra: Fields): Target {
  return { kind: "refused", reply: failed(code, extra) };
}

function target(
  state: AuthorityState,
  request: { readonly reference: string; readonly command: string },
): Target {
  const { reference, command } = request;
  const open = referenced(pending(state), reference);
  if (open.length === 0)
    return refusedTarget(
      referenced(typed(state), reference).length > 0
        ? "decision-not-pending"
        : "unknown-decision",
      { detail: `No pending decision matches ${reference}.` },
    );
  const allowing = open.filter((gate) =>
    commands[gate.kind]?.includes(command),
  );
  const [gate] = allowing;
  if (gate === undefined)
    return refusedTarget("decision-not-allowed", {
      detail: `The decision does not allow the command ${command}.`,
    });
  if (allowing.length > 1)
    return refusedTarget("ambiguous-decision", {
      detail: "The reference matches more than one pending decision.",
      candidates: allowing.map(decisionId),
    });
  return { kind: "gate", gate };
}

interface DecisionRequest {
  readonly command: string;
  readonly reference: string;
  readonly text: string | null;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly subjectDigest: string;
  readonly commandId: string;
}

function validText(command: string, text: unknown): text is string | null {
  if (command !== "answer") return text === undefined || text === null;
  return typeof text === "string" && text.trim().length > 0;
}

function decisionRequest(parameters: Fields): DecisionRequest | undefined {
  const { command, reference, expectedRevision, generation } = parameters;
  const { subjectDigest, commandId } = parameters;
  const text: unknown = parameters["text"] ?? null;
  if (
    typeof command !== "string" ||
    !Object.hasOwn(decisions, command) ||
    typeof reference !== "string" ||
    !wholeNumber(expectedRevision, 1) ||
    !wholeNumber(generation, 1) ||
    !isIdentifier(subjectDigest) ||
    !isIdentifier(commandId) ||
    !validText(command, text)
  )
    return undefined;
  return {
    command,
    reference,
    text,
    expectedRevision,
    generation,
    subjectDigest,
    commandId,
  };
}

async function located(
  context: ServiceContext,
  request: DecisionRequest,
): Promise<
  | Target
  | { readonly kind: "known"; readonly runId: string; readonly gateId: string }
> {
  const { commandId, text } = request;
  if (text !== null && Buffer.byteLength(text) > context.textBytes)
    return refusedTarget("input-too-large", {
      commandId,
      detail: `An answer has at most ${String(context.textBytes)} bytes.`,
    });
  const existing = await context.authority.queries.receipt(commandId);
  if (existing === undefined)
    return target(await context.authority.state(), request);
  const { gateId } = existing.command;
  if (existing.command.kind !== "decide-gate" || gateId === undefined)
    return refusedTarget("conflicting-command", {
      commandId,
      detail: "The command ID is known with a different request.",
    });
  return { kind: "known", runId: existing.runId, gateId };
}

export async function decision(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const request = decisionRequest(parameters);
  if (request === undefined)
    return invalidRequest("The decision request is not valid.");
  const found = await located(context, request);
  if (found.kind === "refused") return found.reply;
  const { runId, gateId } = found.kind === "gate" ? found.gate : found;
  const { commandId, text } = request;
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: {
      kind: "decide-gate",
      commandId,
      runId,
      gateId,
      decision: decisions[request.command],
      expectedRevision: request.expectedRevision,
      generation: request.generation,
      subject: request.subjectDigest,
      ...(text === null ? {} : { answer: documentDigest(text) }),
    },
    documents: text === null ? [] : [text],
  });
  if (!committed(receipt)) {
    const state = await context.authority.state();
    return rejection(receipt, {
      commandId,
      runId,
      currentRevision: state.gates[gateKey(runId, gateId)]?.revision ?? null,
    });
  }
  return recorded(context, {
    commandId,
    runId,
    gateId,
    replayed: receipt.kind === "duplicate",
  });
}

async function continuationState(
  context: ServiceContext,
  decided: { readonly gate: GateState; readonly run: RunState },
): Promise<"admitted" | "held"> {
  const { gate, run } = decided;
  if (!continues(gate)) return "held";
  const { operationId } = gateContinuation(gate);
  const operation = (await context.authority.operations()).find(
    (item) => item.operationId === operationId,
  );
  if (operation?.deliveries.some((delivery) => delivery.outcome === "sent"))
    return "admitted";
  const deliverable =
    operation?.releasedSequence === null && run.status === "running";
  return deliverable ? "admitted" : "held";
}

async function recorded(
  context: ServiceContext,
  outcome: {
    readonly commandId: string;
    readonly runId: string;
    readonly gateId: string;
    readonly replayed: boolean;
  },
): Promise<Reply> {
  const { commandId, runId, gateId } = outcome;
  const stored = await context.authority.queries.receipt(commandId);
  const state = await context.authority.state();
  const gate = state.gates[gateKey(runId, gateId)];
  const run = state.runs[runId];
  if (stored === undefined || gate === undefined || run === undefined)
    return failed("authority-unavailable", { commandId, runId });
  return result("decision-recorded", {
    decisionId: decisionId(gate),
    runId,
    decision: gate.outcome?.decision ?? null,
    commandId,
    replayed: outcome.replayed,
    receipt: publicReceipt(stored),
    run: { state: run.status, revision: run.revision },
    continuation: await continuationState(context, { gate, run }),
  });
}
