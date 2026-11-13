import { declaredResolver } from "../src/daemon/ticket-registration.ts";
import type { WorkflowRegistration } from "../src/service/registry.ts";
export function feedWorkflow(
  registration: WorkflowRegistration,
): WorkflowRegistration {
  const submission = {
    maximumBytes: 4096,
    fields: { ticket: { type: "ticket" as const } },
  };
  return {
    ...registration,
    queue: true,
    admission: 2,
    submission,
    feed: {
      functionName: "triageFeed",
      effectLimit: 3,
      manifest: {
        ...registration.manifest,
        workflowId: "workflow//./workflows/develop//triageFeed",
      },
    },
    resolver: declaredResolver(
      { repository: "/repository", command: undefined },
      submission,
    ),
  };
}
