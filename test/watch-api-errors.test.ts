import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import { contractBody } from "./watch-api-contract.ts";
import { watchReplies, withWatchService } from "./watch-service-fixture.ts";

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const runStates = [
  "queued",
  "running",
  "waiting_gate",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

const invalidQueries = [
  ["/runs", "limit=0", "limit"],
  ["/runs", "limit=201", "limit"],
  ["/runs", "limit=abc", "limit"],
  ["/runs", "limit=1.5", "limit"],
  ["/runs", "limit=-1", "limit"],
  ["/runs", "limit=", "limit"],
  ["/runs", "limit=2&limit=3", "limit"],
  ["/runs", "state=unknown", "state"],
  ["/runs", "state=", "state"],
  ["/runs", "workflowId=", "workflowId"],
  ["/runs", "status=running", "status"],
  ["/runs", "cursor=not-a-cursor!", "cursor"],
  ["/runs", "cursor=", "cursor"],
  ["/runs", "cursor=abc", "cursor"],
  ["/runs", `cursor=${encoded({})}`, "cursor"],
  ["/runs", `cursor=${encoded([1, "run-a"])}`, "cursor"],
  ["/runs", `cursor=${encoded([{}, "run-a"])}`, "cursor"],
  ["/runs", `cursor=${encoded([null, "run-a"])}=`, "cursor"],
  ["/runs", `cursor=${encoded([null, 1])}`, "cursor"],
  ["/runs", `cursor=${encoded([null, "run-a", 1])}`, "cursor"],
  ["/workflows", "limit=2", "limit"],
  ["/service", "fresh=1", "fresh"],
  ["/openapi.json", "format=yaml", "format"],
  ["/", "version=2", "version"],
] as const;

await test("CLV-254 an unknown, repeated or invalid query parameter gives a 400 problem with the code invalid-query", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    for (const [path, query, name] of invalidQueries) {
      const response = await fetch(`${watch.address}api/v1${path}?${query}`);
      assert.equal(response.status, 400, `${path}?${query}`);
      assert.deepEqual(
        await contractBody(watchApiDocument, { response, path }),
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          detail: `The query parameter ${name} is unknown, repeated or has an invalid value.`,
          code: "invalid-query",
        },
        `${path}?${query}`,
      );
    }
  });
});

await test("CLV-254 the limits 1 and 200, each run state and a cursor of the API are valid query values", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    const valid = [
      "limit=1",
      "limit=200",
      `cursor=${encoded([null, "run-a"])}`,
      `cursor=${encoded(["2026-11-03T10:00:00.000Z", "run-a"])}`,
      ...runStates.map((state) => `state=${state}`),
    ];
    for (const query of valid) {
      const response = await fetch(`${watch.address}api/v1/runs?${query}`);
      assert.equal(response.status, 200, query);
      assert.deepEqual(
        await contractBody(watchApiDocument, { response, path: "/runs" }),
        { runs: [], nextCursor: null },
      );
    }
  });
});
