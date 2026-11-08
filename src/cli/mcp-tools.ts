import { isRecordKey } from "../authority/commands.ts";
import {
  record,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";
import { mutate } from "./client.ts";
import {
  commandJson,
  decisionRequest,
  readCommandReply,
  dismissRequest,
  readCommandRequest,
  runCommandRequest,
  runRequest,
  type ReadCommand,
  type SubmittedSource,
} from "./command-requests.ts";
import { continueServiceRequest, stepName } from "./continue-arguments.ts";
import {
  argumentRules,
  type DecisionCommand,
  type RunCommand,
} from "./runtime-invocation.ts";

interface Argument {
  readonly schema: Fields;
  readonly valid: (value: unknown) => boolean;
}

export type McpCall =
  | { readonly kind: "read"; readonly request: ServiceRequest }
  | {
      readonly kind: "mutation";
      readonly request: ServiceRequest;
      readonly commandId: string;
    };

interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly arguments: Readonly<Record<string, Argument>>;
  readonly required: readonly string[];
  readonly annotations: Fields;
  readonly call: (values: Fields) => McpCall | undefined;
}

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:/-]+$",
};

function matching(pattern: RegExp, schema: Fields): Argument {
  return {
    schema,
    valid: (value) => typeof value === "string" && pattern.test(value),
  };
}

function whole(range: {
  readonly minimum: number;
  readonly maximum: number;
}): Argument {
  return {
    schema: { type: "integer", ...range },
    valid: (value) =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= range.minimum &&
      value <= range.maximum,
  };
}

const key: Argument = { schema: identifierSchema, valid: isRecordKey };
const identifier = matching(argumentRules.identifier, identifierSchema);
const reference = matching(argumentRules.decisionReference, {
  ...identifierSchema,
  maxLength: 256,
});
const digest = matching(argumentRules.sha256Digest, {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
});
const revision = whole(argumentRules.revisions);
const words = matching(/\S/, { type: "string", pattern: "\\S" });
const limit = whole({ minimum: 1, maximum: 500 });
const object: Argument = {
  schema: { type: "object" },
  valid: (value) => record(value) !== undefined,
};

function commandInput(kind: ReadCommand["kind"], values: Fields): ReadCommand {
  const { runId, limit, after } = values;
  return {
    kind,
    ...(typeof runId === "string" ? { runId } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof after === "string" || typeof after === "number"
      ? { after }
      : {}),
  };
}

function read(
  kind: ReadCommand["kind"],
  properties: Readonly<Record<string, Argument>>,
): Tool {
  return {
    name: `cloving_${kind}`,
    arguments: properties,
    required: [],
    annotations: { readOnlyHint: true },
    call: (values) => ({
      kind: "read",
      request: readCommandRequest(commandInput(kind, values)),
    }),
  };
}

const mutation = { readOnlyHint: false, idempotentHint: true };
const repeat = "If the reply is lost, send the same commandId again.";
const decisionDescriptions: Readonly<Record<DecisionCommand, string>> = {
  answer: "Answer an open question.",
  approve: "Approve an open approval.",
  deny: "Deny an open approval. A feedback text is optional.",
};
const runCommandDescriptions: Readonly<Record<RunCommand, string>> = {
  pause: "Pause a run.",
  resume: "Resume a paused run.",
  drop: "Drop a run. A dropped run does not continue.",
};

function mutationCall(
  values: Fields,
  request: (commandId: string) => ServiceRequest,
): McpCall {
  const commandId = String(values["commandId"]);
  return { kind: "mutation", commandId, request: request(commandId) };
}

function decisionCall(command: DecisionCommand, values: Fields): McpCall {
  const { text } = values;
  return mutationCall(values, (commandId) =>
    decisionRequest({
      command,
      reference: String(values["reference"]),
      text: typeof text === "string" ? text : null,
      expectedRevision: Number(values["expectedRevision"]),
      generation: Number(values["generation"]),
      subjectDigest: String(values["subjectDigest"]),
      commandId,
    }),
  );
}

function decision(command: DecisionCommand): Tool {
  const binding = {
    expectedRevision: revision,
    generation: revision,
    subjectDigest: digest,
    commandId: key,
  };
  return {
    name: `cloving_${command}`,
    description: `${decisionDescriptions[command]} Read the values from cloving_questions. ${repeat}`,
    arguments: {
      reference,
      ...(command === "approve" ? {} : { text: words }),
      ...binding,
    },
    required: [
      "reference",
      ...(command === "answer" ? ["text"] : []),
      ...Object.keys(binding),
    ],
    annotations: mutation,
    call: (values) => decisionCall(command, values),
  };
}

function runCommand(command: RunCommand): Tool {
  return {
    name: `cloving_${command}`,
    description: `${runCommandDescriptions[command]} Read expectedRevision from cloving_status. ${repeat}`,
    arguments: { runId: key, expectedRevision: revision, commandId: key },
    required: ["runId", "expectedRevision", "commandId"],
    annotations:
      command === "drop" ? { ...mutation, destructiveHint: true } : mutation,
    call: (values) =>
      mutationCall(values, (commandId) =>
        runCommandRequest({
          command,
          runId: String(values["runId"]),
          expectedRevision: Number(values["expectedRevision"]),
          commandId,
        }),
      ),
  };
}

function runSource(values: Fields): SubmittedSource | undefined {
  const { prompt, ticket, input } = values;
  const given = [prompt, ticket, input].filter((value) => value !== undefined);
  if (given.length !== 1) return undefined;
  if (typeof prompt === "string") return { kind: "prompt", text: prompt };
  if (typeof ticket === "string") return { kind: "ticket", id: ticket };
  const submission = record(input);
  return submission === undefined ? undefined : { kind: "input", submission };
}

function runCall(values: Fields): McpCall | undefined {
  const source = runSource(values);
  if (source === undefined) return undefined;
  return mutationCall(values, (commandId) =>
    runRequest({ workflowId: String(values["workflowId"]), source, commandId }),
  );
}

const step = matching(stepName, {
  type: "string",
  pattern: stepName.source,
});
const bundle: Argument = {
  schema: { type: "string", enum: ["retained", "current"] },
  valid: (value) => value === "retained" || value === "current",
};

const note: Argument = {
  schema: { type: "string" },
  valid: (value) => typeof value === "string",
};

const continueTool: Tool = {
  name: "cloving_continue",
  description: `Continue a failed run, or a run that completed blocked, in a new run on the same branch and pull request. The new run reuses the completed effects before the failed step, or before the step in from. The first agent turn that the new run starts gets the note under Notes from the operator. ${repeat}`,
  arguments: { runId: key, from: step, bundle, note, commandId: key },
  required: ["runId", "commandId"],
  annotations: mutation,
  call: (values) =>
    mutationCall(values, (commandId) =>
      continueServiceRequest(
        {
          kind: "continue",
          runId: String(values["runId"]),
          from: typeof values["from"] === "string" ? values["from"] : null,
          bundle: values["bundle"] === "current" ? "current" : "retained",
          commandId,
          note: typeof values["note"] === "string" ? values["note"] : null,
          json: true,
        },
        commandId,
      ),
    ),
};

const dismissTool: Tool = {
  name: "cloving_dismiss",
  description: `Dismiss a failed run, or a run that completed blocked, so that Needs you on the watch page does not list it. The dismissal is an event of the run. ${repeat}`,
  arguments: { runId: key, commandId: key },
  required: ["runId", "commandId"],
  annotations: mutation,
  call: (values) =>
    mutationCall(values, (commandId) =>
      dismissRequest({ runId: String(values["runId"]), commandId }),
    ),
};

const tools: readonly Tool[] = [
  read("status", { runId: key, limit, after: identifier }),
  read("questions", { runId: key }),
  read("events", {
    runId: key,
    after: whole({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    limit: whole({ minimum: 1, maximum: 1000 }),
  }),
  {
    name: "cloving_run",
    description: `Submit a run of a workflow. Give exactly one of prompt, ticket and input. A ticket can be next. ${repeat}`,
    arguments: {
      workflowId: identifier,
      prompt: words,
      ticket: key,
      input: object,
      commandId: key,
    },
    required: ["workflowId", "commandId"],
    annotations: mutation,
    call: runCall,
  },
  decision("answer"),
  decision("approve"),
  decision("deny"),
  runCommand("pause"),
  runCommand("resume"),
  runCommand("drop"),
  continueTool,
  dismissTool,
];

function listing(tool: Tool): Fields {
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(tool.arguments).map(([name, argument]) => [
          name,
          argument.schema,
        ]),
      ),
      ...(tool.required.length === 0 ? {} : { required: tool.required }),
      additionalProperties: false,
    },
    annotations: tool.annotations,
  };
}

export const mcpTools = tools.map(listing);

function validArguments(values: Fields, tool: Tool): boolean {
  if (tool.required.some((name) => !Object.hasOwn(values, name))) return false;
  return Object.entries(values).every(
    ([name, value]) =>
      Object.hasOwn(tool.arguments, name) &&
      tool.arguments[name]?.valid(value) === true,
  );
}

export function mcpToolCall(parameters: Fields): McpCall | undefined {
  const selected = tools.find((tool) => tool.name === parameters["name"]);
  if (selected === undefined) return undefined;
  const values =
    parameters["arguments"] === undefined
      ? {}
      : record(parameters["arguments"]);
  if (values === undefined || !validArguments(values, selected))
    return undefined;
  return selected.call(values);
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    signal.addEventListener(
      "abort",
      () => {
        settle();
      },
      { once: true },
    );
  });
}

function toolReply(
  runtimeDirectory: string,
  exchange: { readonly call: McpCall; readonly signal: AbortSignal },
): Promise<Reply> {
  const { call, signal } = exchange;
  if (call.kind === "read")
    return readCommandReply(runtimeDirectory, { ...call.request, signal });
  return mutate(runtimeDirectory, {
    request: call.request,
    signal: aborted(signal),
  });
}

export async function callMcpTool(
  runtimeDirectory: string,
  exchange: { readonly call: McpCall; readonly signal: AbortSignal },
): Promise<Fields> {
  const { call } = exchange;
  const reply = await toolReply(runtimeDirectory, exchange);
  const structuredContent = commandJson(
    reply,
    call.kind === "mutation" ? { commandId: call.commandId } : {},
  );
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    ...(reply.kind === "error" ? { isError: true } : {}),
  };
}
