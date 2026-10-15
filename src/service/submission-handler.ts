import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandRecord } from "../broker/actor/authority.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { record, type Fields, type Reply } from "../protocol.ts";
import {
  checkResolution,
  checkSubmission,
  normalizedRequest,
  type CheckedResolution,
} from "../submission.ts";
import type { Registered } from "./registry.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  type ServiceContext,
} from "./replies.ts";

export function runIdentity(commandId: string): string {
  return `run-${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}`;
}

function resolverIdentity(text: string): Fields {
  const separator = text.lastIndexOf(":");
  return { id: text.slice(0, separator), version: text.slice(separator + 1) };
}

function admitted(
  stored: CommandRecord,
  outcome: { readonly workflowId: string; readonly replayed: boolean },
): Reply {
  const { command } = stored;
  return result("run-admitted", {
    runId: stored.runId,
    workflowId: outcome.workflowId,
    commandId: stored.commandId,
    replayed: outcome.replayed,
    receipt: publicReceipt(stored),
    binding: {
      workflowPin: command.workflow,
      resolver: resolverIdentity(String(command.resolver)),
      requestDigest: command.submission,
      executionInputDigest: command.input,
    },
  });
}

function conflict(commandId: string): Reply {
  return failed("conflicting-command", {
    commandId,
    detail: "The command ID is known with a different request.",
  });
}

function replayed(
  existing: CommandRecord,
  request: { readonly workflowId: string; readonly submission: unknown },
): Reply {
  const submission = record(request.submission);
  const same =
    existing.command.kind === "admit-run" &&
    submission !== undefined &&
    documentDigest(normalizedRequest(request.workflowId, submission)) ===
      existing.command.submission;
  return same
    ? admitted(existing, { workflowId: request.workflowId, replayed: true })
    : conflict(existing.commandId);
}

function effectBudget(workflow: Registered): Fields {
  if (workflow.effectLimit === undefined) return {};
  return {
    effectLimit: workflow.effectLimit,
    capabilities: JSON.stringify([...workflow.manifest.capabilities].sort()),
  };
}

type Usable =
  | { readonly kind: "usable"; readonly workflow: Registered }
  | { readonly kind: "unusable"; readonly reply: Reply };

function usable(workflow: Registered | undefined, workflowId: string): Usable {
  if (workflow === undefined)
    return {
      kind: "unusable",
      reply: failed("unknown-workflow", {
        detail: `No admitted workflow has the ID ${workflowId}.`,
      }),
    };
  if (workflow.availability !== "available")
    return {
      kind: "unusable",
      reply: failed("workflow-unavailable", {
        detail: `The workflow ${workflowId} is not available. A required capability did not pass admission.`,
      }),
    };
  return { kind: "usable", workflow };
}

interface Admission {
  readonly workflow: Registered;
  readonly workflowId: string;
  readonly commandId: string;
  readonly submission: Fields;
  readonly normalized: string;
}

type Resolved = CheckedResolution | "timeout" | "failure";

async function resolved(
  context: ServiceContext,
  admission: Admission,
): Promise<Resolved> {
  const { workflow, workflowId, commandId, submission } = admission;
  const limit = new AbortController();
  const timer = new AbortController();
  const request = { workflowId, submission, commandId, signal: limit.signal };
  const call = Promise.resolve(request)
    .then((given) => workflow.resolver.resolve(given))
    .then((value) => checkResolution(value) ?? ("failure" as const))
    .catch(() => "failure" as const);
  const expired = delay(context.resolverMilliseconds, "timeout" as const, {
    signal: timer.signal,
  });
  try {
    const outcome = await Promise.race([call, expired]);
    if (outcome === "timeout") limit.abort();
    return outcome;
  } finally {
    timer.abort();
  }
}

function unresolved(
  context: ServiceContext,
  outcome: { readonly kind: "timeout" | "failure"; readonly commandId: string },
): Reply {
  const { kind, commandId } = outcome;
  if (kind === "timeout")
    return failed("resolver-timeout", {
      commandId,
      detail: `The resolver gave no result in ${String(context.resolverMilliseconds)} ms. Send the command again with the same command ID.`,
    });
  return failed("resolver-failure", {
    commandId,
    detail:
      "The resolver of the workflow failed or gave a result that is not valid. Nothing is admitted.",
  });
}

async function admit(
  context: ServiceContext,
  admission: Admission,
): Promise<Reply> {
  const { workflow, workflowId, commandId, normalized } = admission;
  const resolution = await resolved(context, admission);
  if (typeof resolution === "string")
    return unresolved(context, { kind: resolution, commandId });
  if (resolution.kind === "rejected")
    return failed(resolution.code, { commandId, detail: resolution.detail });
  const { input } = resolution;
  if (Buffer.byteLength(input) > context.documentBytes)
    return unresolved(context, { kind: "failure", commandId });
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: {
      kind: "admit-run",
      commandId,
      runId: runIdentity(commandId),
      workflow: workflow.pin,
      submission: documentDigest(normalized),
      input: documentDigest(input),
      resolver: `${workflow.resolver.id}:${workflow.resolver.version}`,
      ...effectBudget(workflow),
    },
    documents: [normalized, input],
  });
  if (!committed(receipt)) return rejection(receipt, { commandId });
  const stored = await context.authority.queries.receipt(commandId);
  if (stored === undefined) return conflict(commandId);
  return admitted(stored, {
    workflowId,
    replayed: receipt.kind === "duplicate",
  });
}

async function submitted(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { workflowId, commandId } = parameters;
  if (!isIdentifier(workflowId) || !isIdentifier(commandId))
    return invalidRequest("The workflow ID or the command ID is not valid.");
  const existing = await context.authority.queries.receipt(commandId);
  if (existing !== undefined)
    return replayed(existing, {
      workflowId,
      submission: parameters["submission"],
    });
  const found = usable(context.registry.byId(workflowId), workflowId);
  if (found.kind === "unusable") return found.reply;
  const contract = found.workflow.submission;
  const check = checkSubmission(
    {
      ...contract,
      maximumBytes: Math.min(contract.maximumBytes, context.documentBytes),
    },
    {
      workflowId,
      submission: parameters["submission"],
      source: parameters["source"],
    },
  );
  if (check.kind === "rejected")
    return failed(check.code, { commandId, detail: check.detail });
  if (
    found.workflow.admission === "when-idle" &&
    (await activeWorkflow(context, workflowId))
  )
    return failed("workflow-active", {
      commandId,
      detail: `The workflow ${workflowId} already has an active run.`,
    });
  return admit(context, {
    workflow: found.workflow,
    workflowId,
    commandId,
    submission: check.submission,
    normalized: check.normalized,
  });
}

async function activeWorkflow(
  context: ServiceContext,
  workflowId: string,
): Promise<boolean> {
  const workflows = await context.authority.queries.workflowIds();
  const state = await context.authority.state();
  return Object.values(state.runs).some(
    (run) =>
      workflows[run.runId] === workflowId &&
      !["completed", "failed", "cancelled"].includes(run.status),
  );
}

export function submissionHandler(
  context: ServiceContext,
): (parameters: Fields) => Promise<Reply> {
  const pending = new Map<string, Promise<Reply>>();
  return (parameters) => {
    const keys = [`command:${String(parameters["commandId"])}`];
    const workflowId = String(parameters["workflowId"]);
    if (context.registry.byId(workflowId)?.admission === "when-idle")
      keys.push(`workflow:${workflowId}`);
    const next = (): Promise<Reply> => submitted(context, parameters);
    const previous = keys
      .map((key) => pending.get(key))
      .filter((reply) => reply !== undefined);
    const reply = Promise.allSettled(previous).then(next);
    for (const key of keys) pending.set(key, reply);
    const settled = (): void => {
      for (const key of keys)
        if (pending.get(key) === reply) pending.delete(key);
    };
    reply.then(settled, settled);
    return reply;
  };
}
