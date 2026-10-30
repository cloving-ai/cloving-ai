import { isRecordKey } from "../authority/commands.ts";
import {
  scheduleInvocation,
  type ScheduleInvocation,
} from "./schedule-arguments.ts";

export type RunSource =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "ticket"; readonly id: string }
  | { readonly kind: "input"; readonly file: string };

type DecisionCommand = "answer" | "approve" | "deny";

type RunCommand = "pause" | "resume" | "drop";

export type RuntimeInvocation =
  | ScheduleInvocation
  | { readonly kind: "report"; readonly since: number; readonly json: boolean }
  | { readonly kind: "command-help"; readonly command: string }
  | {
      readonly kind: "run";
      readonly workflowId: string;
      readonly source: RunSource;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "status";
      readonly runId: string | null;
      readonly limit: number | null;
      readonly after: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "questions";
      readonly runId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "decision";
      readonly command: DecisionCommand;
      readonly reference: string;
      readonly text: string | null;
      readonly expectedRevision: number;
      readonly generation: number;
      readonly subjectDigest: string;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "run-command";
      readonly command: RunCommand;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "events";
      readonly runId: string | null;
      readonly after: number;
      readonly limit: number | null;
      readonly follow: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "watch";
      readonly port: number | null;
      readonly json: boolean;
    };

export interface GivenOption {
  readonly name: string;
  readonly value: string | undefined;
}

export interface RuntimeRequest {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: readonly GivenOption[];
}

type Outcome = RuntimeInvocation | string;

interface Shape {
  readonly subject: "required" | "optional" | "none";
  readonly required: readonly string[];
  readonly allowed: (request: RuntimeRequest) => readonly string[];
  readonly build: (request: RuntimeRequest) => Outcome;
}

interface Range {
  readonly minimum: number;
  readonly maximum: number;
}

const identifier = /^[A-Za-z0-9._:/-]{1,128}$/;
const decisionReference = /^[A-Za-z0-9._:/-]{1,256}$/;
const sha256Digest = /^sha256:[0-9a-f]{64}$/;
const wholeNumber = /^(?:0|[1-9][0-9]*)$/;
const invalid = Symbol("invalid");
const revisions = { minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const sequences = { minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bindingOptions = ["expected-revision", "generation", "subject-digest"];
const mutationOptions = ["command-id", "json"];

const shapes: ReadonlyMap<string, Shape> = new Map<string, Shape>([
  [
    "run",
    {
      subject: "required",
      required: [],
      allowed: () => ["prompt", "input", "ticket", "next", ...mutationOptions],
      build: run,
    },
  ],
  [
    "status",
    {
      subject: "optional",
      required: [],
      allowed: statusOptions,
      build: status,
    },
  ],
  [
    "questions",
    {
      subject: "optional",
      required: [],
      allowed: () => ["json"],
      build: questions,
    },
  ],
  ["answer", decisionShape("answer")],
  ["approve", decisionShape("approve")],
  ["deny", decisionShape("deny")],
  ["pause", runCommandShape("pause")],
  ["resume", runCommandShape("resume")],
  ["drop", runCommandShape("drop")],
  [
    "events",
    {
      subject: "optional",
      required: [],
      allowed: eventOptions,
      build: events,
    },
  ],
  [
    "report",
    {
      subject: "none",
      required: [],
      allowed: () => ["since", "json"],
      build: report,
    },
  ],
  [
    "watch",
    {
      subject: "none",
      required: [],
      allowed: () => ["port"],
      build: watch,
    },
  ],
]);

export function isRuntimeCommand(command: string): boolean {
  return command === "schedule" || shapes.has(command);
}

export function runtimeInvocation(request: RuntimeRequest): Outcome {
  const shape = shapes.get(request.command);
  if (!isRuntimeCommand(request.command)) return "unknown-command";
  const names = request.options.map((option) => option.name);
  if (new Set(names).size !== names.length) return "repeated-option";
  if (names.includes("help"))
    return { kind: "command-help", command: request.command };
  if (request.command === "schedule") return scheduleInvocation(request);
  if (shape === undefined) return "unknown-command";
  return shapeFailure(shape, request) ?? shape.build(request);
}

function shapeFailure(
  shape: Shape,
  request: RuntimeRequest,
): string | undefined {
  const names = request.options.map((option) => option.name);
  const allowed = shape.allowed(request);
  const count = request.positionals.length;
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  if (shape.subject === "required" && count === 0) return "missing-argument";
  if (count > (shape.subject === "none" ? 0 : 1)) return "unexpected-argument";
  if (shape.required.some((name) => !names.includes(name)))
    return "missing-option";
  return undefined;
}

function decisionShape(command: DecisionCommand): Shape {
  const required =
    command === "answer" ? [...bindingOptions, "text"] : bindingOptions;
  const optional = command === "deny" ? ["text"] : [];
  return {
    subject: "required",
    required,
    allowed: () => [...required, ...optional, ...mutationOptions],
    build: (request) => decision(command, request),
  };
}

function runCommandShape(command: RunCommand): Shape {
  return {
    subject: "required",
    required: ["expected-revision"],
    allowed: () => ["expected-revision", ...mutationOptions],
    build: (request) => runCommand(command, request),
  };
}

function statusOptions(request: RuntimeRequest): readonly string[] {
  return request.positionals.length === 0
    ? ["limit", "after", "json"]
    : ["json"];
}

function eventOptions(request: RuntimeRequest): readonly string[] {
  return given(request, "follow")
    ? ["after", "follow", "json"]
    : ["after", "limit", "follow", "json"];
}

function given(request: RuntimeRequest, name: string): boolean {
  return request.options.some((option) => option.name === name);
}

function valueOf(request: RuntimeRequest, name: string): string | undefined {
  return request.options.find((option) => option.name === name)?.value;
}

function blank(value: string | undefined): boolean {
  return value?.trim() === "";
}

function matching(
  value: string | undefined,
  pattern: RegExp,
): string | null | typeof invalid {
  if (value === undefined) return null;
  return pattern.test(value) ? value : invalid;
}

function key(value: string | undefined): string | null | typeof invalid {
  if (value === undefined) return null;
  return isRecordKey(value) ? value : invalid;
}

function whole(
  value: string | undefined,
  range: Range,
): number | null | typeof invalid {
  if (value === undefined) return null;
  if (!wholeNumber.test(value)) return invalid;
  const number = Number(value);
  return number >= range.minimum && number <= range.maximum ? number : invalid;
}

function inputSource(request: RuntimeRequest): RunSource | string {
  const prompt = valueOf(request, "prompt");
  const input = valueOf(request, "input");
  const ticket = valueOf(request, "ticket");
  const next = given(request, "next");
  const sources = [prompt, input, ticket].filter(
    (value) => value !== undefined,
  );
  if (sources.length + Number(next) > 1) return "conflicting-input-sources";
  if (prompt !== undefined) return { kind: "prompt", text: prompt };
  if (input !== undefined) return { kind: "input", file: input };
  if (ticket !== undefined) return { kind: "ticket", id: ticket };
  if (next) return { kind: "ticket", id: "next" };
  return "missing-input-source";
}

function run(request: RuntimeRequest): Outcome {
  const source = inputSource(request);
  if (typeof source === "string") return source;
  if (blank(valueOf(request, "prompt"))) return "empty-prompt";
  const workflowId = matching(request.positionals[0], identifier);
  const commandId = key(valueOf(request, "command-id"));
  const unusable =
    typeof workflowId !== "string" ||
    key(valueOf(request, "ticket")) === invalid;
  if (unusable || commandId === invalid) return "invalid-option-value";
  const json = given(request, "json");
  return { kind: "run", workflowId, source, commandId, json };
}

function status(request: RuntimeRequest): Outcome {
  const runId = key(request.positionals[0]);
  const limit = whole(valueOf(request, "limit"), { minimum: 1, maximum: 500 });
  const after = matching(valueOf(request, "after"), identifier);
  if (runId === invalid || limit === invalid || after === invalid)
    return "invalid-option-value";
  const json = given(request, "json");
  return { kind: "status", runId, limit, after, json };
}

function watch(request: RuntimeRequest): Outcome {
  const port = whole(valueOf(request, "port"), { minimum: 0, maximum: 65535 });
  if (port === invalid) return "invalid-option-value";
  return { kind: "watch", port, json: false };
}

function questions(request: RuntimeRequest): Outcome {
  const runId = key(request.positionals[0]);
  if (runId === invalid) return "invalid-option-value";
  return { kind: "questions", runId, json: given(request, "json") };
}

function decision(command: DecisionCommand, request: RuntimeRequest): Outcome {
  const answer = valueOf(request, "text");
  if (blank(answer)) return "empty-prompt";
  const reference = matching(request.positionals[0], decisionReference);
  const expectedRevision = whole(
    valueOf(request, "expected-revision"),
    revisions,
  );
  const generation = whole(valueOf(request, "generation"), revisions);
  const subjectDigest = matching(
    valueOf(request, "subject-digest"),
    sha256Digest,
  );
  const commandId = key(valueOf(request, "command-id"));
  if (
    typeof reference !== "string" ||
    typeof expectedRevision !== "number" ||
    typeof generation !== "number" ||
    typeof subjectDigest !== "string" ||
    commandId === invalid
  )
    return "invalid-option-value";
  const subject = { command, reference, text: answer ?? null };
  const binding = { expectedRevision, generation, subjectDigest };
  const json = given(request, "json");
  return { kind: "decision", ...subject, ...binding, commandId, json };
}

function runCommand(command: RunCommand, request: RuntimeRequest): Outcome {
  const runId = key(request.positionals[0]);
  const expectedRevision = whole(
    valueOf(request, "expected-revision"),
    revisions,
  );
  const commandId = key(valueOf(request, "command-id"));
  if (
    typeof runId !== "string" ||
    typeof expectedRevision !== "number" ||
    commandId === invalid
  )
    return "invalid-option-value";
  const json = given(request, "json");
  return {
    kind: "run-command",
    command,
    runId,
    expectedRevision,
    commandId,
    json,
  };
}

function events(request: RuntimeRequest): Outcome {
  const runId = key(request.positionals[0]);
  const after = whole(valueOf(request, "after"), sequences);
  const limit = whole(valueOf(request, "limit"), { minimum: 1, maximum: 1000 });
  if (runId === invalid || after === invalid || limit === invalid)
    return "invalid-option-value";
  const follow = given(request, "follow");
  const json = given(request, "json");
  return { kind: "events", runId, after: after ?? 0, limit, follow, json };
}

function report(request: RuntimeRequest): Outcome {
  const since = whole(valueOf(request, "since"), { minimum: 1, maximum: 168 });
  if (since === invalid) return "invalid-option-value";
  return { kind: "report", since: since ?? 24, json: given(request, "json") };
}
