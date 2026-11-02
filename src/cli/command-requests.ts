import {
  type Fields,
  type Reply,
  type ServiceError,
  type ServiceRequest,
} from "../protocol.ts";
import { send } from "./client.ts";
import { withCiReruns } from "./github-ci-progress.ts";
import { statusJson } from "./render.ts";

export interface ReadCommand {
  readonly kind: "status" | "questions" | "events";
  readonly runId?: string | null;
  readonly limit?: number | null;
  readonly after?: string | number | null;
  readonly follow?: boolean;
}

export function readCommandRequest(command: ReadCommand): ServiceRequest {
  const { kind, runId, limit, after, follow } = command;
  const parameters =
    kind === "questions"
      ? { runId }
      : { runId, limit, after, ...(follow === undefined ? {} : { follow }) };
  return {
    operation: kind,
    parameters: Object.fromEntries(
      Object.entries(parameters).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    ),
  };
}

export async function readCommandReply(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Reply> {
  const reply = await send(runtimeDirectory, request);
  return request.operation === "status"
    ? await withCiReruns(runtimeDirectory, reply)
    : reply;
}

export function errorObject(
  error: ServiceError,
  format: { readonly commandId?: string } = {},
): Fields {
  if (error.code === "event-gap")
    return {
      schemaVersion: 1,
      kind: "event-gap",
      after: error["after"],
      earliestAvailable: error["earliestAvailable"],
      latestSequence: error["latestSequence"],
    };
  return {
    schemaVersion: 1,
    kind: "error",
    ...error,
    commandId: error["commandId"] ?? format.commandId ?? null,
    runId: error["runId"] ?? null,
    currentRevision: error["currentRevision"] ?? null,
  };
}

export function commandJson(
  reply: Reply,
  format: { readonly commandId?: string } = {},
): Fields {
  return reply.kind === "error"
    ? errorObject(reply.error, format)
    : statusJson(reply.result);
}
