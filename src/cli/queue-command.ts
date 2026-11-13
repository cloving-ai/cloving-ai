import { record } from "../protocol.ts";
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
  let selected = invocation;
  if (invocation.action === "lanes") {
    const status = await send(runtimeDirectory, {
      operation: "queue",
      parameters: { workflowId: invocation.workflowId },
    });
    if (status.kind === "error")
      return presented(environment, { format, reply: status });
    const expectedLanes = record(status.result["queue"])?.["lanes"];
    if (typeof expectedLanes !== "number")
      return presented(environment, {
        format,
        reply: {
          kind: "error",
          error: {
            code: "queue-unavailable",
            detail: "The service gave no queue lane count.",
          },
        },
      });
    selected = { ...invocation, expectedLanes };
  }
  const reply = await mutate(runtimeDirectory, {
    request: queueServiceRequest(selected, format.commandId),
    signal: environment.interrupted(),
  });
  return presented(environment, { format, reply });
}
