import { record, type Reply } from "../protocol.ts";
import { mutate, send } from "./client.ts";
import {
  identified,
  presented,
  type OutputEnvironment,
} from "./command-output.ts";
import {
  queueServiceRequest,
  type QueueInvocation,
} from "./queue-arguments.ts";

export async function queueCommand(
  environment: OutputEnvironment & {
    readonly runtimeDirectory: string;
    readonly interrupted: () => Promise<void>;
  },
  invocation: QueueInvocation,
): Promise<number> {
  const { runtimeDirectory } = environment;
  if (invocation.action === "show")
    return presented(environment, {
      format: { json: invocation.json },
      reply: await send(runtimeDirectory, queueServiceRequest(invocation, "")),
    });
  const format = identified(environment, invocation);
  const selected = await selectedInvocation(runtimeDirectory, invocation);
  if ("refusal" in selected)
    return presented(environment, { format, reply: selected.refusal });
  const reply = await mutate(runtimeDirectory, {
    request: queueServiceRequest(selected.invocation, format.commandId),
    signal: environment.interrupted(),
  });
  return presented(environment, { format, reply });
}

async function selectedInvocation(
  runtimeDirectory: string,
  invocation: QueueInvocation,
): Promise<
  { readonly invocation: QueueInvocation } | { readonly refusal: Reply }
> {
  if (invocation.action !== "lanes") return { invocation };
  const status = await send(runtimeDirectory, {
    operation: "queue",
    parameters: { workflowId: invocation.workflowId },
  });
  if (status.kind === "error") return { refusal: status };
  const expectedLanes = record(status.result["queue"])?.["lanes"];
  if (typeof expectedLanes !== "number")
    return {
      refusal: {
        kind: "error",
        error: {
          code: "queue-unavailable",
          detail: "The service gave no queue lane count.",
        },
      },
    };
  return { invocation: { ...invocation, expectedLanes } };
}
