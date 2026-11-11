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
    saved: Promise.resolve(),
    pending: "",
    result: undefined,
    model: null,
    errorType: null,
  };
}

function streamMetadata(stream: Stream, event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const field = (name: string): unknown => Reflect.get(event, name);
  const type = field("type");
  const sessionId = textOf(field("session_id"));
  const discovered = stream.sessionId === null && sessionId !== null;
  if (discovered) stream.sessionId = sessionId;
  if (type === "assistant" && field("parent_tool_use_id") == null)
    stream.errorType = textOf(field("error"));
  if (type === "system" || type === "result")
    stream.model = textOf(field("model")) ?? stream.model;
  return discovered;
}

function saveProgress(stream: Stream, input: StreamInput): void {
  const progress = { sessionId: stream.sessionId, result: stream.result };
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
    if (discovered || result !== undefined) saveProgress(stream, input);
  }
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
