import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { socketAddress } from "../src/broker/socket-address.ts";
import {
  parseRequest,
  replyLine,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../src/protocol.ts";
import { withHarness, type Harness } from "./service-fixture.ts";

export async function withReportSource<Result>(
  reply: (request: ServiceRequest) => Reply,
  inspect: (
    harness: Harness,
    requests: readonly ServiceRequest[],
  ) => Promise<Result>,
): Promise<Result> {
  return withHarness(async (harness) => {
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    assert.equal(address.kind, "address");
    const requests: ServiceRequest[] = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (!input.endsWith("\n")) return;
        const parsed = parseRequest(input);
        assert.equal(parsed.kind, "request");
        requests.push(parsed.request);
        socket.end(replyLine(reply(parsed.request)));
      });
    });
    await new Promise<void>((resolve) => server.listen(address.path, resolve));
    try {
      return await inspect(harness, requests);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
}

export function reportReply(
  events: readonly Fields[],
  runs: readonly Fields[] = [],
): (request: ServiceRequest) => Reply {
  return (request) => {
    if (request.operation === "events") {
      const after = Number(request.parameters["after"]);
      return {
        kind: "result",
        result: {
          latestSequence: Number(events.at(-1)?.["sequence"] ?? 0),
          events: events
            .filter((event) => Number(event["sequence"]) > after)
            .slice(0, 1000),
        },
      };
    }
    const runId = request.parameters["runId"];
    return {
      kind: "result",
      result: { run: runs.find((run) => run["runId"] === runId) },
    };
  };
}

export function endedEvent(
  runId: string,
  input: {
    readonly outcome: string;
    readonly at: string;
    readonly sequence: number;
  },
): Fields {
  return {
    sequence: input.sequence,
    runId,
    type: "run.completed",
    recordedAt: input.at,
    payload: input.outcome === "completed" ? {} : { outcome: input.outcome },
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

export async function configuredReportCli(
  harness: Harness,
  args: readonly string[],
) {
  const execute = promisify(execFile);
  await execute("git", ["init", "--quiet", harness.projectDirectory]);
  await execute(
    "git",
    ["config", "remote.origin.url", "git@github.example:fixture/demo.git"],
    { cwd: harness.projectDirectory },
  );
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const program = `const endpoint = process.argv.find((part) => part.startsWith("repos/"));
if (endpoint === "repos/fixture/demo") console.log(JSON.stringify({full_name:"fixture/demo",created_at:"2026-01-01T00:00:00Z"}));
else if (endpoint.includes("/timeline?")) console.log(JSON.stringify([{event:"labeled",label:{name:"cloving: ready"},created_at:${JSON.stringify(new Date(Date.parse(at) - 30 * 3_600_000).toISOString())}}]));
else if (endpoint.includes("/issues?")) console.log(JSON.stringify([{number:7,html_url:"https://github.example/fixture/demo/issues/7",closed_at:${JSON.stringify(at)},state:"closed",state_reason:"completed"}]));
else console.log(JSON.stringify([{number:8,html_url:"https://github.example/fixture/demo/pull/8",updated_at:${JSON.stringify(at)},merged_at:${JSON.stringify(at)}}]));`;
  return execute(process.execPath, [resolve("src/cli.ts"), "report", ...args], {
    cwd: harness.projectDirectory,
    env: {
      ...process.env,
      CLOVING_RUNTIME_DIR: harness.runtimeDirectory,
      CLOVING_WATCH_REPOSITORY: harness.projectDirectory,
      CLOVING_GH_COMMAND: JSON.stringify([process.execPath, "-e", program]),
    },
  });
}

export function snapshotReportReply(
  at: string,
): (request: ServiceRequest) => Reply {
  const events = Array.from({ length: 1000 }, (_, index) => ({
    sequence: index + 1,
    type: "run.created",
    recordedAt: at,
  }));
  const ended = [
    endedEvent("included", { outcome: "completed", at: at, sequence: 1001 }),
    endedEvent("later", { outcome: "completed", at: at, sequence: 1002 }),
  ];
  return (request) => {
    if (request.operation !== "events")
      return {
        kind: "error",
        error: { code: "unknown-run", detail: "No price" },
      };
    const after = Number(request.parameters["after"]);
    return {
      kind: "result",
      result: {
        latestSequence: after === 0 ? 1001 : 1002,
        events: after === 0 ? events : ended,
      },
    };
  };
}

export function effectEvents(
  runId: string,
  input: {
    readonly method: string;
    readonly sequence: number;
    readonly at: number;
    readonly minutes?: number;
    readonly result?: Fields;
    readonly payload?: Fields;
    readonly outcome?: string;
  },
): Fields[] {
  const operationId = `${runId}-${String(input.sequence)}`;
  return [
    {
      runId,
      sequence: input.sequence,
      at: input.at,
      type: "effect.requested",
      recordedAt: new Date(input.at).toISOString(),
      payload: {
        operationId,
        capability: input.method === "run-turn" ? "claude" : "github",
        method: input.method,
        payload: JSON.stringify(input.payload ?? {}),
      },
    },
    {
      runId,
      sequence: input.sequence + 1,
      at: input.at + (input.minutes ?? 1) * 60_000,
      type: "effect.reported",
      recordedAt: new Date(
        input.at + (input.minutes ?? 1) * 60_000,
      ).toISOString(),
      payload: {
        operationId,
        outcome: input.outcome ?? "completed",
        result: JSON.stringify(input.result ?? {}),
      },
    },
  ];
}

export function fixRoundEvents(at: number): Fields[] {
  let sequence = 0;
  return [0, 2, 1, 9].flatMap((rounds, index) => {
    const runId = `fix-${String(index)}`;
    const methods = [
      "run-turn",
      "open-pr",
      ...Array.from({ length: rounds }, () => "run-turn"),
      "merge",
    ];
    return methods.flatMap((method) => {
      sequence += 2;
      return effectEvents(runId, {
        method,
        sequence,
        at,
        payload: { number: index + 10 },
        result:
          method === "merge" ? { merged: index !== 3, number: index + 10 } : {},
      });
    });
  });
}

export function phaseEvents(recent: number): Fields[] {
  return [
    ...effectEvents("old", {
      method: "run-turn",
      sequence: 1,
      at: recent - 2 * 86_400_000,
      minutes: 100,
    }),
    ...effectEvents("worker-a", {
      method: "run-turn",
      sequence: 3,
      at: recent,
      minutes: 2,
    }),
    ...effectEvents("worker-b", {
      method: "run-turn",
      sequence: 5,
      at: recent,
      minutes: 4,
      outcome: "failed",
    }),
    ...effectEvents("review", {
      method: "wait-review",
      sequence: 7,
      at: recent,
      minutes: 8,
    }),
    ...effectEvents("merge", {
      method: "merge",
      sequence: 9,
      at: recent,
      minutes: 12,
    }),
    ...effectEvents("cross-window", {
      method: "wait-review",
      sequence: 11,
      at: recent - 86_400_000,
      minutes: 90,
    }),
    ...effectEvents("future", {
      method: "merge",
      sequence: 13,
      at: recent,
      minutes: 120,
    }),
  ];
}
