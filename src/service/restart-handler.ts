import { terminal } from "../authority/transitions.ts";
import type { Fields, Reply } from "../protocol.ts";
import { isRestartTime, type RestartMark } from "../restart-request.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  type ServiceContext,
} from "./replies.ts";

async function activeRuns(context: ServiceContext): Promise<number> {
  const state = await context.authority.state();
  return Object.values(state.runs).filter(
    (run) => !terminal.includes(run.status),
  ).length;
}

async function pendingFields(
  context: ServiceContext,
  mark: RestartMark,
): Promise<Fields> {
  return { ...mark, activeRuns: await activeRuns(context) };
}

function identityFields(context: ServiceContext): Fields {
  return {
    ...(context.version === undefined
      ? {}
      : { serviceVersion: context.version }),
    ...(context.commit === undefined ? {} : { serviceCommit: context.commit }),
    ...(context.startedAt === undefined
      ? {}
      : { serviceStartedAt: context.startedAt }),
  };
}

export async function restartFields(context: ServiceContext): Promise<Fields> {
  const mark = await context.restart?.pending();
  return {
    ...identityFields(context),
    ...(context.restart === undefined
      ? {}
      : {
          restart:
            mark === undefined ? null : await pendingFields(context, mark),
        }),
  };
}

function optionalTrue(value: unknown): boolean {
  return value === undefined || value === true;
}

export async function restartOperation(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { at, commandId, cancel, resumeQueue } = parameters;
  if (
    !isIdentifier(commandId) ||
    !optionalTrue(cancel) ||
    !optionalTrue(resumeQueue)
  )
    return invalidRequest("The restart request is not valid.");
  const port = context.restart;
  if (port === undefined || context.startedAt === undefined)
    return failed("restart-unavailable", {
      commandId,
      detail: "The service cannot restart. Start it with cloving start.",
    });
  if (cancel === true)
    return result("restart", { restart: { state: await port.cancel() } });
  if (!isRestartTime(at))
    return invalidRequest("A restart needs --at gap or --at now.");
  const mark: RestartMark = {
    at,
    requestedAt: Date.now(),
    commandId,
    resumeQueue: resumeQueue === true,
  };
  await port.request(mark);
  return result("restart", {
    ...identityFields(context),
    restart: { state: "pending", ...(await pendingFields(context, mark)) },
  });
}
