import { createHash } from "node:crypto";
import { admitCompiled } from "../cli/validate.ts";
import {
  workflowQueueRefusals,
  type DeclaredWorkflow,
  type WorkflowStage,
} from "../workflow-declaration.ts";
import type {
  Resolution,
  ResolutionRequest,
  Resolver,
  WorkflowRegistration,
} from "../service/registry.ts";
import { ticketCommandText, ticketText } from "./ticket-source.ts";
import { bundledWorkflowIds } from "../workflow-discovery.ts";
import { declaredManifest } from "../execution-pin.ts";
import { record } from "../protocol.ts";
import { hasTicketField, type SubmissionContract } from "../submission.ts";
import type { LocalCommands } from "../command-settings.ts";
import { issueIdentity } from "../issue-identity.ts";
import {
  ticketDependencyWaits,
  TicketDependencyReadError,
} from "./ticket-dependency-waits.ts";

export const ticketWorkflow = bundledWorkflowIds.ticket;
export const promptWorkflow = bundledWorkflowIds.prompt;
export const issueWorkflow = bundledWorkflowIds.issue;
export const ticketCapabilities = ["claude", "github"];

const ticketIdentifier = /^[A-Za-z0-9._:-]{1,64}$/;

export type TicketRegistrations =
  | {
      readonly kind: "admitted";
      readonly registrations: readonly WorkflowRegistration[];
    }
  | { readonly kind: "rejected"; readonly detail: string };

function rejected(code: string, detail: string): Resolution {
  return { kind: "rejected", code, detail };
}

function digest(commandId: string): string {
  return createHash("sha256").update(commandId).digest("hex");
}

export interface TicketSource {
  readonly repository: string;
  readonly command: readonly string[] | undefined;
  readonly nextCommand?: readonly string[] | undefined;
  readonly githubCommand?: readonly string[] | undefined;
  readonly skipTickets?: readonly string[];
}

export interface TicketRegistration {
  readonly queue?: boolean;
  readonly workflowId: string;
  readonly functionName: string;
  readonly resolver: Resolver;
  readonly submission: WorkflowRegistration["submission"];
  readonly effectLimit: number;
  readonly capabilities?: readonly string[];
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
  readonly commands?: readonly string[];
}

async function ticket(
  source: TicketSource,
  request: ResolutionRequest,
): Promise<Resolution> {
  const { command, repository } = source;
  const ticketId = String(request.submission["ticket"]);
  if (ticketId === "next") return nextTicket(source, request);
  if (!ticketIdentifier.test(ticketId))
    return rejected(
      "invalid-ticket-id",
      "A ticket ID has letters, digits and the characters . _ : - only.",
    );
  if (command === undefined)
    return rejected(
      "ticket-source-not-configured",
      "The daemon has no ticket command. Set CLOVING_TICKET_COMMAND, or use the workflow develop-prompt.",
    );
  const read = await ticketText(command, { ticketId, signal: request.signal });
  if (read.kind === "failed")
    return rejected("ticket-not-available", read.detail);
  const name = ticketId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    kind: "resolved",
    input: {
      cycleId: `${name}-${digest(request.commandId).slice(0, 8)}`,
      ticketId,
      ticket: read.text,
      repository,
    },
  };
}

async function nextTicket(
  source: TicketSource,
  request: ResolutionRequest,
): Promise<Resolution> {
  if (source.nextCommand === undefined)
    return rejected(
      "next-source-not-configured",
      "The daemon has no next-ticket command. Set CLOVING_NEXT_COMMAND.",
    );
  const selected = await ticketCommandText(source.nextCommand, {
    signal: request.signal,
    skipTickets: [
      ...new Set([
        ...(request.activeTickets ?? []).flatMap((input) =>
          typeof input["ticketId"] === "string" ? [input["ticketId"]] : [],
        ),
        ...(source.skipTickets ?? []),
      ]),
    ].sort(),
  });
  if (selected.kind === "failed")
    return rejected("next-ticket-not-available", selected.detail);
  if (selected.text === "")
    return rejected(
      "no-ready-ticket",
      "The next-ticket command printed no ticket ID.",
    );
  if (!ticketIdentifier.test(selected.text) || selected.text === "next")
    return rejected(
      "invalid-ticket-id",
      "The next-ticket command must print one valid ticket ID other than next.",
    );
  return ticket(source, { ...request, submission: { ticket: selected.text } });
}

export function ticketResolver(source: TicketSource): Resolver {
  return {
    id: "ticket-command",
    version: "1",
    resolve: (request) => ticket(source, request),
  };
}

export function issueResolver(source: TicketSource): Resolver {
  const waits = ticketDependencyWaits(source);
  return {
    id: "issue-command",
    version: "1",
    skippedTickets: waits.skipped,
    resolve: (request) =>
      issueTicket({ source, waits }, request).catch((error: unknown) => {
        if (!(error instanceof TicketDependencyReadError)) throw error;
        return rejected(
          "ticket-not-available",
          "The ticket dependencies could not be read. Retry this command.",
        );
      }),
  };
}

async function issueTicket(
  context: {
    readonly source: TicketSource;
    readonly waits: ReturnType<typeof ticketDependencyWaits>;
  },
  request: ResolutionRequest,
): Promise<Resolution> {
  const { source, waits } = context;
  const skipTickets =
    request.submission["ticket"] === "next"
      ? await waits.refresh(request.signal)
      : [];
  const resolution = await ticket({ ...source, skipTickets }, request);
  if (resolution.kind === "rejected") return resolution;
  const input = record(resolution.input) ?? {};
  const identity = issueIdentity(input["ticket"]);
  if (
    (request.activeTickets ?? []).some(
      (active) =>
        active["ticketId"] === input["ticketId"] ||
        (identity !== null &&
          JSON.stringify(issueIdentity(active["ticket"])) ===
            JSON.stringify(identity)),
    )
  )
    return rejected(
      "ticket-active",
      "An active run already works on this ticket.",
    );
  const dependencies = await waits.check({
    ticketId: String(input["ticketId"]),
    ticket: String(input["ticket"]),
    signal: request.signal,
  });
  if (dependencies.length > 0)
    return rejected(
      "ticket-dependency-open",
      `Ticket ${String(input["ticketId"])} needs open issues: ${dependencies.map((id) => `#${id}`).join(", ")}.`,
    );
  return {
    kind: "resolved",
    input: { ...input, delivery: "pull-request" },
  };
}

export function promptResolver(repository: string): Resolver {
  return {
    id: "ticket-prompt",
    version: "1",
    resolve: (request) =>
      Promise.resolve({
        kind: "resolved",
        input: {
          cycleId: `task-${digest(request.commandId).slice(0, 12)}`,
          ticket: String(request.submission["prompt"]),
          repository,
        },
      }),
  };
}

export function ticketRegistrationTable(
  source: TicketSource,
  declarations: readonly DeclaredWorkflow[] = [],
): readonly TicketRegistration[] {
  return [
    {
      workflowId: ticketWorkflow,
      functionName: "developTicket",
      effectLimit: 8,
      handoffs: [],
      submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
      resolver: ticketResolver(source),
    },
    {
      workflowId: issueWorkflow,
      functionName: "developTicket",
      effectLimit: 20,
      handoffs: [],
      submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
      resolver: issueResolver(source),
    },
    {
      workflowId: bundledWorkflowIds.prd,
      functionName: "developPrd",
      effectLimit: 8,
      handoffs: [issueWorkflow],
      submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
      resolver: promptResolver(source.repository),
    },
    {
      workflowId: promptWorkflow,
      functionName: "developTicket",
      effectLimit: 8,
      handoffs: [],
      submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
      resolver: promptResolver(source.repository),
    },
    ...declarations.map((declaration) => ({
      ...(declaration.queue === undefined ? {} : { queue: declaration.queue }),
      workflowId: declaration.workflowId,
      functionName: declaration.functionName,
      effectLimit: declaration.effectLimit,
      capabilities: declaration.capabilities,
      ...(declaration.commands === undefined
        ? {}
        : { commands: declaration.commands }),
      submission: declaration.input,
      ...(declaration.stages === undefined
        ? {}
        : { stages: declaration.stages }),
      ...(declaration.handoffs === undefined
        ? {}
        : { handoffs: declaration.handoffs }),
      resolver: declaredResolver(source, declaration.input),
    })),
  ];
}

function declaredResolver(
  source: TicketSource,
  contract: SubmissionContract,
): Resolver {
  const tickets = hasTicketField(contract) ? issueResolver(source) : undefined;
  return {
    id: "declared-input",
    version: "1",
    ...(tickets?.skippedTickets === undefined
      ? {}
      : { skippedTickets: tickets.skippedTickets }),
    resolve: async (request) => {
      const resolution =
        tickets !== undefined && Object.hasOwn(request.submission, "ticket")
          ? await tickets.resolve(request)
          : undefined;
      if (resolution?.kind === "rejected") return resolution;
      const ticket =
        resolution === undefined ? undefined : (record(resolution.input) ?? {});
      const input =
        ticket === undefined
          ? request.submission
          : {
              ...request.submission,
              ticket: { id: ticket["ticketId"], text: ticket["ticket"] },
            };
      return {
        kind: "resolved",
        input: {
          cycleId: `task-${digest(request.commandId).slice(0, 12)}`,
          repository: source.repository,
          input,
        },
      };
    },
  };
}

export async function ticketRegistrations(
  manifests: Readonly<Record<string, string | undefined>>,
  options: {
    readonly table: readonly TicketRegistration[];
    readonly bundleDigest?: string;
    readonly commands?: LocalCommands;
  },
): Promise<TicketRegistrations> {
  const refusal = registrationRefusal(options.table, options.commands ?? {});
  if (refusal !== undefined) return { kind: "rejected", detail: refusal };
  const registrations: WorkflowRegistration[] = [];
  for (const row of options.table) {
    const {
      functionName,
      capabilities = ticketCapabilities,
      ...registration
    } = row;
    const manifest = manifests[functionName];
    if (manifest === undefined)
      return {
        kind: "rejected",
        detail: `Missing manifest for workflow function ${functionName}.`,
      };
    const admission = await admitCompiled(manifest, {
      file: manifest,
      capabilities,
    });
    if (admission.kind === "rejected")
      return {
        kind: "rejected",
        detail: `${admission.error.code}: ${admission.error.detail}`,
      };
    registrations.push({
      ...registration,
      manifest: declaredManifest(admission.manifest, {
        ...row,
        bundleDigest: options.bundleDigest,
      }),
      availability: "available",
    });
  }
  return { kind: "admitted", registrations };
}

function registrationRefusal(
  table: readonly TicketRegistration[],
  commands: LocalCommands,
): string | undefined {
  const queueRefusal = queueRegistrationRefusal(table);
  if (queueRefusal !== undefined) return queueRefusal;
  const ids = new Set<string>();
  for (const row of table) {
    if (ids.has(row.workflowId))
      return `duplicate-workflow-id: ${row.workflowId}`;
    ids.add(row.workflowId);
  }
  for (const row of table) {
    const unknown = row.handoffs?.find((target) => !ids.has(target));
    if (unknown !== undefined)
      return `unknown-handoff-target: ${row.workflowId} -> ${unknown}`;
  }
  for (const row of table) {
    const unknown = row.commands?.find(
      (name) => !Object.hasOwn(commands, name),
    );
    if (unknown !== undefined)
      return `command-unknown: ${row.workflowId} -> ${unknown}`;
  }
  return undefined;
}

function queueRegistrationRefusal(
  table: readonly TicketRegistration[],
): string | undefined {
  const queued = table.filter((row) => row.queue === true);
  if (queued.length > 1)
    return `queue-workflow-conflict: ${queued.map((row) => row.workflowId).join(", ")}`;
  for (const row of queued) {
    const codes = workflowQueueRefusals({ queue: true, input: row.submission });
    if (codes.length > 0) return `${codes.join(", ")}: ${row.workflowId}`;
  }
  return undefined;
}
