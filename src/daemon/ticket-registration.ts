import { createHash } from "node:crypto";
import { admitCompiled } from "../cli/validate.ts";
import type {
  Resolution,
  ResolutionRequest,
  Resolver,
  WorkflowRegistration,
} from "../service/registry.ts";
import { ticketCommandText, ticketText } from "./ticket-source.ts";

export const ticketWorkflow = "develop-ticket";
export const promptWorkflow = "develop-prompt";
export const issueWorkflow = "develop-issue";
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
}

export interface TicketRegistration {
  readonly workflowId: string;
  readonly functionName: string;
  readonly resolver: Resolver;
  readonly submission: WorkflowRegistration["submission"];
  readonly effectLimit: number;
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
  const selected = await ticketCommandText(source.nextCommand, request.signal);
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
  return {
    id: "issue-command",
    version: "1",
    resolve: async (request) => {
      const resolution = await ticket(source, request);
      if (resolution.kind === "rejected") return resolution;
      return {
        kind: "resolved",
        input: { ...Object(resolution.input), delivery: "pull-request" },
      };
    },
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
): readonly TicketRegistration[] {
  return [
    {
      workflowId: ticketWorkflow,
      functionName: "developTicket",
      effectLimit: 8,
      submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
      resolver: ticketResolver(source),
    },
    {
      workflowId: issueWorkflow,
      functionName: "developTicket",
      effectLimit: 17,
      submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
      resolver: issueResolver(source),
    },
    {
      workflowId: "develop-prd",
      functionName: "developPrd",
      effectLimit: 8,
      submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
      resolver: promptResolver(source.repository),
    },
    {
      workflowId: promptWorkflow,
      functionName: "developTicket",
      effectLimit: 8,
      submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
      resolver: promptResolver(source.repository),
    },
  ];
}

export async function ticketRegistrations(
  manifests: Readonly<Record<string, string | undefined>>,
  options: { readonly table: readonly TicketRegistration[] },
): Promise<TicketRegistrations> {
  const registrations: WorkflowRegistration[] = [];
  for (const row of options.table) {
    const manifest = manifests[row.functionName];
    if (manifest === undefined)
      return {
        kind: "rejected",
        detail: `Missing manifest for workflow function ${row.functionName}.`,
      };
    const admission = await admitCompiled(manifest, {
      file: manifest,
      capabilities: ticketCapabilities,
    });
    if (admission.kind === "rejected")
      return {
        kind: "rejected",
        detail: `${admission.error.code}: ${admission.error.detail}`,
      };
    registrations.push({
      workflowId: row.workflowId,
      manifest: admission.manifest,
      availability: "available",
      effectLimit: row.effectLimit,
      submission: row.submission,
      resolver: row.resolver,
    });
  }
  return { kind: "admitted", registrations };
}
