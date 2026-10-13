import { createHash } from "node:crypto";
import { admitCompiled } from "../cli/validate.ts";
import type {
  Resolution,
  ResolutionRequest,
  WorkflowRegistration,
} from "../service/registry.ts";

export const ticketWorkflow = "develop-ticket";
export const ticketCapabilities = ["claude"];

export type TicketRegistration =
  | { readonly kind: "admitted"; readonly registration: WorkflowRegistration }
  | { readonly kind: "rejected"; readonly detail: string };

function resolved(request: ResolutionRequest): Resolution {
  const digest = createHash("sha256").update(request.commandId).digest("hex");
  return {
    kind: "resolved",
    input: {
      cycleId: `ticket-${digest.slice(0, 12)}`,
      ticket: String(request.submission["prompt"]),
    },
  };
}

export async function ticketRegistration(
  manifest: string,
): Promise<TicketRegistration> {
  const admission = await admitCompiled(manifest, {
    file: manifest,
    capabilities: ticketCapabilities,
  });
  if (admission.kind === "rejected")
    return {
      kind: "rejected",
      detail: `${admission.error.code}: ${admission.error.detail}`,
    };
  return {
    kind: "admitted",
    registration: {
      workflowId: ticketWorkflow,
      manifest: admission.manifest,
      availability: "available",
      submission: { maximumBytes: 65_536, fields: { prompt: "string" } },
      resolver: {
        id: "ticket-prompt",
        version: "1",
        resolve: (request) => Promise.resolve(resolved(request)),
      },
      effectLimit: 8,
    },
  };
}
