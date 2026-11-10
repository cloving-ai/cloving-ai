import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import type { Watching } from "./watch-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const binding = {
  reference: "run-a/review-1",
  expectedRevision: 3,
  generation: 2,
  subjectDigest: `sha256:${"a".repeat(64)}`,
};

const recorded = {
  schemaVersion: 1,
  kind: "decision-recorded",
  decisionId: "run-a/review-1",
  runId: "run-a",
  decision: "approved",
  actor: null,
  commandId: "page-1",
  replayed: false,
  receipt: { kind: "accepted", sequence: 9 },
  run: { state: "running", revision: 4 },
  continuation: "admitted",
};

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "decision")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    return { kind: "result", result: recorded };
  };
}

async function approvedThroughPage(
  watch: Watching,
  requests: ServiceRequest[],
): Promise<void> {
  const reply = await postCard(watch, {
    path: "actions/decision",
    headers: actionHeaders(watch, await pageToken(watch)),
    body: JSON.stringify({
      command: "approve",
      ...binding,
      commandId: "page-1",
    }),
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), recorded);
  assert.deepEqual(requests, [
    {
      operation: "decision",
      parameters: { command: "approve", ...binding, commandId: "page-1" },
    },
  ]);
}

async function refusedThroughPage(
  watch: Watching,
  requests: ServiceRequest[],
): Promise<void> {
  const headers = actionHeaders(watch, await pageToken(watch));
  const sent = async (body: unknown) =>
    (
      await postCard(watch, {
        path: "actions/decision",
        headers,
        body: JSON.stringify(body),
      })
    ).status;
  const base = { ...binding, commandId: "page-2" };
  const refused = [
    { command: "answer", ...base, text: "   " },
    { command: "answer", ...base, text: "é".repeat(4001) },
    { command: "answer", ...base },
    { command: "approve", ...base, text: "yes" },
    { command: "run", ...base },
    { command: "approve", ...binding },
    { command: "deny", ...base, subjectDigest: "sha256:abc" },
  ];
  for (const body of refused) assert.equal(await sent(body), 403);
  const wrongToken = await postCard(watch, {
    path: "actions/decision",
    headers: actionHeaders(watch, "b".repeat(64)),
    body: JSON.stringify({ command: "approve", ...base }),
  });
  assert.equal(wrongToken.status, 403);
  assert.deepEqual(requests, []);
  assert.equal(
    await sent({ command: "answer", ...base, text: ` ${"é".repeat(4000)} ` }),
    200,
  );
  assert.equal(await sent({ command: "deny", ...base }), 200);
  assert.deepEqual(
    requests.map(({ parameters }) => parameters["command"]),
    ["answer", "deny"],
  );
}

await test("CLV-336 a POST to actions/decision with the page token and an approve reply sends one decision request with the fields of the decision and gives the reply of the service, and the endpoint refuses a blank or long answer, a text on an approval, an unknown reply, a wrong token and a body without the decision fields with no request", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    await approvedThroughPage(watch, requests);
    requests.splice(0);
    await refusedThroughPage(watch, requests);
  });
});

await test("CLV-336 with CLOVING_WATCH_ACTIONS=off the decision endpoint answers 404", () =>
  withWatchService(
    {
      answer: answered([]),
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const reply = await postCard(watch, {
        path: "actions/decision",
        headers: actionHeaders(watch, "wrong"),
        body: JSON.stringify({
          command: "approve",
          ...binding,
          commandId: "a",
        }),
      });
      assert.equal(reply.status, 404);
    },
  ));
