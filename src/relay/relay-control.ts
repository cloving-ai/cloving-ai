import { follow, send } from "../cli/client.ts";
import type { Fields, Reply, ServiceRequest } from "../protocol.ts";

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

export function relayEvents(
  runtimeDirectory: string,
  stream: {
    readonly after: number;
    readonly onEvent: (event: Fields) => void;
    readonly stopped: Promise<void>;
  },
): Promise<Reply> {
  return follow(runtimeDirectory, {
    request: {
      operation: "events",
      parameters: { after: stream.after, follow: true },
    },
    onEvent: stream.onEvent,
    signal: stream.stopped,
  });
}
