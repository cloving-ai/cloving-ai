import { join } from "node:path";
import type { Fields, Reply } from "../src/protocol.ts";
import type { Connection } from "../src/service/event-handler.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { request, startMcp } from "./mcp-fixture.ts";
import { eventually, fields } from "./service-fixture.ts";

export interface ChannelState {
  readonly runs: Map<string, Fields>;
  readonly decisions: Fields[];
  readonly stops: Fields[];
  readonly events: Fields[];
  readonly requests: Fields[];
  readonly failing: Set<string>;
}

function answer(result: Fields): Promise<Reply> {
  return Promise.resolve({ kind: "result", result });
}

function latestOf(state: ChannelState, runId: string): number {
  return Number(
    state.events.findLast((event) => event["runId"] === runId)?.["sequence"] ??
      0,
  );
}

function failure(code: string, detail: string): Promise<Reply> {
  return Promise.resolve({ kind: "error", error: { code, detail } });
}

function statusReply(state: ChannelState, parameters: Fields): Promise<Reply> {
  const runId = parameters["runId"];
  if (typeof runId !== "string")
    return answer({
      runs: [...state.runs.entries()].map(([listed, run]) => ({
        runId: listed,
        workflowId: run["workflowId"],
        state: run["state"],
        latestSequence: latestOf(state, listed),
      })),
      next: null,
    });
  if (state.failing.has(runId))
    return failure("authority-unavailable", "unavailable");
  const run = state.runs.get(runId);
  if (run === undefined)
    return failure("unknown-run", `No run has the ID ${runId}.`);
  return answer({ run: { ...run, latestSequence: latestOf(state, runId) } });
}

async function followed(
  state: ChannelState,
  stream: {
    readonly after: number;
    readonly connection: Connection;
    readonly changed: () => Promise<void>;
  },
): Promise<undefined> {
  let after = stream.after;
  while (!stream.connection.closed()) {
    const page = state.events.filter(
      (event) => Number(event["sequence"]) > after,
    );
    if (!(await stream.connection.send(page))) return undefined;
    after = Number(page.at(-1)?.["sequence"] ?? after);
    if (page.length === 0) await stream.changed();
  }
  return undefined;
}

function served(state: ChannelState, changed: () => Promise<void>): Handle {
  return (request, connection) => {
    const { operation, parameters } = request;
    state.requests.push({ operation, ...parameters });
    if (operation === "status") return statusReply(state, parameters);
    if (operation === "questions")
      return answer({
        decisions: state.decisions.filter(
          (decision) =>
            parameters["runId"] === undefined ||
            decision["runId"] === parameters["runId"],
        ),
      });
    if (operation === "schedule")
      return answer({ stops: state.stops, schedules: [] });
    if (parameters["follow"] === true)
      return followed(state, {
        after: Number(parameters["after"]),
        connection,
        changed,
      });
    return answer({ events: [], latestSequence: state.events.length });
  };
}

export async function channelService(runtime: string) {
  const state: ChannelState = {
    runs: new Map(),
    decisions: [],
    stops: [],
    events: [],
    requests: [],
    failing: new Set(),
  };
  let wake = Promise.withResolvers<undefined>();
  const listener = await listen({
    path: join(runtime, "control.sock"),
    limits: { idleMilliseconds: 5000 },
    handle: served(state, async () => {
      await Promise.race([
        wake.promise,
        new Promise((settle) => setTimeout(settle, 100)),
      ]);
    }),
  });
  const recorded = (runId: string, type: string): void => {
    state.events.push({
      schemaVersion: 1,
      sequence: state.events.length + 1,
      type,
      runId,
      commandId: null,
      recordedAt: "2026-11-10T00:00:00.000Z",
      payload: {},
    });
    const woken = wake;
    wake = Promise.withResolvers<undefined>();
    woken.resolve(undefined);
  };
  return {
    state,
    close: () => listener.close(),
    run: (run: Fields, type: string): void => {
      const runId = String(run["runId"]);
      state.runs.set(runId, { ...state.runs.get(runId), ...run });
      recorded(runId, type);
    },
    decide: (decision: Fields): void => {
      state.decisions.push(decision);
      recorded(String(decision["runId"]), "gate.opened");
    },
    stop: (stop: Fields, runId: string): void => {
      state.stops.push(stop);
      recorded(runId, "run.failed");
    },
  };
}

export type ChannelService = Awaited<ReturnType<typeof channelService>>;

export function channelMessages(
  messages: readonly Fields[],
): readonly Fields[] {
  return messages
    .filter((message) => message["method"] === "notifications/claude/channel")
    .map((message) => fields(message["params"]));
}

export async function channelServer(input: {
  readonly runtime: string;
  readonly directory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const server = startMcp({
    runtime: input.runtime,
    directory: input.directory ?? input.runtime,
    argumentsList: ["--channel"],
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
  });
  server.send(
    request({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    }),
  );
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await eventually(() => (server.messages.length > 0 ? true : undefined));
  return {
    ...server,
    channel: () => channelMessages(server.messages),
    sent: (count: number) =>
      eventually(() => {
        const found = channelMessages(server.messages);
        return found.length >= count ? found : undefined;
      }),
  };
}

export const approvalRun = {
  runId: "run-60c4e1f2a9b8c7d6e5f4a3b2c1d0e9f8",
  workflowId: "develop",
  state: "waiting_gate",
  title: "#701 CLV-336: Answer decisions in the browser",
  ticketId: "CLV-336",
  continuedBy: null,
};

export const approval = {
  decisionId: `${approvalRun.runId}/review-1`,
  runId: approvalRun.runId,
  type: "approval",
  prompt: "Approve the change of the watch page?\nThe diff has 40 lines.",
  allowed: ["approve", "deny"],
};
