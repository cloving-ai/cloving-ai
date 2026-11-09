import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { expectedLoops, loopReplies } from "./watch-loops-fixture.ts";
import { watchData, withWatchService } from "./watch-service-fixture.ts";

function scheduleReply(request: ServiceRequest): Reply {
  const { action, workflowId, commandId } = request.parameters;
  if (action === "run" && commandId === "busy")
    return {
      kind: "error",
      error: { code: "run-active", detail: "The workflow has an active run." },
    };
  if (action === "run")
    return {
      kind: "result",
      result: { kind: "run-admitted", runId: "run-loop", replayed: false },
    };
  return {
    kind: "result",
    result: {
      kind: "schedule",
      schedule: { workflowId, state: action === "pause" ? "paused" : "active" },
    },
  };
}

function answered(requests: ServiceRequest[]) {
  const replies = loopReplies();
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "schedule") return replies.answer(request);
    requests.push(request);
    return scheduleReply(request);
  };
}

const pause = { workflowId: "review-day", action: "pause", commandId: "c-1" };

await test("CLV-328 the switch and Run now of a loop row send the schedule commands with the page token and give the reply of the service", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const headers = actionHeaders(watch, await pageToken(watch));
    const post = async (body: unknown) => {
      const reply = await postCard(watch, {
        path: "actions/schedule",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(reply.status, 200);
      const value: unknown = JSON.parse(reply.body);
      return value;
    };
    assert.deepEqual(await post(pause), {
      kind: "schedule",
      schedule: { workflowId: "review-day", state: "paused" },
    });
    await post({ ...pause, action: "resume", commandId: "c-2" });
    assert.deepEqual(
      await post({ ...pause, action: "run", commandId: "c-3" }),
      { kind: "run-admitted", runId: "run-loop", replayed: false },
    );
    assert.deepEqual(
      await post({ ...pause, action: "run", commandId: "busy" }),
      {
        error: {
          code: "run-active",
          detail: "The workflow has an active run.",
        },
      },
    );
    assert.deepEqual(
      requests.map((request) => request.parameters),
      [
        { action: "pause", workflowId: "review-day" },
        { action: "resume", workflowId: "review-day" },
        { action: "run", workflowId: "review-day", commandId: "c-3" },
        { action: "run", workflowId: "review-day", commandId: "busy" },
      ],
    );
  });
});

await test("CLV-328 the schedule endpoint refuses a forged token, a foreign Origin, an invalid body and more than 16 KiB", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const refused = async (
      body: string,
      headers: Record<string, string> = good,
    ) => {
      const reply = await postCard(watch, {
        path: "actions/schedule",
        headers,
        body,
      });
      assert.equal(reply.status, 403, body.slice(0, 80));
    };
    await refused(JSON.stringify(pause), {
      ...good,
      "x-cloving-token": "b".repeat(64),
    });
    await refused(JSON.stringify(pause), {
      ...good,
      origin: "http://example.com",
    });
    for (const body of [
      { ...pause, action: "stop" },
      { workflowId: "review-day", action: "pause" },
      { ...pause, workflowId: "bad id" },
      { ...pause, commandId: "bad id" },
      { ...pause, extra: true },
      { ...pause, pad: "x".repeat(17000) },
      [],
    ])
      await refused(JSON.stringify(body));
    await refused("{");
    assert.equal(requests.length, 0);
  });
});

await test("CLV-328 with watch actions off, the Loops rows stay, the page has no token and the schedule endpoint is an unknown path", () =>
  withWatchService(
    {
      answer: loopReplies().answer,
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const page = await (await fetch(watch.address)).text();
      assert.match(page, /const actionToken = null;/);
      assert.deepEqual(
        (await watchData(watch.address))["loops"],
        expectedLoops,
      );
      const reply = await postCard(watch, {
        path: "actions/schedule",
        headers: actionHeaders(watch, "wrong"),
        body: JSON.stringify(pause),
      });
      assert.equal(reply.status, 404);
      assert.equal(reply.body, "not found");
    },
  ));
