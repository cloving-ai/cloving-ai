import {
  parsed,
  streamResult,
  textOf,
  type StreamResult,
  type Worker,
} from "./claude-stream.ts";
import { commandModel } from "../token-prices.ts";

export interface TurnProgress {
  readonly sessionId: string | null;
  readonly conversation: boolean;
  readonly result: StreamResult | undefined;
}

export interface StreamInput {
  readonly progress?: ((progress: TurnProgress) => Promise<void>) | undefined;
  readonly worker?: Worker | undefined;
  readonly failed: () => void;
}

export interface Stream {
  failure: { readonly error: unknown } | undefined;
  sessionId: string | null;
  conversation: boolean;
  saved: Promise<void>;
  errorType: string | null;
  model: string | null;
  pending: string;
  result: StreamResult | undefined;
}

export function streamState(): Stream {
  return {
    failure: undefined,
    sessionId: null,
    conversation: false,
    saved: Promise.resolve(),
    pending: "",
    result: undefined,
    model: null,
    errorType: null,
  };
}

function sessionDiscovered(stream: Stream, sessionId: string | null): boolean {
  if (stream.sessionId !== null || sessionId === null) return false;
  stream.sessionId = sessionId;
  return true;
}

function conversationStarted(stream: Stream, type: unknown): boolean {
  if (stream.conversation || (type !== "assistant" && type !== "user"))
    return false;
  stream.conversation = true;
  return true;
}

function streamMetadata(stream: Stream, event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const field = (name: string): unknown => Reflect.get(event, name);
  const type = field("type");
  const discovered = sessionDiscovered(stream, textOf(field("session_id")));
  if (type === "assistant" && field("parent_tool_use_id") == null)
    stream.errorType = textOf(field("error"));
  if (type === "system" || type === "result")
    stream.model = textOf(field("model")) ?? stream.model;
  return conversationStarted(stream, type) || discovered;
}

function saveProgress(stream: Stream, input: StreamInput): void {
  const progress = {
    sessionId: stream.sessionId,
    conversation: stream.conversation,
    result: stream.result,
  };
  stream.saved = stream.saved
    .then(() => {
      if (stream.failure === undefined) return input.progress?.(progress);
      return undefined;
    })
    .catch((error: unknown) => {
      stream.failure = { error };
      input.failed();
    });
}

export function receivedLines(
  stream: Stream,
  input: StreamInput & { readonly lines: readonly string[] },
): void {
  let changed = false;
  for (const line of input.lines) {
    const discovered = streamMetadata(stream, parsed(line));
    const result = streamResult(line, input.worker);
    if (result !== undefined) {
      const errorType = result.errorType ?? stream.errorType;
      stream.result = {
        ...result,
        sessionId: result.sessionId ?? stream.sessionId,
        ...(errorType === null ? {} : { errorType }),
      };
    }
    changed = changed || discovered || result !== undefined;
  }
  if (changed) saveProgress(stream, input);
}

export function receivedText(
  stream: Stream,
  input: StreamInput & { readonly text: string },
): void {
  const lines = `${stream.pending}${input.text}`.split("\n");
  stream.pending = lines.pop() ?? "";
  receivedLines(stream, { ...input, lines });
}

export async function streamEnd(
  stream: Stream,
  command: readonly string[],
): Promise<StreamResult | undefined> {
  await stream.saved;
  if (stream.failure !== undefined) throw stream.failure.error;
  const result = stream.result;
  return result === undefined
    ? undefined
    : {
        ...result,
        model: result.model ?? stream.model ?? commandModel(command),
      };
}
