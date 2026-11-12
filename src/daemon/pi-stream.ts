import {
  validPiActivity,
  validPiToolResult,
  piWorkEvents,
} from "./pi-records.ts";
import { record, type Fields } from "../protocol.ts";
import {
  piPricingModel,
  piBilledCost,
  piResponse,
  piTotalUsage,
  piUsage,
  type PiAccounting,
  type PiResponseUsage,
} from "../pi-usage.ts";
import { sumUsage, type WorkerUsage } from "../worker-usage.ts";
import { piActivity } from "./pi-activity.ts";

interface State {
  readonly activity: ReturnType<typeof piActivity>;
  sessionId: string | null;
  settled: boolean;
  aborted: boolean;
  openAssistant: boolean;
  failure: string | undefined;
  outcomeError: string | undefined;
  message: Fields | undefined;
  readonly responses: PiResponseUsage[];
  readonly responseIds: Set<string>;
  readonly tools: Set<string>;
  readonly nested: WorkerUsage[];
  readonly nestedIds: Set<string>;
  auxiliaryWork: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function messageText(message: State["message"]): string {
  const content = message?.["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => record(part))
    .filter((part) => part?.["type"] === "text")
    .map((part) => text(part?.["text"]))
    .join("\n");
}

function contentParts(content: unknown): readonly Fields[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((part: unknown) => record(part));
  if (parts.some((part) => part === undefined)) return undefined;
  return parts.filter((part) => part !== undefined);
}

function validPart(part: Fields): boolean {
  switch (part["type"]) {
    case "text":
      return typeof part["text"] === "string";
    case "thinking":
      return typeof part["thinking"] === "string" || part["redacted"] === true;
    case "toolCall":
      return (
        typeof part["id"] === "string" &&
        typeof part["name"] === "string" &&
        record(part["arguments"]) !== undefined
      );
    default:
      return false;
  }
}

function assistant(message: Fields, state: State): readonly string[] {
  const parts = contentParts(message["content"]);
  const reason = message["stopReason"];
  if (
    parts === undefined ||
    !parts.every(validPart) ||
    !["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
      text(reason),
    )
  ) {
    state.failure ??= "Pi malformed assistant record";
    return [];
  }
  state.message = message;
  state.outcomeError = undefined;
  state.openAssistant = false;
  const response = piResponse(message);
  const identity =
    response.responseId === null
      ? undefined
      : JSON.stringify([
          response.provider,
          response.model,
          response.responseId,
        ]);
  if (identity !== undefined && state.responseIds.has(identity)) return [];
  if (identity !== undefined) state.responseIds.add(identity);
  state.responses.push(response);
  return state.activity.completed(message);
}

function toolResult(event: Fields, state: State): readonly string[] {
  const id = text(event["toolCallId"]);
  const result = record(event["result"]) ?? event;
  if (result["nestedCalls"] !== undefined) state.auxiliaryWork = true;
  if (result["usage"] !== undefined && !state.nestedIds.has(id)) {
    state.nestedIds.add(id);
    state.auxiliaryWork = true;
    state.nested.push(piUsage(result["usage"]));
  }
  if (state.tools.has(id)) return [];
  state.tools.add(id);
  return toolOutput(event, result);
}

function toolOutput(event: Fields, result: Fields): readonly string[] {
  return [
    JSON.stringify({
      type: "user",
      replaceId: `pi:tool-result:${text(event["toolCallId"])}`,
      ...(event["type"] === "tool_execution_update" ? { partial: true } : {}),
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: event["toolCallId"],
            content: result["content"],
            is_error: event["isError"] === true,
          },
        ],
      },
    }),
  ];
}

function messageEnded(event: Fields, state: State): readonly string[] {
  const message = record(event["message"]);
  if (message === undefined || typeof message["role"] !== "string") {
    state.failure ??= "Pi malformed message_end record";
    return [];
  }
  if (message["role"] === "assistant") return assistant(message, state);
  if (message["role"] !== "toolResult") return [];
  if (validPiToolResult(message)) return toolResult(message, state);
  state.failure ??= "Pi malformed toolResult message_end record";
  return [];
}

function settled(event: Fields, state: State): void {
  if (typeof event["aborted"] !== "boolean") {
    state.failure ??= "Pi malformed agent_settled record";
    return;
  }
  state.settled = true;
  state.aborted ||= event["aborted"];
}

function received(event: Fields, state: State): readonly string[] {
  if (event["type"] === "session") return session(event, state);
  if (state.sessionId === null) state.failure ??= "Pi missing session record";
  if (!validPiActivity(event)) {
    state.failure ??= `Pi malformed ${String(event["type"])} record`;
    return [];
  }
  if (piWorkEvents.has(String(event["type"]))) state.settled = false;
  invalidateOutcome(event, state);
  return activity(event, state);
}

function activity(event: Fields, state: State): readonly string[] {
  switch (event["type"]) {
    case "agent_settled":
      settled(event, state);
      break;
    case "message_start":
      if (record(event["message"])?.["role"] === "assistant") {
        state.openAssistant = true;
        return state.activity.start(record(event["message"]) ?? {});
      }
      break;
    case "message_update":
      state.openAssistant = true;
      return state.activity.update(event);
    case "message_end":
      return messageEnded(event, state);
    case "compaction_end":
      state.auxiliaryWork = true;
      break;
    default:
      return toolActivity(event, state);
  }
  return [];
}

function toolActivity(event: Fields, state: State): readonly string[] {
  switch (event["type"]) {
    case "tool_execution_start":
      return [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: event["toolCallId"],
                name: event["toolName"],
                input: event["args"],
              },
            ],
          },
        }),
      ];
    case "tool_execution_end":
      return toolResult(event, state);
    case "tool_execution_update":
      return state.tools.has(text(event["toolCallId"]))
        ? []
        : toolOutput(event, record(event["partialResult"]) ?? {});
  }
  return [];
}

function failure(state: State, exitCode: number | null): string | undefined {
  if (state.failure !== undefined) return state.failure;
  if (exitCode !== 0) return `Pi exited with code ${String(exitCode)}`;
  if (state.sessionId === null) return "Pi ended without a session record";
  if (!state.settled) return "Pi ended without agent_settled";
  if (state.aborted) return "Pi session aborted";
  if (state.openAssistant) return "Pi incomplete assistant record";
  return state.outcomeError ?? assistantFailure(state.message);
}

function assistantFailure(message: State["message"]): string | undefined {
  if (message?.["stopReason"] !== "stop")
    return (
      text(message?.["errorMessage"]) ||
      "Pi ended without a successful final assistant"
    );
  return undefined;
}

function parsed(line: string, state: State): readonly string[] {
  try {
    const event = record(JSON.parse(line));
    if (event === undefined || typeof event["type"] !== "string") {
      state.failure ??= "Pi malformed JSON record";
      return [];
    }
    return received(event, state);
  } catch {
    state.failure ??= "Pi malformed JSON record";
    return [];
  }
}

export function piStream() {
  const state: State = {
    activity: piActivity(),
    sessionId: null,
    settled: false,
    aborted: false,
    openAssistant: false,
    failure: undefined,
    outcomeError: undefined,
    message: undefined,
    responses: [],
    responseIds: new Set(),
    tools: new Set(),
    nested: [],
    nestedIds: new Set(),
    auxiliaryWork: false,
  };
  return {
    line: (line: string) =>
      parsed(line.endsWith("\r") ? line.slice(0, -1) : line, state),
    finish: (pending: string): readonly string[] => {
      if (pending !== "")
        state.failure ??= "Pi truncated JSON record without LF";
      return [];
    },
    result: (exitCode: number | null): string => {
      const error = failure(state, exitCode);
      const accounting: PiAccounting = {
        scope: "primary-model",
        responses: state.responses,
        auxiliaryWork: state.auxiliaryWork,
        nestedUsage: state.nested.length === 0 ? null : sumUsage(state.nested),
      };
      return JSON.stringify({
        type: "result",
        is_error: error !== undefined,
        result: error ?? messageText(state.message),
        session_id: state.sessionId,
        model: piPricingModel({ ...accounting, auxiliaryWork: false }),
        pricingModel: piPricingModel(accounting),
        total_cost_usd: piBilledCost(accounting),
        piAccounting: accounting,
        usage: piTotalUsage(accounting),
        num_turns: state.responses.length,
      });
    },
  };
}

function session(event: Fields, state: State): readonly string[] {
  if (
    state.sessionId !== null ||
    event["version"] !== 3 ||
    text(event["id"]) === ""
  )
    state.failure ??= "Pi unsupported or malformed session record";
  state.sessionId = text(event["id"]) || null;
  return [];
}

function invalidateOutcome(event: Fields, state: State): void {
  if (
    ["agent_start", "turn_start", "auto_retry_start"].includes(
      String(event["type"]),
    )
  )
    state.message = undefined;
  if (event["type"] === "auto_retry_end" && event["success"] === false) {
    state.message = undefined;
    state.outcomeError =
      text(event["finalError"]) ||
      "Pi retry failed without a successful assistant";
  }
}
