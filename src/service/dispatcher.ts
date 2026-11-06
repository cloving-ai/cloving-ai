import type { Reply, ServiceRequest } from "../protocol.ts";
import { continueRun } from "./continue-handler.ts";
import { decision, questions } from "./decision-handler.ts";
import { events, type Connection } from "./event-handler.ts";
import { queueCommand, queueRead } from "./queue-handlers.ts";
import { failed, scheduleRequest, type ServiceContext } from "./replies.ts";
import { runCommand, status } from "./run-handlers.ts";
import { submissionHandler } from "./submission-handler.ts";
import { reloadUnavailable } from "./workflow-reload.ts";

export function dispatcher(
  context: ServiceContext,
): (
  request: ServiceRequest,
  connection: Connection,
) => Promise<Reply | undefined> {
  const run = submissionHandler(context);
  const operations = new Map<
    string,
    (
      request: ServiceRequest,
      connection: Connection,
    ) => Promise<Reply | undefined>
  >([
    ["run", (request) => run(request.parameters)],
    ["schedule", (request) => scheduleRequest(context, request.parameters)],
    ["queue", () => queueRead(context)],
    ["queue-command", (request) => queueCommand(context, request.parameters)],
    ["status", (request) => status(context, request.parameters)],
    ["questions", (request) => questions(context, request.parameters)],
    ["decision", (request) => decision(context, request.parameters)],
    ["run-command", (request) => runCommand(context, request.parameters)],
    ["continue-run", (request) => continueRun(context, request.parameters)],
    ["reload", () => context.reload?.() ?? reloadUnavailable()],
    [
      "events",
      (request, connection) =>
        events(context, { parameters: request.parameters, connection }),
    ],
  ]);
  return (request, connection) => {
    const operation = operations.get(request.operation);
    if (operation === undefined)
      return Promise.resolve(
        failed("unknown-operation", {
          detail: `The service has no operation ${request.operation}.`,
        }),
      );
    return operation(request, connection);
  };
}
