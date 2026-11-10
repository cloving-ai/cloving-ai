import type { Reply, ServiceRequest } from "../protocol.ts";
import { continueHandler } from "./continue-handler.ts";
import { decision, questions } from "./decision-handler.ts";
import { dismissRun } from "./dismiss-handler.ts";
import { events, type Connection } from "./event-handler.ts";
import { queueCommand, queueRead } from "./queue-handlers.ts";
import { failed, type ServiceContext } from "./replies.ts";
import { renameRun } from "./rename-handler.ts";
import { restartOperation } from "./restart-handler.ts";
import { runCommand, status } from "./run-handlers.ts";
import { spendRead } from "./queue-spend.ts";
import { steerRun } from "./steer-handler.ts";
import { scheduleHandler } from "./schedule-run.ts";
import { transcript } from "./transcript-handler.ts";
import { admissionLock, submissionHandler } from "./submission-handler.ts";
import { reloadUnavailable } from "./workflow-reload.ts";

export function dispatcher(
  context: ServiceContext,
): (
  request: ServiceRequest,
  connection: Connection,
) => Promise<Reply | undefined> {
  const lock = admissionLock();
  const run = submissionHandler(context, lock);
  const continued = continueHandler(context, lock);
  const schedule = scheduleHandler(context, lock);
  const operations = new Map<
    string,
    (
      request: ServiceRequest,
      connection: Connection,
    ) => Promise<Reply | undefined>
  >([
    ["run", (request) => run(request.parameters)],
    ["schedule", (request) => schedule(request.parameters)],
    ["queue", () => queueRead(context)],
    ["spend", () => spendRead(context)],
    ["queue-command", (request) => queueCommand(context, request.parameters)],
    ["status", (request) => status(context, request.parameters)],
    ["questions", (request) => questions(context, request.parameters)],
    ["decision", (request) => decision(context, request.parameters)],
    ["run-command", (request) => runCommand(context, request.parameters)],
    ["continue-run", (request) => continued(request.parameters)],
    ["dismiss-run", (request) => dismissRun(context, request.parameters)],
    ["steer-run", (request) => steerRun(context, request.parameters)],
    ["rename-run", (request) => renameRun(context, request.parameters)],
    ["transcript", (request) => transcript(context, request.parameters)],
    ["reload", () => context.reload?.() ?? reloadUnavailable()],
    ["restart", (request) => restartOperation(context, request.parameters)],
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
