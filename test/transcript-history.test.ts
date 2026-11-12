import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import { contractBody } from "./watch-api-contract.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { withWatchService, watchReplies } from "./watch-service-fixture.ts";

function historyService(asked: Fields[]) {
  const service = watchReplies({ runs: [] });
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "transcript") return service.answer(request);
    asked.push(request.parameters);
    return {
      kind: "result",
      result: { entries: [], nextAfter: 0, open: true, hasEarlier: false },
    };
  };
}

await test("CLV-364 the transcript API forwards before and preserves earlier-page metadata", async () => {
  const asked: Fields[] = [];
  await withWatchService(historyService(asked), async (watch) => {
    const path = "api/v1/runs/run-a/turns/turn/transcript";
    const response = await fetch(`${watch.address}${path}?before=400`);
    assert.equal(response.status, 200);
    assert.deepEqual(asked, [
      { runId: "run-a", operationId: "turn", after: 0, before: 400 },
    ]);
    assert.deepEqual(
      await contractBody(watchApiDocument, {
        response,
        path: "/runs/{runId}/turns/{operationId}/transcript",
      }),
      { entries: [], nextAfter: 0, open: true, hasEarlier: false },
    );
    for (const before of ["-1", "0", "x"]) {
      const invalid = await fetch(`${watch.address}${path}?before=${before}`);
      assert.equal(invalid.status, 400);
      await invalid.body?.cancel();
    }
  });
});
