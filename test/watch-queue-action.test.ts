import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "queue-command")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    if (request.parameters["command"] === "resume" && requests.length > 2)
      return {
        kind: "error",
        error: {
          code: "queue-unavailable",
          detail: "The service has no queue workflow.",
        },
      };
    return {
      kind: "result",
      result: {
        command: request.parameters["command"],
        replayed: false,
        queue: { state: "draining" },
      },
    };
  };
}

await test("CLV-286 the queue control of the page drains and resumes the queue only with the page token", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const queue = (body: string, headers = good) =>
      postCard(watch, { path: "actions/queue", headers, body });
    const forged = { ...good, "x-cloving-token": "b".repeat(64) };
    assert.equal((await queue('{"command":"drain"}', forged)).status, 403);
    for (const body of ['{"command":"stop"}', "[]", "{"])
      assert.equal((await queue(body)).status, 403, body);
    assert.equal(requests.length, 0);
    const replies = [];
    for (const command of ["drain", "resume", "resume"]) {
      const reply = await queue(JSON.stringify({ command }));
      assert.equal(reply.status, 200);
      replies.push(JSON.parse(reply.body));
    }
    assert.deepEqual(replies, [
      { command: "drain", replayed: false, queue: { state: "draining" } },
      { command: "resume", replayed: false, queue: { state: "draining" } },
      {
        error: {
          code: "queue-unavailable",
          detail: "The service has no queue workflow.",
        },
      },
    ]);
    assert.deepEqual(
      requests.map((request) => request.parameters["command"]),
      ["drain", "resume", "resume"],
    );
    const identifiers = requests.map((request) =>
      String(request.parameters["commandId"]),
    );
    for (const commandId of identifiers)
      assert.match(commandId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(new Set(identifiers).size, 3);
  });
});

await test("CLV-360 watch commands target the displayed queue workflow", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const headers = actionHeaders(watch, await pageToken(watch));
    for (const command of ["drain", "resume"]) {
      const reply = await postCard(watch, {
        path: "actions/queue",
        headers,
        body: JSON.stringify({ command, workflowId: "triage-issue" }),
      });
      assert.equal(reply.status, 200);
    }
    assert.deepEqual(
      requests.map((request) => request.parameters["workflowId"]),
      ["triage-issue", "triage-issue"],
    );
  });
});
