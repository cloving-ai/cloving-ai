import { record } from "../protocol.ts";
import {
  sumUsage,
  usageOf,
  type WorkerUsage,
  type WorkerModelUsage,
} from "../worker-usage.ts";

function parsed(line: string): Readonly<Record<string, unknown>> {
  try {
    return record(JSON.parse(line)) ?? {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface State {
  models: readonly WorkerModelUsage[] | undefined;
  usage: WorkerUsage;
  model: string | null;
  sessionId: string | null;
  message: string;
  continuing: boolean;
  success: boolean;
  failure: string | null;
}

function usage(value: unknown): WorkerUsage {
  const fields = record(value) ?? {};
  return usageOf({
    input_tokens: fields["input_tokens"],
    output_tokens: fields["output_tokens"],
    cache_read_input_tokens: fields["cached"],
  });
}

function statistics(
  event: Readonly<Record<string, unknown>>,
  state: State,
): void {
  const stats = record(event["stats"]);
  const models = record(stats?.["models"]);
  state.models =
    models === undefined
      ? undefined
      : Object.entries(models).map(([model, counts]) => ({
          model,
          usage: usage(counts),
        }));
  state.usage =
    state.models === undefined
      ? usage(stats)
      : sumUsage(state.models.map((entry) => entry.usage));
}

function completed(
  event: Readonly<Record<string, unknown>>,
  state: State,
): void {
  statistics(event, state);
  state.success = event["status"] === "success";
  if (!state.success)
    state.failure =
      text(record(event["error"])?.["message"]) ||
      "Gemini result was not successful";
}

function message(
  event: Readonly<Record<string, unknown>>,
  state: State,
): readonly string[] {
  if (event["role"] === "user") state.continuing = false;
  if (event["role"] !== "assistant") return [];
  const content = text(event["content"]);
  state.message =
    state.continuing && event["delta"] === true
      ? state.message + content
      : content;
  state.continuing = true;
  return [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: content }] },
    }),
  ];
}

function toolUse(event: Readonly<Record<string, unknown>>): readonly string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: text(event["tool_name"]),
            input: record(event["parameters"]) ?? {},
          },
        ],
      },
    }),
  ];
}

function received(
  event: Readonly<Record<string, unknown>>,
  state: State,
): readonly string[] {
  if (event["severity"] === "error")
    state.failure = text(event["message"]) || "Gemini error";
  switch (event["type"]) {
    case "init":
      state.model = text(event["model"]) || null;
      state.sessionId = text(event["session_id"]) || null;
      break;
    case "result":
      completed(event, state);
      break;
    case "message":
      return message(event, state);
    case "tool_use":
      state.continuing = false;
      return toolUse(event);
    case "tool_result":
      state.continuing = false;
  }
  return [];
}

export function geminiStream(): {
  readonly line: (line: string) => readonly string[];
  readonly result: (exitCode: number | null) => string;
} {
  const state: State = {
    model: null,
    sessionId: null,
    message: "",
    continuing: false,
    success: false,
    failure: null,
    models: undefined,
    usage: usageOf(null),
  };
  return {
    line: (line) => received(parsed(line), state),
    result: (exitCode) => {
      const success = exitCode === 0 && state.success && state.failure === null;
      return JSON.stringify({
        type: "result",
        is_error: !success,
        result: success
          ? state.message
          : (state.failure ??
            `gemini ended with code ${String(exitCode)} without a successful result`),
        model: state.model,
        session_id: state.sessionId,
        usage: state.usage,
        models: state.models,
      });
    },
  };
}
