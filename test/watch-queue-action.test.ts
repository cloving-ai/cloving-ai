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

await test("CLV-361 watch lane actions forward the workflow, expected count and retained command ID", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    (request) => {
      if (["queue-command", "queue-lanes"].includes(request.operation))
        requests.push(request);
      return { kind: "result", result: {} };
    },
    async (watch) => {
      const headers = actionHeaders(watch, await pageToken(watch));
      for (const command of ["lanes", "drain", "resume"]) {
        const body = {
          command,
          workflowId: "develop",
          commandId: "same-" + command,
          ...(command === "lanes" ? { lanes: 3, expectedLanes: 2 } : {}),
        };
        for (let retry = 0; retry < 2; retry++) {
          const reply = await postCard(watch, {
            path: "actions/queue",
            headers,
            body: JSON.stringify(body),
          });
          assert.equal(reply.status, 200);
        }
      }
      assert.equal(requests.length, 6);
      assert.deepEqual(requests[0], requests[1]);
      assert.deepEqual(requests[0], {
        operation: "queue-lanes",
        parameters: {
          workflowId: "develop",
          commandId: "same-lanes",
          lanes: 3,
          expectedLanes: 2,
        },
      });
      assert.equal(requests[2]?.parameters["commandId"], "same-drain");
      assert.equal(requests[4]?.parameters["commandId"], "same-resume");
      assert.equal(
        (
          await postCard(watch, {
            path: "actions/queue",
            headers: { ...headers, "x-cloving-token": "" },
            body: JSON.stringify({
              command: "lanes",
              workflowId: "develop",
              lanes: 3,
              expectedLanes: 2,
              commandId: "no-token",
            }),
          })
        ).status,
        403,
      );
    },
  );
});

await test("CLV-361 watch actions off remove the queue endpoint and expose no page token", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    {
      answer: answered(requests),
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const page = await (await fetch(watch.address)).text();
      assert.match(page, /const actionToken = null;/);
      const reply = await postCard(watch, {
        path: "actions/queue",
        headers: actionHeaders(watch, "a".repeat(64)),
        body: JSON.stringify({
          command: "lanes",
          workflowId: "develop",
          lanes: 3,
          expectedLanes: 2,
          commandId: "off",
        }),
      });
      assert.equal(reply.status, 404);
      assert.equal(requests.length, 0);
    },
  );
});

await test("CLV-377 malformed lane actions cannot reach the service", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    (request) => {
      if (request.operation === "queue-lanes") requests.push(request);
      return { kind: "result", result: {} };
    },
    async (watch) => {
      const headers = actionHeaders(watch, await pageToken(watch));
      const valid = {
        command: "lanes",
        workflowId: "develop",
        lanes: 3,
        expectedLanes: 2,
        commandId: "lane-edit",
      };
      for (const patch of [
        { lanes: 0 },
        { lanes: 17 },
        { lanes: 1.5 },
        { lanes: "3" },
        { expectedLanes: 0 },
        { commandId: null },
        { workflowId: "../develop" },
        { path: "config.json" },
        { field: "harness.command" },
      ]) {
        const response = await postCard(watch, {
          path: "actions/queue",
          headers,
          body: JSON.stringify({ ...valid, ...patch }),
        });
        assert.equal(response.status, 403, JSON.stringify(patch));
      }
      assert.equal(requests.length, 0);
    },
  );
});

await test("CLV-377 typed global and workflow settings use the existing watch authentication boundary", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    (request) => {
      if (request.operation === "queue-setting") requests.push(request);
      return { kind: "result", result: {} };
    },
    async (watch) => {
      const headers = actionHeaders(watch, await pageToken(watch));
      const valid = {
        commandId: "global-edit",
        scope: "global",
        field: "lanes",
        action: "set",
        value: 3,
        expectedValue: 16,
      };
      const post = (body: unknown, given = headers) =>
        postCard(watch, {
          path: "actions/queue-settings",
          headers: given,
          body: JSON.stringify(body),
        });
      assert.equal(
        (await post(valid, { ...headers, "x-cloving-token": "" })).status,
        403,
      );
      assert.equal(
        (await post(valid, { ...headers, origin: "https://other.example" }))
          .status,
        403,
      );
      for (const patch of [
        { path: "config.json" },
        { field: "harness.command" },
        { value: 0 },
        { workflowId: "alpha" },
      ])
        assert.equal((await post({ ...valid, ...patch })).status, 403);
      assert.equal(requests.length, 0);
      assert.equal((await post(valid)).status, 200);
      assert.deepEqual(requests, [
        { operation: "queue-setting", parameters: valid },
      ]);
    },
  );
});
