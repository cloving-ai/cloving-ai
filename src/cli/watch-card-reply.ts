import type { Reply } from "../protocol.ts";

export function cardReply(reply: Reply): {
  readonly admitted: boolean;
  readonly message: string;
} {
  if (reply.kind === "result")
    return {
      admitted: true,
      message: `Run ${String(reply.result["runId"])} is admitted`,
    };
  const explanations: Readonly<Record<string, string>> = {
    "workflow-active":
      "Add the label cloving: ready to the issue to put it in the queue.",
    "unknown-workflow":
      "This workflow is no longer registered. Refresh the page.",
    "workflow-unavailable": "A required workflow capability is unavailable.",
    "invalid-submission": "Check the workflow fields.",
    "input-too-large": "Shorten the input and try again.",
    "invalid-request": "The service could not read this run request.",
    "conflicting-command":
      "This form was already sent with different fields. Open a new form.",
    "service-unavailable": "Start the Cloving service and retry this form.",
    "authority-unavailable":
      "The service authority is unavailable. Retry this form later.",
    "permission-denied": "The service refused access to this account.",
    "outcome-unknown":
      "The reply was lost. Retry this form with the same command ID.",
    "resolver-timeout": "The input resolver timed out. Retry this form.",
    "resolver-failure":
      "The input resolver failed. Check the service before retrying.",
    "invalid-ticket-id": "Enter a valid issue number or ticket ID.",
    "ticket-source-not-configured":
      "Configure the daemon ticket command first.",
    "ticket-not-available": "The ticket could not be read.",
    "next-source-not-configured":
      "Configure the daemon next-ticket command first.",
    "next-ticket-not-available": "The next ticket could not be read.",
    "no-ready-ticket": "There is no ready ticket in the queue.",
    "unsupported-prompt": "This workflow requires declared input fields.",
  };
  const { code } = reply.error;
  return {
    admitted: false,
    message: `${code}: ${explanations[code] ?? "The service refused this run."}`,
  };
}
