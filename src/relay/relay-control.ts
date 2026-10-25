import { send } from "../cli/client.ts";
import type { Reply, ServiceRequest } from "../protocol.ts";

const allowed: ReadonlySet<string> = new Set([
  "questions",
  "status",
  "events",
  "decision",
]);

export function relayControl(
  runtimeDirectory: string,
): (request: ServiceRequest) => Promise<Reply> {
  return (request) => {
    if (!allowed.has(request.operation))
      return Promise.reject(
        new Error(
          `relay-operation-refused: The phone relay may not send ${request.operation}.`,
        ),
      );
    return send(runtimeDirectory, request);
  };
}
