import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  record,
  type Fields,
  type Reply,
  type ServiceError,
  type ServiceRequest,
} from "../protocol.ts";
import { follow, mutate, send } from "./client.ts";
import { errorText, eventText, pendingSummary, rendered } from "./render.ts";
import type { RuntimeInvocation } from "./runtime-arguments.ts";
import { commandUsage } from "./usage.ts";
import { defaultWatchPort, watchServer } from "./watch-server.ts";

export interface Terminal {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface CommandEnvironment {
  readonly runtimeDirectory: string | undefined;
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

interface Format {
  readonly json: boolean;
  readonly commandId?: string;
  readonly announced?: boolean;
}

function errorObject(error: ServiceError, format: Format): Fields {
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

function failed(
  environment: CommandEnvironment,
  failure: { readonly error: ServiceError; readonly format: Format },
): number {
  const { terminal } = environment;
  const shown = errorObject(failure.error, failure.format);
  if (failure.format.json) {
    terminal.out(`${JSON.stringify(shown)}\n`);
    return 1;
  }
  terminal.error(errorText(failure.error));
  if (typeof shown["commandId"] === "string" && !failure.format.announced)
    terminal.error(`Command ID: ${shown["commandId"]}\n`);
  return 1;
}

function presented(
  environment: CommandEnvironment,
  outcome: { readonly reply: Reply; readonly format: Format },
): number {
  const { reply, format } = outcome;
  if (reply.kind === "error")
    return failed(environment, { error: reply.error, format });
  environment.terminal.out(
    format.json ? `${JSON.stringify(reply.result)}\n` : rendered(reply.result),
  );
  return 0;
}

async function requested(
  environment: Located,
  exchange: { readonly request: ServiceRequest; readonly format: Format },
): Promise<number> {
  return presented(environment, {
    reply: await send(environment.runtimeDirectory, exchange.request),
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

function identified(
  environment: CommandEnvironment,
  invocation: { readonly commandId: string | null; readonly json: boolean },
): Format & { readonly commandId: string } {
  const { json } = invocation;
  if (invocation.commandId !== null)
    return { json, commandId: invocation.commandId, announced: false };
  const commandId = environment.identifier();
  if (!json) environment.terminal.error(`Command ID: ${commandId}\n`);
  return { json, commandId, announced: !json };
}

type Submission =
  | { readonly kind: "read"; readonly submission: unknown }
  | { readonly kind: "error"; readonly error: ServiceError };

async function inputFile(
  environment: CommandEnvironment,
  file: string,
): Promise<Submission> {
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
  try {
    return { kind: "read", submission: JSON.parse(text) };
  } catch {
    return {
      kind: "error",
      error: {
        code: "malformed-input",
        detail: `The input file ${file} is not JSON.`,
      },
    };
  }
}

function typed(
  source: Exclude<Invoked<"run">["source"], { readonly kind: "input" }>,
): Readonly<Record<string, string>> {
  return source.kind === "prompt"
    ? { prompt: source.text }
    : { ticket: source.id };
}

async function run(
  environment: Located,
  invocation: Invoked<"run">,
): Promise<number> {
  const format = identified(environment, invocation);
  const { commandId } = format;
  const { source } = invocation;
  const read: Submission =
    source.kind === "input"
      ? await inputFile(environment, source.file)
      : { kind: "read", submission: typed(source) };
  if (read.kind === "error")
    return failed(environment, { error: read.error, format });
  return mutated(environment, {
    format,
    request: {
      operation: "run",
      parameters: {
        workflowId: invocation.workflowId,
        source: source.kind,
        submission: read.submission,
        commandId,
      },
    },
  });
}

function present(values: Fields): Fields {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null),
  );
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
  const { runId, limit, after, json } = invocation;
  if (!json && runId === null) await summarized(environment);
  return requested(environment, {
    format: { json },
    request: {
      operation: "status",
      parameters: present({ runId, limit, after }),
    },
  });
}

function decision(
  environment: Located,
  invocation: Invoked<"decision">,
): Promise<number> {
  const format = identified(environment, invocation);
  const { commandId } = format;
  return mutated(environment, {
    format,
    request: {
      operation: "decision",
      parameters: present({
        command: invocation.command,
        reference: invocation.reference,
        text: invocation.text,
        expectedRevision: invocation.expectedRevision,
        generation: invocation.generation,
        subjectDigest: invocation.subjectDigest,
        commandId,
      }),
    },
  });
}

function runCommand(
  environment: Located,
  invocation: Invoked<"run-command">,
): Promise<number> {
  const format = identified(environment, invocation);
  const { commandId } = format;
  return mutated(environment, {
    format,
    request: {
      operation: "run-command",
      parameters: {
        command: invocation.command,
        runId: invocation.runId,
        expectedRevision: invocation.expectedRevision,
        commandId,
      },
    },
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
  const request = {
    operation: "events",
    parameters: present({
      runId: invocation.runId,
      after: invocation.after,
      limit: invocation.limit,
      follow: following,
    }),
  };
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
          code: "runtime-directory-unknown",
          detail:
            "No runtime directory is known. Set CLOVING_RUNTIME_DIR to the runtime directory of the service.",
        },
        format: { json: invocation.json },
      }),
    );
  return located(invocation, { ...environment, runtimeDirectory });
}

function located(
  invocation: Exclude<RuntimeInvocation, { kind: "command-help" }>,
  environment: Located,
): Promise<number> {
  if (invocation.kind === "run") return run(environment, invocation);
  if (invocation.kind === "status") return status(environment, invocation);
  if (invocation.kind === "decision") return decision(environment, invocation);
  if (invocation.kind === "run-command")
    return runCommand(environment, invocation);
  if (invocation.kind === "events") return events(environment, invocation);
  if (invocation.kind === "watch")
    return watchServer({
      runtimeDirectory: environment.runtimeDirectory,
      port: invocation.port ?? defaultWatchPort,
      client: environment.client ?? "cloving",
      announce: environment.terminal.out,
      complain: environment.terminal.error,
      stopped: environment.interrupted(),
    });
  return requested(environment, {
    format: { json: invocation.json },
    request: {
      operation: "questions",
      parameters: present({ runId: invocation.runId }),
    },
  });
}
