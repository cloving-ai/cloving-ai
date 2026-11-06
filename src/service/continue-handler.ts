import { continuationStart } from "../authority/continuations.ts";
import type { AuthorityCommand } from "../authority/transitions.ts";
import type { RunRecord } from "../broker/actor/authority-queries.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { executionCapabilities } from "../execution-pin.ts";
import type { Fields, Reply } from "../protocol.ts";
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
import { runIdentity } from "./submission-handler.ts";

interface ContinueRequest {
  readonly runId: string;
  readonly commandId: string;
  readonly from: string | null;
  readonly bundle: "retained" | "current";
}

interface Subject {
  readonly request: ContinueRequest;
  readonly run: RunRecord;
}

interface Pinned {
  readonly workflow: string;
  readonly budget: Fields;
}

const copiedFields = [
  "submission",
  "input",
  "resolver",
  "parentRunId",
  "chainId",
] as const;

function continueRequest(parameters: Fields): ContinueRequest | undefined {
  const { runId, commandId } = parameters;
  const from = parameters["from"] ?? null;
  const bundle = parameters["bundle"] ?? "retained";
  if (!isIdentifier(runId) || !isIdentifier(commandId)) return undefined;
  if (from !== null && typeof from !== "string") return undefined;
  if (bundle !== "retained" && bundle !== "current") return undefined;
  return { runId, commandId, from, bundle };
}

function requestDigest(request: ContinueRequest): string {
  return documentDigest(
    JSON.stringify({
      runId: request.runId,
      from: request.from,
      bundle: request.bundle,
    }),
  );
}

function identity(request: ContinueRequest): Fields {
  return { commandId: request.commandId, runId: request.runId };
}

async function statusRefusal(
  context: ServiceContext,
  subject: Subject,
): Promise<Reply | undefined> {
  const { run, request } = subject;
  if (run.status === "failed") return undefined;
  if (run.status === "cancelled")
    return failed("run-cancelled", {
      ...identity(request),
      detail: "A person dropped the run. A dropped run cannot continue.",
    });
  if (run.status !== "completed")
    return failed("run-active", {
      ...identity(request),
      detail: "The run is active. Only a failed or blocked run can continue.",
    });
  const completion = await context.authority.queries.latestCompletion({
    runId: run.runId,
    atOrBefore: run.sequence,
  });
  if (completion?.payload["outcome"] === "blocked") return undefined;
  return failed("run-not-blocked", {
    ...identity(request),
    detail: "The run completed. Only a failed or blocked run can continue.",
  });
}

async function continuedRefusal(
  context: ServiceContext,
  request: ContinueRequest,
): Promise<Reply | undefined> {
  const origins = await context.authority.queries.runOrigins();
  const continuedBy = Object.entries(origins).find(
    ([, origin]) => origin.continuedFrom === request.runId,
  )?.[0];
  if (continuedBy === undefined) return undefined;
  return failed("run-already-continued", {
    ...identity(request),
    continuedBy,
    detail: `The run ${continuedBy} already continues this run.`,
  });
}

function budgetOf(limit: {
  readonly effectLimit?: number | undefined;
  readonly capabilities?: string | undefined;
}): Fields {
  if (limit.effectLimit === undefined) return {};
  return { effectLimit: limit.effectLimit, capabilities: limit.capabilities };
}

function unavailable(request: ContinueRequest): Reply {
  return failed("pinned-workflow-unavailable", {
    ...identity(request),
    detail:
      "The workflow bundle of the run is not kept. Use --bundle current to continue with the current workflow.",
  });
}

async function pinnedWorkflow(
  context: ServiceContext,
  subject: {
    readonly request: ContinueRequest;
    readonly command: AuthorityCommand;
  },
): Promise<Pinned | Reply> {
  const { request, command } = subject;
  const manifest = await context.authority.queries.manifest(request.runId);
  if (manifest === undefined) return unavailable(request);
  if (request.bundle === "retained")
    return (await context.registry.available(manifest)) === undefined
      ? unavailable(request)
      : { workflow: String(command.workflow), budget: budgetOf(command) };
  const workflowId =
    (await context.authority.queries.workflowIds([request.runId]))[
      request.runId
    ] ?? manifest.workflowId;
  const current = context.registry.byId(workflowId);
  if (current?.availability !== "available")
    return failed("workflow-unavailable", {
      ...identity(request),
      detail: `The workflow ${workflowId} is not available.`,
    });
  return {
    workflow: current.pin,
    budget: budgetOf({
      effectLimit: current.effectLimit,
      capabilities: executionCapabilities(current.manifest),
    }),
  };
}

function copied(command: AuthorityCommand): Fields {
  return Object.fromEntries(
    copiedFields
      .map((name) => [name, command[name]] as const)
      .filter(([, value]) => value !== undefined),
  );
}

async function admitted(
  context: ServiceContext,
  admission: { readonly request: ContinueRequest; readonly command: Fields },
): Promise<Reply> {
  const { request, command } = admission;
  const receipt = await context.gateway.execute({
    principal: "operator",
    command,
  });
  if (!committed(receipt)) return rejection(receipt, identity(request));
  const stored = await context.authority.queries.receipt(request.commandId);
  if (stored === undefined)
    return failed("authority-unavailable", identity(request));
  return result("run-continued", {
    runId: stored.runId,
    continuedFrom: request.runId,
    commandId: request.commandId,
    replayed: receipt.kind === "duplicate",
    reuseBefore: command["reuseBefore"],
    receipt: publicReceipt(stored),
  });
}

async function continued(
  context: ServiceContext,
  subject: Subject & { readonly command: AuthorityCommand },
): Promise<Reply> {
  const { request, command } = subject;
  const pinned = await pinnedWorkflow(context, { request, command });
  if (!("workflow" in pinned)) return pinned;
  const start = continuationStart(
    await context.authority.effects.operations(request.runId),
    request.from,
  );
  if (start.kind === "refused")
    return failed(start.reason, {
      ...identity(request),
      detail: "The run has no step to continue from. Name a step with --from.",
    });
  return admitted(context, {
    request,
    command: {
      kind: "admit-run",
      commandId: request.commandId,
      runId: runIdentity(request.commandId),
      workflow: pinned.workflow,
      ...copied(command),
      ...pinned.budget,
      continuedFrom: request.runId,
      reuseBefore: start.reuseBefore,
      continueRequest: requestDigest(request),
    },
  });
}

async function replayedContinuation(
  context: ServiceContext,
  request: ContinueRequest,
): Promise<Reply | undefined> {
  const existing = await context.authority.queries.receipt(request.commandId);
  if (existing === undefined) return undefined;
  if (existing.command.continueRequest !== requestDigest(request))
    return failed("conflicting-command", {
      commandId: request.commandId,
      detail: "The command ID is known with a different request.",
    });
  return result("run-continued", {
    runId: existing.runId,
    continuedFrom: request.runId,
    commandId: request.commandId,
    replayed: true,
    reuseBefore: existing.command.reuseBefore,
    receipt: publicReceipt(existing),
  });
}

export async function continueRun(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const request = continueRequest(parameters);
  if (request === undefined)
    return invalidRequest("The continue request is not valid.");
  const replayed = await replayedContinuation(context, request);
  if (replayed !== undefined) return replayed;
  const run = await context.authority.queries.run(request.runId);
  if (run === undefined)
    return failed("unknown-run", {
      ...identity(request),
      detail: `No run has the ID ${request.runId}.`,
    });
  const refused =
    (await statusRefusal(context, { request, run })) ??
    (await continuedRefusal(context, request));
  if (refused !== undefined) return refused;
  const admission =
    run.admissionCommandId === null
      ? undefined
      : await context.authority.queries.receipt(run.admissionCommandId);
  if (admission === undefined) return unavailable(request);
  return continued(context, { request, run, command: admission.command });
}
