import { terminal } from "../authority/transitions.ts";
import type { Fields, Reply } from "../protocol.ts";
import {
  isRestartTime,
  type RestartMark,
  type RestartTime,
} from "../restart-request.ts";
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
  const failure = await context.restart?.failure();
  return {
    ...identityFields(context),
    ...(failure === undefined ? {} : { restartFailure: { ...failure } }),
    ...(context.settingSources === undefined
      ? {}
      : { settingSources: context.settingSources }),
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

function validOptions(parameters: Fields): boolean {
  const { cancel, resumeQueue, settings, update } = parameters;
  return (
    [cancel, resumeQueue, update].every(optionalTrue) &&
    (settings === undefined || settings === "files")
  );
}

function requestedMark(
  parameters: Fields & { readonly at: RestartTime; readonly commandId: string },
): RestartMark {
  const { resumeQueue, settings, update } = parameters;
  return {
    at: parameters.at,
    requestedAt: Date.now(),
    commandId: parameters.commandId,
    resumeQueue: resumeQueue === true,
    ...(settings === "files" ? { settings: "files" } : {}),
    ...(update === true ? { update: true } : {}),
  };
}

export async function restartOperation(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { at, commandId, cancel } = parameters;
  if (!isIdentifier(commandId) || !validOptions(parameters))
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
  if (parameters["update"] === true && typeof context.commit !== "string")
    return failed("update-unavailable", {
      commandId,
      detail:
        "The product of the service is not a git checkout. Update it by hand.",
    });
  const mark = requestedMark({ ...parameters, at, commandId });
  const unresumable =
    at === "now" ? { unresumableRuns: await port.unresumable() } : {};
  await port.request(mark);
  return result("restart", {
    ...identityFields(context),
    restart: {
      state: "pending",
      ...(await pendingFields(context, mark)),
      ...unresumable,
    },
  });
}
