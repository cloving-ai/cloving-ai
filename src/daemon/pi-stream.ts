import {
  responseIdentity,
  responseAnchor,
  piSessionHeader,
  validPiActivity,
  validPiToolResult,
  piMessageFailure,
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
import { sumUsage, usageOf, type WorkerUsage } from "../worker-usage.ts";
import { piActivity } from "./pi-activity.ts";

interface State {
  readonly activity: ReturnType<typeof piActivity>;
  sessionId: string | null;
  sessionHeader: string | null;
  invocationStarted: boolean;
  settled: boolean;
  aborted: boolean;
  openAssistant: boolean;
  openIdentity: string | undefined;
  failure: string | undefined;
  outcomeError: string | undefined;
  message: Fields | undefined;
  readonly responses: PiResponseUsage[];
  readonly responseIds: Set<string>;
  readonly startIds: Set<string>;
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

function replayed(event: Fields, state: State): boolean {
  const message = record(event["message"]);
  if (
    !["message_start", "message_end"].includes(String(event["type"])) ||
    message?.["role"] !== "assistant"
  )
    return false;
  const identity = responseIdentity(message);
  if (identity === undefined) return false;
  if (state.responseIds.has(identity)) return true;
  return event["type"] === "message_start" && state.startIds.has(identity);
}

function replayedAssistant(message: Fields, state: State): readonly string[] {
  if (
    state.openIdentity === undefined ||
    state.openIdentity !== responseAnchor(message)
  )
    return [];
  state.openAssistant = false;
  state.openIdentity = undefined;
  return state.activity.completed({ content: [] });
}

function assistant(message: Fields, state: State): readonly string[] {
  const response = piResponse(message);
  const identity = responseIdentity(message);
  if (identity !== undefined && state.responseIds.has(identity))
    return replayedAssistant(message, state);
  state.message = message;
  state.outcomeError = undefined;
  state.openAssistant = false;
  state.openIdentity = undefined;
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
  if (state.failure !== undefined) return [];
  if (event["type"] === "session") return session(event, state);
  if (event["type"] === "response") return [];
  state.failure = activityFailure(event, state);
  if (state.failure !== undefined) return [];
  if (event["type"] === "agent_start") state.invocationStarted = true;
  if (
    !state.invocationStarted &&
    ["message_start", "message_end"].includes(String(event["type"]))
  )
    return [];
  if (!replayed(event, state) && piWorkEvents.has(String(event["type"])))
    state.settled = false;
  invalidateOutcome(event, state);
  return activity(event, state);
}

function activityFailure(event: Fields, state: State): string | undefined {
  if (state.sessionId === null) return "Pi missing session record";
  const failure = piMessageFailure(event);
  if (failure !== undefined) return failure;
  return validPiActivity(event)
    ? undefined
    : `Pi malformed ${String(event["type"])} record`;
}

function messageStarted(event: Fields, state: State): readonly string[] {
  const message = record(event["message"]);
  if (message?.["role"] !== "assistant") return [];
  const replay = replayed(event, state);
  if (replay && !state.openAssistant)
    state.openIdentity = responseAnchor(message);
  if (replay) return [];
  const identity = responseIdentity(message);
  if (identity !== undefined) state.startIds.add(identity);
  state.openAssistant = true;
  state.openIdentity = responseAnchor(message);
  return state.activity.start(message);
}

function activity(event: Fields, state: State): readonly string[] {
  switch (event["type"]) {
    case "agent_settled":
      settled(event, state);
      break;
    case "message_start":
      return messageStarted(event, state);
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

export function piStream(ownedSession?: {
  readonly historicalResponses?: readonly string[];
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
}) {
  const state: State = {
    activity: piActivity(),
    sessionId: null,
    sessionHeader: piSessionHeader(ownedSession),
    invocationStarted: false,
    settled: false,
    aborted: false,
    openAssistant: false,
    openIdentity: undefined,
    failure: undefined,
    outcomeError: undefined,
    message: undefined,
    responses: [],
    responseIds: new Set(ownedSession?.historicalResponses),
    startIds: new Set(),
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
      const complete =
        state.settled && !state.openAssistant && state.failure === undefined;
      const accounting: PiAccounting = {
        scope: "primary-model",
        responses: state.responses,
        auxiliaryWork: state.auxiliaryWork || !complete,
        nestedUsage: state.nested.length === 0 ? null : sumUsage(state.nested),
      };
      return JSON.stringify({
        type: "result",
        is_error: error !== undefined,
        result: error ?? messageText(state.message),
        session_id: state.sessionId,
        model: piPricingModel({ ...accounting, auxiliaryWork: false }),
        pricingModel: piPricingModel(accounting),
        total_cost_usd: complete ? piBilledCost(accounting) : null,
        piAccounting: accounting,
        usage: complete ? piTotalUsage(accounting) : usageOf(null),
        num_turns: state.responses.length,
      });
    },
  };
}

function session(event: Fields, state: State): readonly string[] {
  if (event["version"] !== 3 || text(event["id"]) === "") {
    state.failure ??= "Pi unsupported or malformed session record";
    return [];
  }
  const header = JSON.stringify([
    event["id"],
    event["cwd"],
    event["timestamp"],
  ]);
  if (state.sessionHeader !== null && state.sessionHeader !== header) {
    state.failure ??= "Pi conflicting session record";
    return [];
  }
  state.sessionId = text(event["id"]);
  state.sessionHeader = header;
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
