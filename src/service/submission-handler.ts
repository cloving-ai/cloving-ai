import { createHash } from "node:crypto";
import { handoffChain, type HandoffChain } from "../authority/handoff-chain.ts";
import { executionCapabilities } from "../execution-pin.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  isCommandId,
  isIdentifier as isWorkflowIdentifier,
} from "../authority/commands.ts";
import type { CommandRecord } from "../broker/actor/authority.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { record, type Fields, type Reply } from "../protocol.ts";
import {
  checkResolution,
  checkSubmission,
  hasTicketField,
  normalizedRequest,
  type CheckedResolution,
} from "../submission.ts";
import type { Registered } from "./registry.ts";
import {
  committed,
  failed,
  invalidRequest,
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
    capabilities: executionCapabilities(workflow.manifest),
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
  readonly chain: HandoffChain;
  readonly workflow: Registered;
  readonly workflowId: string;
  readonly commandId: string;
  readonly submission: Fields;
  readonly normalized: string;
  readonly activeTickets: readonly Fields[];
}

type Resolved = CheckedResolution | "timeout" | "failure";

async function resolved(
  context: ServiceContext,
  admission: Admission,
): Promise<Resolved> {
  const { workflow, workflowId, commandId, submission } = admission;
  const limit = new AbortController();
  const timer = new AbortController();
  const request = {
    workflowId,
    submission,
    commandId,
    signal: limit.signal,
    activeTickets: admission.activeTickets,
  };
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
  const limited = capacityRefusal(workflow, admission);
  if (limited !== undefined) return limited;
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
      ...(admission.chain.kind === "handoff"
        ? {
            parentRunId: admission.chain.parentRunId,
            chainId: admission.chain.chainId,
          }
        : {}),
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

function admissionRefusal(
  workflow: Registered,
  request: {
    readonly workflowId: string;
    readonly commandId: string;
    readonly submission: Fields;
    readonly activeTickets: readonly Fields[];
  },
): Reply | undefined {
  const { workflowId, commandId, submission, activeTickets } = request;
  const tickets =
    workflowId === "develop-issue" || hasTicketField(workflow.submission);
  if (
    tickets &&
    typeof submission["ticket"] === "string" &&
    activeTickets.some((input) => input["ticketId"] === submission["ticket"])
  )
    return failed("ticket-active", {
      commandId,
      detail: "An active run already works on this ticket.",
    });
  if (tickets && submission["ticket"] !== "next") return undefined;
  return capacityRefusal(workflow, request);
}

function capacityRefusal(
  workflow: Registered,
  request: {
    readonly workflowId: string;
    readonly commandId: string;
    readonly activeTickets: readonly Fields[];
  },
): Reply | undefined {
  if (
    workflow.admission !== undefined &&
    request.activeTickets.length >=
      (workflow.admission === "when-idle" ? 1 : workflow.admission)
  )
    return failed("workflow-active", {
      commandId: request.commandId,
      detail: `The workflow ${request.workflowId} already has an active run.`,
    });
  return undefined;
}

async function submitted(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { workflowId, commandId } = parameters;
  if (!isWorkflowIdentifier(workflowId) || !isCommandId(commandId))
    return invalidRequest("The workflow ID or the command ID is not valid.");
  const existing = await context.authority.queries.receipt(commandId);
  if (existing !== undefined)
    return replayed(existing, {
      workflowId,
      submission: parameters["submission"],
    });
  const chain = handoffChain(
    commandId,
    commandId.startsWith("handoff:")
      ? await context.authority.queries.runOrigins()
      : {},
  );
  if (chain.kind === "refused")
    return failed(chain.reason, {
      commandId,
      detail:
        "A hand-off chain permits at most five runs and requires a recorded parent.",
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
  const activeTickets = await activeWorkflow(context, workflowId);
  const refusal = admissionRefusal(found.workflow, {
    workflowId,
    commandId,
    submission: check.submission,
    activeTickets,
  });
  if (refusal !== undefined) return refusal;
  return admit(context, {
    chain,
    workflow: found.workflow,
    workflowId,
    commandId,
    submission: check.submission,
    normalized: check.normalized,
    activeTickets,
  });
}

async function activeWorkflow(
  context: ServiceContext,
  workflowId: string,
): Promise<Fields[]> {
  const workflows = await context.authority.queries.workflowIds();
  const state = await context.authority.state();
  const runs = Object.values(state.runs).filter(
    (run) =>
      workflows[run.runId] === workflowId &&
      !["completed", "failed", "cancelled"].includes(run.status),
  );
  return Promise.all(
    runs.map(async (run) => {
      const digest = state.details[run.runId]?.input;
      const text = digest
        ? await context.authority.queries.document(digest)
        : undefined;
      const input = record(JSON.parse(text ?? "null")) ?? {};
      const ticket = record(record(input["input"])?.["ticket"]);
      return ticket === undefined
        ? input
        : { ...input, ticketId: ticket["id"], ticket: ticket["text"] };
    }),
  );
}

export async function queueOverview(context: ServiceContext): Promise<Fields> {
  const workflow = context.registry.byId("develop-issue");
  if (workflow?.admission === undefined) return {};
  const active = await activeWorkflow(context, "develop-issue");
  return {
    queue: {
      lanes: workflow.admission === "when-idle" ? 1 : workflow.admission,
      busy: active.length,
      skipped: [
        ...active.flatMap((input) =>
          typeof input["ticketId"] === "string"
            ? [{ ticketId: input["ticketId"], reason: "ticket-active" }]
            : [],
        ),
        ...(workflow.resolver.skippedTickets?.() ?? []),
      ],
    },
  };
}

export function submissionHandler(
  context: ServiceContext,
): (parameters: Fields) => Promise<Reply> {
  const pending = new Map<string, Promise<Reply>>();
  return (parameters) => {
    const keys = [`command:${String(parameters["commandId"])}`];
    const workflowId = String(parameters["workflowId"]);
    if (
      workflowId === "develop-issue" ||
      hasTicketField(context.registry.byId(workflowId)?.submission) ||
      context.registry.byId(workflowId)?.admission !== undefined
    )
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
