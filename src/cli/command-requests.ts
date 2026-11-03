import {
  type Fields,
  type Reply,
  type ServiceError,
  type ServiceRequest,
} from "../protocol.ts";
import { send, type ClientRequest } from "./client.ts";
import { withCiReruns } from "./github-ci-progress.ts";
import { statusJson } from "./render.ts";
import type {
  DecisionCommand,
  RunCommand,
  RunSource,
} from "./runtime-arguments.ts";

export interface ReadCommand {
  readonly kind: "status" | "questions" | "events";
  readonly runId?: string | null;
  readonly limit?: number | null;
  readonly after?: string | number | null;
  readonly active?: boolean;
  readonly follow?: boolean;
}

export type SubmittedSource =
  | Exclude<RunSource, { readonly kind: "input" }>
  | { readonly kind: "input"; readonly submission: unknown };

function submission(source: SubmittedSource): unknown {
  if (source.kind === "input") return source.submission;
  return source.kind === "prompt"
    ? { prompt: source.text }
    : { ticket: source.id };
}

export function runRequest(run: {
  readonly workflowId: string;
  readonly source: SubmittedSource;
  readonly commandId: string;
}): ServiceRequest {
  return {
    operation: "run",
    parameters: {
      workflowId: run.workflowId,
      source: run.source.kind,
      submission: submission(run.source),
      commandId: run.commandId,
    },
  };
}

export interface DecisionRequest {
  readonly command: DecisionCommand;
  readonly reference: string;
  readonly text: string | null;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly subjectDigest: string;
  readonly commandId: string;
}

export function decisionRequest(decision: DecisionRequest): ServiceRequest {
  return {
    operation: "decision",
    parameters: Object.fromEntries(
      Object.entries(decision).filter(([, value]) => value !== null),
    ),
  };
}

export function runCommandRequest(request: {
  readonly command: RunCommand;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly commandId: string;
}): ServiceRequest {
  return {
    operation: "run-command",
    parameters: {
      command: request.command,
      runId: request.runId,
      expectedRevision: request.expectedRevision,
      commandId: request.commandId,
    },
  };
}

export function readCommandRequest(command: ReadCommand): ServiceRequest {
  const { kind, runId, limit, after, active, follow } = command;
  const parameters =
    kind === "questions"
      ? { runId }
      : {
          runId,
          limit,
          after,
          ...(active === true ? { active } : {}),
          ...(follow === undefined ? {} : { follow }),
        };
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
  request: ClientRequest,
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
