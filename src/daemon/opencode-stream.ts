import { record } from "../protocol.ts";
import {
  sumUsage,
  usageOf,
  tokenCount,
  type WorkerUsage,
} from "../worker-usage.ts";

function parsed(line: string): Readonly<Record<string, unknown>> {
  try {
    return record(JSON.parse(line)) ?? {};
  } catch {
    return {};
  }
}

function tokens(value: unknown): WorkerUsage {
  const counts = record(value) ?? {};
  const cache = record(counts["cache"]) ?? {};
  const output = tokenCount(counts["output"]);
  const reasoning = tokenCount(counts["reasoning"]);
  return usageOf({
    input_tokens: counts["input"],
    cache_read_input_tokens: cache["read"],
    output_tokens:
      output === null || reasoning === null ? null : output + reasoning,
  });
}

interface State {
  readonly steps: WorkerUsage[];
  message: string;
  sessionId: string | null;
  model: string | null;
  reason: unknown;
  error: string | null;
  stderr: string;
}

function errorMessage(value: unknown): string {
  const error = record(value) ?? {};
  const data = record(error["data"]) ?? {};
  const message = data["message"] ?? error["name"];
  return typeof message === "string" ? message : "opencode error";
}

function translated(line: string, state: State): readonly string[] {
  const event = parsed(line);
  const part = record(event["part"]) ?? {};
  if (typeof event["sessionID"] === "string")
    state.sessionId = event["sessionID"];
  if (typeof event["model"] === "string") state.model = event["model"];
  if (event["type"] === "error") state.error = errorMessage(event["error"]);
  if (event["type"] === "step_finish") {
    state.steps.push(tokens(part["tokens"]));
    state.reason = part["reason"];
  }
  if (event["type"] !== "text" || typeof part["text"] !== "string") return [];
  state.message = part["text"];
  return [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: state.message }] },
    }),
  ];
}

function result(exitCode: number | null, state: State): string {
  const success =
    exitCode === 0 && state.error === null && state.reason === "stop";
  const failure =
    exitCode === 0
      ? "opencode ended without a final stop step"
      : `opencode ended with the code ${String(exitCode)}`;
  return JSON.stringify({
    type: "result",
    subtype: success ? "success" : "error_during_execution",
    is_error: !success,
    result: success
      ? state.message
      : state.error || state.stderr.trim() || failure,
    total_cost_usd: null,
    model: state.model,
    usage: sumUsage(state.steps),
    session_id: state.sessionId,
    num_turns: state.steps.length,
  });
}

export function opencodeStream() {
  const state: State = {
    steps: [],
    message: "",
    sessionId: null,
    model: null,
    reason: null,
    error: null,
    stderr: "",
  };
  return {
    line: (line: string) => translated(line, state),
    stderr: (chunk: string) => {
      state.stderr = (state.stderr + chunk).slice(-16_000);
    },
    result: (exitCode: number | null) => result(exitCode, state),
  };
}
