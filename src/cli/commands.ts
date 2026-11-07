import {
  decisionRequest,
  readCommandReply,
  readCommandRequest,
  runCommandRequest,
  runRequest,
  type SubmittedSource,
} from "./command-requests.ts";
import { reportCommand } from "./report.ts";
import { scheduleServiceRequest } from "./schedule-arguments.ts";
import { queueServiceRequest } from "./queue-arguments.ts";
import { restartCommand } from "./restart-command.ts";
import {
  failed,
  identified,
  presented,
  type Format,
  type Terminal,
} from "./command-output.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";
import type { WatchThemeSettings } from "./watch-themes.ts";
import { withCiReruns } from "./github-ci-progress.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  record,
  type Fields,
  type ServiceError,
  type ServiceRequest,
} from "../protocol.ts";
import { follow, listRuns, mutate, send } from "./client.ts";
import { eventText, pendingSummary, runOverview } from "./render.ts";
import type { RuntimeInvocation } from "./runtime-invocation.ts";
import { continueServiceRequest } from "./continue-arguments.ts";
import { commandUsage } from "./usage.ts";
import { defaultWatchPort, watchServer } from "./watch-server.ts";

export interface CommandEnvironment {
  readonly runtimeDirectory: string | undefined;
  readonly watchActions?: string;
  readonly watchPr?: WatchPrSettings;
  readonly watchThemes?: WatchThemeSettings;
  readonly retentionDays?: number | null;
  readonly client?: string;
  readonly workingDirectory: string;
  readonly terminal: Terminal;
  readonly identifier: () => string;
  readonly interrupted: () => Promise<void>;
}

type Invoked<Kind extends RuntimeInvocation["kind"]> = Extract<
  RuntimeInvocation,
  { kind: Kind }
>;

async function requested(
  environment: Located,
  exchange: { readonly request: ServiceRequest; readonly format: Format },
): Promise<number> {
  const reply = await readCommandReply(
    environment.runtimeDirectory,
    exchange.request,
  );
  return presented(environment, {
    reply,
    format: exchange.format,
  });
}

async function mutated(
  environment: Located,
  exchange: { readonly request: ServiceRequest; readonly format: Format },
): Promise<number> {
  return presented(environment, {
    reply: await mutate(environment.runtimeDirectory, {
      request: exchange.request,
      signal: environment.interrupted(),
    }),
    format: exchange.format,
  });
}

type Submission =
  | { readonly kind: "read"; readonly source: SubmittedSource }
  | { readonly kind: "error"; readonly error: ServiceError };

async function inputFile(
  environment: CommandEnvironment,
  input: { readonly file: string; readonly commandId: string },
): Promise<Submission> {
  const { file, commandId } = input;
  let text: string;
  try {
    text = await readFile(resolve(environment.workingDirectory, file), "utf8");
  } catch {
    return {
      kind: "error",
      error: {
        code: "unreadable-input",
        detail: `The input file ${file} is not readable.`,
      },
    };
  }
  let submission: Fields | undefined;
  try {
    submission = record(JSON.parse(text));
  } catch {
    return {
      kind: "error",
      error: {
        code: "malformed-input",
        detail: `The input file ${file} is not JSON.`,
      },
    };
  }
  if (submission === undefined)
    return {
      kind: "error",
      error: {
        commandId,
        detail: "The submission is not an object.",
        code: "invalid-submission",
      },
    };
  return { kind: "read", source: { kind: "input", submission } };
}

async function run(
  environment: Located,
  invocation: Invoked<"run">,
): Promise<number> {
  const format = identified(environment, invocation);
  const { source } = invocation;
  const read: Submission =
    source.kind === "input"
      ? await inputFile(environment, {
          file: source.file,
          commandId: format.commandId,
        })
      : { kind: "read", source };
  if (read.kind === "error")
    return failed(environment, { error: read.error, format });
  return mutated(environment, {
    format,
    request: runRequest({
      workflowId: invocation.workflowId,
      source: read.source,
      commandId: format.commandId,
    }),
  });
}

async function summarized(environment: Located): Promise<void> {
  const pending = await send(environment.runtimeDirectory, {
    operation: "questions",
    parameters: {},
  });
  if (pending.kind === "result")
    environment.terminal.out(pendingSummary(pending.result));
}

async function status(
  environment: Located,
  invocation: Invoked<"status">,
): Promise<number> {
  const { runId, limit, after, active, json } = invocation;
  if (!json && runId === null) await summarized(environment);
  if (!json && runId === null && limit === null && after === null) {
    const reply = await withCiReruns(
      environment.runtimeDirectory,
      await listRuns(environment.runtimeDirectory, active ? { active } : {}),
    );
    return presented(environment, {
      format: { json },
      reply:
        reply.kind === "result"
          ? { kind: "result", result: runOverview(reply.result) }
          : reply,
    });
  }
  return requested(environment, {
    format: { json },
    request: readCommandRequest(invocation),
  });
}

function decision(
  environment: Located,
  invocation: Invoked<"decision">,
): Promise<number> {
  const format = identified(environment, invocation);
  return mutated(environment, {
    format,
    request: decisionRequest({
      command: invocation.command,
      reference: invocation.reference,
      text: invocation.text,
      expectedRevision: invocation.expectedRevision,
      generation: invocation.generation,
      subjectDigest: invocation.subjectDigest,
      commandId: format.commandId,
    }),
  });
}

function runCommand(
  environment: Located,
  invocation: Invoked<"run-command"> | Invoked<"continue">,
): Promise<number> {
  const format = identified(environment, invocation);
  return mutated(environment, {
    format,
    request:
      invocation.kind === "continue"
        ? continueServiceRequest(invocation, format.commandId)
        : runCommandRequest({
            command: invocation.command,
            runId: invocation.runId,
            expectedRevision: invocation.expectedRevision,
            commandId: format.commandId,
          }),
  });
}

async function events(
  environment: Located,
  invocation: Invoked<"events">,
): Promise<number> {
  const { json, follow: following } = invocation;
  const { terminal } = environment;
  const print = (event: Fields): void => {
    terminal.out(json ? `${JSON.stringify(event)}\n` : `${eventText(event)}\n`);
  };
  const request = readCommandRequest(invocation);
  const reply = following
    ? await follow(environment.runtimeDirectory, {
        request,
        onEvent: print,
        signal: environment.interrupted(),
      })
    : await send(environment.runtimeDirectory, request);
  if (reply.kind === "error")
    return failed(environment, { error: reply.error, format: { json } });
  const page = reply.result["events"];
  for (const event of Array.isArray(page) ? page : [])
    print(record(event) ?? {});
  return 0;
}

interface Located extends CommandEnvironment {
  readonly runtimeDirectory: string;
}

export function runtimeCommand(
  invocation: RuntimeInvocation,
  environment: CommandEnvironment,
): Promise<number> {
  if (invocation.kind === "command-help") {
    environment.terminal.out(commandUsage[invocation.command] ?? "");
    return Promise.resolve(0);
  }
  const { runtimeDirectory } = environment;
  if (runtimeDirectory === undefined)
    return Promise.resolve(
      failed(environment, {
        error: {
          code: "repository-unknown",
          detail:
            "Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR.",
        },
        format: { json: invocation.json },
      }),
    );
  const placed = { ...environment, runtimeDirectory };
  if (invocation.kind === "restart") return restartCommand(placed, invocation);
  if (invocation.kind === "watch") return watch(placed, invocation);
  return located(invocation, placed);
}

function located(
  invocation: Exclude<
    RuntimeInvocation,
    { kind: "command-help" | "restart" | "watch" }
  >,
  environment: Located,
): Promise<number> {
  if (invocation.kind === "schedule")
    return requested(environment, {
      format: { json: invocation.json },
      request: scheduleServiceRequest(invocation),
    });
  if (invocation.kind === "queue") return queue(environment, invocation);
  if (invocation.kind === "report")
    return reportCommand(invocation, environment);
  if (invocation.kind === "run") return run(environment, invocation);
  if (invocation.kind === "decision") return decision(environment, invocation);
  if (invocation.kind === "run-command" || invocation.kind === "continue")
    return runCommand(environment, invocation);
  if (invocation.kind === "status") return status(environment, invocation);
  if (invocation.kind === "events") return events(environment, invocation);
  return requested(environment, {
    format: { json: invocation.json },
    request: readCommandRequest(invocation),
  });
}

function queue(
  environment: Located,
  invocation: Invoked<"queue">,
): Promise<number> {
  if (invocation.action === "show")
    return requested(environment, {
      format: { json: invocation.json },
      request: { operation: "queue", parameters: {} },
    });
  const format = identified(environment, invocation);
  return mutated(environment, {
    format,
    request: queueServiceRequest(invocation, format.commandId),
  });
}

function watch(
  environment: Located,
  invocation: Invoked<"watch">,
): Promise<number> {
  return watchServer({
    actions: environment.watchActions ?? "on",
    ...(environment.watchPr === undefined
      ? {}
      : { pullRequests: environment.watchPr }),
    ...(environment.watchThemes === undefined
      ? {}
      : { themes: environment.watchThemes }),
    ...(environment.retentionDays === undefined
      ? {}
      : { retentionDays: environment.retentionDays }),
    runtimeDirectory: environment.runtimeDirectory,
    port: invocation.port ?? defaultWatchPort,
    client: environment.client ?? "cloving",
    announce: environment.terminal.out,
    complain: environment.terminal.error,
    stopped: environment.interrupted(),
  });
}
