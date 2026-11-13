import {
  checkSubmission,
  hasTicketField,
  type SubmissionCheck,
  type SubmissionRequest,
} from "../submission.ts";
import type { Registered } from "./registry.ts";

export function workflowSubmission(
  workflow: Registered,
  request: SubmissionRequest & { readonly documentBytes: number },
): SubmissionCheck {
  const contract = workflow.submission;
  if (
    request.source === "feed" &&
    (workflow.feed === undefined ||
      workflow.manifest.queue !== true ||
      !hasTicketField(contract))
  )
    return {
      kind: "rejected",
      code: "invalid-submission",
      detail: "The workflow has no queue feed.",
    };
  return checkSubmission(
    {
      ...contract,
      maximumBytes: Math.min(contract.maximumBytes, request.documentBytes),
    },
    request,
  );
}
