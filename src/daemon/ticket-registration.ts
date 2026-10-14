import { createHash } from "node:crypto";
import { admitCompiled } from "../cli/validate.ts";
import type {
  Resolution,
  ResolutionRequest,
  Resolver,
  WorkflowRegistration,
} from "../service/registry.ts";
import { ticketText } from "./ticket-source.ts";

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
}

async function ticket(
  source: TicketSource,
  request: ResolutionRequest,
): Promise<Resolution> {
  const { command, repository } = source;
  const ticketId = String(request.submission["ticket"]);
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

export async function ticketRegistrations(
  manifest: string,
  source: TicketSource,
): Promise<TicketRegistrations> {
  const admission = await admitCompiled(manifest, {
    file: manifest,
    capabilities: ticketCapabilities,
  });
  if (admission.kind === "rejected")
    return {
      kind: "rejected",
      detail: `${admission.error.code}: ${admission.error.detail}`,
    };
  const shared = {
    manifest: admission.manifest,
    availability: "available" as const,
    effectLimit: 8,
  };
  return {
    kind: "admitted",
    registrations: [
      {
        ...shared,
        workflowId: ticketWorkflow,
        submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
        resolver: ticketResolver(source),
      },
      {
        ...shared,
        workflowId: issueWorkflow,
        effectLimit: 16,
        submission: { maximumBytes: 4_096, fields: { ticket: "string" } },
        resolver: issueResolver(source),
      },
      {
        ...shared,
        workflowId: promptWorkflow,
        submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
        resolver: promptResolver(source.repository),
      },
    ],
  };
}
