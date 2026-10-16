import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { socketAddress } from "../src/broker/socket-address.ts";
import {
  parseRequest,
  replyLine,
  type Fields,
  type ServiceRequest,
  type Reply,
} from "../src/protocol.ts";
import { withHarness } from "./service-fixture.ts";
import { watching, type Watching } from "./watch-fixture.ts";

export async function withWatchService(
  answer: (request: ServiceRequest) => Reply,
  body: (watch: Watching) => Promise<void>,
): Promise<void> {
  await withHarness(async (harness) => {
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    assert.equal(address.kind, "address");
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (!buffered.includes("\n")) return;
        const parsed = parseRequest(buffered.trim());
        assert.equal(parsed.kind, "request");
        socket.end(replyLine(answer(parsed.request)));
      });
    });
    await new Promise<void>((ready) => server.listen(address.path, ready));
    try {
      const watch = await watching(harness.runtimeDirectory);
      try {
        await body(watch);
      } finally {
        assert.equal(await watch.stop(), 0);
      }
    } finally {
      await new Promise<void>((closed) =>
        server.close(() => {
          closed();
        }),
      );
    }
  });
}

export async function watchData(address: string): Promise<Fields> {
  const response = await fetch(`${address}data.json`);
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
}

export function watchReplies(options: {
  readonly runs: readonly Fields[];
  readonly events?: readonly Fields[];
  readonly eventsByRun?: Readonly<Record<string, readonly Fields[]>>;
  readonly workflows?: readonly string[];
}): {
  readonly requests: ServiceRequest[];
  readonly answer: (request: ServiceRequest) => Reply;
} {
  const requests: ServiceRequest[] = [];
  const eventsByRun = options.eventsByRun ?? {};
  const defaultEvents = options.events ?? [];
  const answer = (request: ServiceRequest): Reply => {
    requests.push(request);
    const runId = request.parameters["runId"];
    if (request.operation === "status" && runId !== undefined) {
      const run = options.runs.find((item) => item["runId"] === runId);
      return run === undefined
        ? {
            kind: "error",
            error: { code: "unknown-run", detail: "Unknown run." },
          }
        : { kind: "result", result: { run } };
    }
    if (request.operation === "status") {
      const cursor = request.parameters["after"];
      const after = typeof cursor === "string" ? cursor : "";
      const remaining = options.runs.filter(
        (run) => String(run["runId"]) > after,
      );
      const runs = remaining.slice(0, 50);
      return {
        kind: "result",
        result: {
          workflows: options.workflows ?? [
            "develop-issue",
            "develop-ticket",
            "develop-prompt",
          ],
          runs,
          next: remaining.length > 50 ? runs.at(-1)?.["runId"] : null,
        },
      };
    }
    const events = (eventsByRun[String(runId)] ?? defaultEvents)
      .filter(
        (event) =>
          Number(event["sequence"]) > Number(request.parameters["after"]),
      )
      .slice(0, 1000);
    return {
      kind: "result",
      result: { events, latestSequence: 2500, decisions: [] },
    };
  };
  return { requests, answer };
}

export function interruptedReplies(options: {
  readonly operation: string;
  readonly after?: number | string;
  readonly runs: readonly Fields[];
  readonly events?: readonly Fields[];
}): ReturnType<typeof watchReplies> {
  const replies = watchReplies(options);
  let remaining = 1;
  const answer = (request: ServiceRequest): Reply => {
    const result = replies.answer(request);
    if (
      request.operation === options.operation &&
      request.parameters["after"] === options.after &&
      remaining > 0
    ) {
      remaining -= 1;
      return {
        kind: "error",
        error: { code: "read-failed", detail: "Read interrupted." },
      };
    }
    return result;
  };
  return { ...replies, answer };
}

export function repeatedPage(request: ServiceRequest): Reply {
  if (request.operation === "status")
    return {
      kind: "result",
      result: { runs: [], workflows: [], next: "same-cursor" },
    };
  return { kind: "result", result: {} };
}

export function repeatedEvents(request: ServiceRequest): Reply {
  if (request.operation === "events")
    return {
      kind: "result",
      result: {
        events: Array.from({ length: 1000 }, () => ({ sequence: 1 })),
      },
    };
  return watchReplies({ runs: [longRun] }).answer(request);
}

export const longRun = {
  runId: "long",
  workflowId: "develop-issue",
  state: "running",
  latestSequence: 1001,
};
export const longEvents = Array.from({ length: 1001 }, (_, index) => ({
  sequence: index + 1,
  recordedAt: "2026-10-14T12:00:00Z",
  type: "run.started",
  payload: {},
}));
